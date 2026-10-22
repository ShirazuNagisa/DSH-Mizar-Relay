/**
 * Sign in with GitHub: the OAuth half of the browser round-trip.
 *
 * GitHub login cannot work the way Sign in with Apple does -- the app never
 * sees the user's GitHub password, so there is no identity token to hand the
 * relay. Instead the phone opens a browser at the authorize URL, GitHub calls
 * the relay back with a one-time code, and the relay trades that code for the
 * identity. This module owns the three GitHub calls (authorize URL, code
 * exchange, profile read) and the two server-rendered pages the browser lands
 * on; the account resolution and the session issuance stay in the store and
 * the API, which is where every other login path lives.
 *
 * The error vocabulary is the one the deployment manual documents:
 * `GITHUB_EXCHANGE_FAILED` (502) when GitHub refuses a code, and
 * `GITHUB_UNAVAILABLE` (503) when github.com cannot be reached at all -- the
 * second is the one a server behind a restrictive network actually hits.
 *
 * @module dsh-mizar-relay/accounts/github
 */
import { AccountError } from './types.js'
import type { GitHubIdentity } from './types.js'

/** How long one GitHub call may take. The browser is waiting on the other end. */
const FETCH_TIMEOUT_MS = 10_000

/** GitHub's API terms ask every client to identify itself. */
const USER_AGENT = 'dsh-mizar-relay'

/** The OAuth client half: build the authorize URL, exchange codes, read identities. */
export class GitHubOAuth {
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #callbackURL: string
  readonly #fetch: typeof fetch

  constructor(options: {
    readonly clientId: string
    readonly clientSecret: string
    readonly callbackURL: string
    readonly fetchImpl?: typeof fetch
  }) {
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.#callbackURL = options.callbackURL
    this.#fetch = options.fetchImpl ?? fetch
  }

  /** The redirect URI registered for this OAuth App. */
  get callbackURL(): string {
    return this.#callbackURL
  }

  /**
   * The URL the browser is sent to.
   *
   * The scope is deliberately narrow: `read:user` for the identity, `user:email`
   * so a verified address can link an existing account. No repo, no org -- the
   * relay never calls anything but the two profile endpoints.
   *
   * @param state - the one-time state this round-trip is bound to.
   * @returns the absolute authorize URL.
   */
  authorizeURL(state: string): string {
    // Built by hand rather than with URLSearchParams: the latter encodes the
    // scope's space as `+`, while the deployment manual (and GitHub's own
    // examples) pin `%20`. Both are accepted; matching the manual keeps the
    // authorize URL greppable from the docs.
    const query = [
      ['client_id', this.#clientId],
      ['redirect_uri', this.#callbackURL],
      ['scope', 'read:user user:email'],
      ['state', state],
    ]
      .map(([key, value]) => `${encodeURIComponent(key!)}=${encodeURIComponent(value!)}`)
      .join('&')
    return `https://github.com/login/oauth/authorize?${query}`
  }

  /**
   * Trade the callback's one-time code for an access token.
   *
   * @param code - the `code` query parameter GitHub appended to the callback.
   * @returns the access token.
   * @throws AccountError `GITHUB_EXCHANGE_FAILED` (502) when GitHub refuses the
   *   code -- expired, already used, or bound to another redirect -- and
   *   `GITHUB_UNAVAILABLE` (503) when github.com cannot be reached.
   */
  async exchange(code: string): Promise<string> {
    let response: Response
    try {
      response = await this.#fetchWithRetry('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
          code,
          redirect_uri: this.#callbackURL,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      throw unavailable(`could not reach GitHub's token endpoint: ${(error as Error).message}`)
    }
    if (!response.ok) {
      throw exchangeFailed(`GitHub's token endpoint answered ${response.status}`)
    }
    let body: { access_token?: unknown; error?: unknown; error_description?: unknown }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw exchangeFailed("GitHub's token endpoint answered no JSON")
    }
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      const detail =
        typeof body.error_description === 'string'
          ? body.error_description
          : typeof body.error === 'string'
            ? body.error
            : 'the answer carried no access token'
      throw exchangeFailed(`GitHub refused the code: ${detail}`)
    }
    return body.access_token
  }

  /**
   * One fetch with a small retry budget.
   *
   * github.com answers from mainland China intermittently: a request that
   * connects one second can time out the next, and the OAuth exchange is the
   * one call a person is waiting on. Three attempts with a short pause turn a
   * transient edge into a successful sign-in, while a refusal (4xx) is
   * returned immediately -- retrying a bad code would only burn the round-trip.
   *
   * @param url - the absolute URL.
   * @param init - the request, minus the timeout signal (each attempt gets a fresh one).
   * @returns the response, for the caller to interpret.
   * @throws the last network failure when every attempt failed.
   */
  async #fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
    let last: unknown = new Error('no attempt was made')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.#fetch(url, {
          ...init,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        // 5xx/429 are the upstream having a moment; retry them. A 4xx is an
        // answer (a bad code, a bad token) and is returned to the caller.
        if (response.status >= 500 || response.status === 429) {
          last = new Error(`GitHub answered ${response.status}`)
        } else {
          return response
        }
      } catch (error) {
        last = error
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
    throw last
  }

  /**
   * Read the identity behind an access token.
   *
   * The email travels in its own call because GitHub keeps it out of the
   * profile when the user chose to keep it private. Only a **verified** email
   * is carried -- an unverified address must never link or name an account,
   * because anyone can claim any address on GitHub.
   *
   * @param accessToken - the token from {@link exchange}.
   * @returns the verified identity.
   * @throws AccountError `GITHUB_EXCHANGE_FAILED` (502) when the profile is
   *   unusable, `GITHUB_UNAVAILABLE` (503) when GitHub cannot be reached.
   */
  async identity(accessToken: string): Promise<GitHubIdentity> {
    const profile = await this.#get('https://api.github.com/user', accessToken)
    const id = profile['id']
    const login = profile['login']
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw exchangeFailed('GitHub answered a profile without a usable id')
    }
    if (typeof login !== 'string' || login === '') {
      throw exchangeFailed('GitHub answered a profile without a login')
    }
    const chosen = await this.#verifiedEmail(accessToken)
    const avatar = profile['avatar_url']
    return {
      id: String(id),
      login,
      email: chosen?.email ?? null,
      emailVerified: chosen !== undefined,
      // Only an https URL: this value is stored and later handed to an image
      // loader, and GitHub's own field is always https anyway.
      avatarUrl: typeof avatar === 'string' && avatar.startsWith('https://') ? avatar : null,
    }
  }

  /** One authenticated GET against the API, decoded as a JSON object. */
  async #get(url: string, accessToken: string): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.#fetchWithRetry(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      throw unavailable(`could not reach ${new URL(url).host}: ${(error as Error).message}`)
    }
    if (response.status >= 500) {
      throw unavailable(`GitHub's API answered ${response.status}`)
    }
    if (!response.ok) {
      throw exchangeFailed(`GitHub's API answered ${response.status}`)
    }
    try {
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw exchangeFailed('GitHub answered a profile that is not an object')
      }
      return body as Record<string, unknown>
    } catch (error) {
      if (error instanceof AccountError) throw error
      throw exchangeFailed('GitHub answered no JSON')
    }
  }

  /** The primary verified email, else any verified email, else nothing. */
  async #verifiedEmail(accessToken: string): Promise<{ email: string; primary: boolean } | undefined> {
    let response: Response
    try {
      response = await this.#fetchWithRetry('https://api.github.com/user/emails', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      throw unavailable(`could not reach api.github.com: ${(error as Error).message}`)
    }
    if (!response.ok) {
      // A profile without the email scope grant still signs in: it just cannot
      // link an existing address, so it always creates its own account.
      return undefined
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return undefined
    }
    if (!Array.isArray(body)) return undefined
    const usable: Array<{ email: string; primary: boolean }> = []
    for (const entry of body) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as { email?: unknown; primary?: unknown; verified?: unknown }
      if (
        typeof record.email === 'string' &&
        record.email.includes('@') &&
        record.verified === true
      ) {
        usable.push({ email: record.email, primary: record.primary === true })
      }
    }
    return usable.find((entry) => entry.primary) ?? usable[0]
  }
}

/**
 * The page the browser lands on after a completed sign-in.
 *
 * The phone gets the handoff code two ways: the button deep-links into the app
 * with the `mizar` scheme the manifest registers, and the code itself is shown
 * in full for the case where the browser refuses the custom scheme. Nothing on
 * this page is secret -- the code is single-use, short-lived, and worthless
 * without the device that claims it.
 *
 * @param code - the handoff code, `MZ-XXXX-XXXX`.
 * @returns the HTML.
 */
export function githubDonePage(code: string): string {
  const safe = escape(code)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mizar · 登录代码</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9;
         font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif; color: #1c1e21; }
  main { text-align: center; padding: 48px 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 28px; color: #65676b; font-size: 14px; }
  code { display: block; font-size: 34px; letter-spacing: 2px; font-weight: 700;
         font-family: ui-monospace, Menlo, monospace; padding: 18px 24px; margin: 0 0 28px;
         background: #fff; border-radius: 14px; box-shadow: 0 1px 4px rgb(0 0 0 / 8%); }
  a { display: inline-block; padding: 12px 36px; border-radius: 999px; background: #0f62fe;
      color: #fff; text-decoration: none; font-size: 16px; font-weight: 600; }
  button { display: inline-block; padding: 11px 28px; border-radius: 999px; border: 1px solid #d0d3d9;
           background: #fff; color: #1c1e21; font-size: 16px; font-weight: 600; cursor: pointer; }
  .actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  small { display: block; margin-top: 24px; color: #8a8d91; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>GitHub 登录成功</h1>
  <p>回到 Mizar 即自动完成登录；若没有跳转，在账户页输入此代码。</p>
  <code>${safe}</code>
  <div class="actions">
    <a href="mizar://github/login?code=${safe}">Open Mizar</a>
    <button id="copy" type="button">复制代码</button>
  </div>
  <small>代码 10 分钟内有效，只能使用一次。</small>
  <script>
    (() => {
      const button = document.getElementById('copy')
      if (button === null) return
      button.addEventListener('click', async () => {
        const code = document.querySelector('code').textContent
        try {
          await navigator.clipboard.writeText(code)
        } catch {
          const area = document.createElement('textarea')
          area.value = code
          area.setAttribute('readonly', '')
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          area.remove()
        }
        button.textContent = '已复制'
        setTimeout(() => { button.textContent = '复制代码' }, 1600)
      })
    })()
  </script>
</main>
</body>
</html>`
}

/**
 * The page for a completed **link**: the operator was already signed in, so
 * there is no handoff code -- the app refreshes its account page instead.
 *
 * @returns the HTML.
 */
export function githubBoundPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mizar · 绑定成功</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9;
         font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif; color: #1c1e21; }
  main { text-align: center; padding: 48px 28px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  p { margin: 0; color: #65676b; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>GitHub 账号已绑定</h1>
  <p>回到 Mizar 的账户页即可看到 GitHub 标识；此后也可以直接用 GitHub 登录。</p>
</main>
</body>
</html>`
}

/**
 * The page for a round-trip that failed before an account was resolved.
 *
 * The `code` travels in the body (and in the page title) so the deployment
 * manual's troubleshooting table is greppable from a screenshot.
 *
 * @param code - the wire error code, e.g. `GITHUB_EMAIL_CONFLICT`.
 * @param message - one line of advice.
 * @returns the HTML.
 */
export function githubErrorPage(code: string, message: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mizar · ${escape(code)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9;
         font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif; color: #1c1e21; }
  main { max-width: 420px; text-align: center; padding: 48px 28px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  code { display: inline-block; font-size: 13px; padding: 4px 10px; margin: 0 0 18px;
         background: #ffe9e9; color: #b3261e; border-radius: 6px;
         font-family: ui-monospace, Menlo, monospace; }
  p { margin: 0; color: #65676b; font-size: 14px; line-height: 1.6; }
</style>
</head>
<body>
<main>
  <h1>GitHub 登录没有完成</h1>
  <code>${escape(code)}</code>
  <p>${escape(message)}</p>
</main>
</body>
</html>`
}

/** Escape text for HTML interpolation. */
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** A 502 for a code GitHub would not honor. */
function exchangeFailed(message: string): AccountError {
  return new AccountError('GITHUB_EXCHANGE_FAILED', message, 502)
}

/** A 503 for a GitHub that cannot be reached. */
function unavailable(message: string): AccountError {
  return new AccountError('GITHUB_UNAVAILABLE', message, 503)
}
