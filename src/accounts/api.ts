/**
 * The account HTTP API.
 *
 * One request handler for `/account/v1/*`, written as a plain function table so
 * the route surface is greppable. Everything that can fail with advice fails
 * with a code and an HTTP status; the phone maps the code, and the admin UI
 * never sees these routes at all.
 *
 * @module dsh-mizar-relay/accounts/api
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientAddress } from '../client-address.js'
import { normalizeEmail } from './avatar.js'
import type { MailClient } from '../mail/client.js'
import type { AccountStore } from './store.js'
import { hashToken, validateDevice, validateEmail, validatePassword, validateUsername } from './store.js'
import { AccountError, type DeviceInput, type GitHubIdentity } from './types.js'
import type { VerificationCodes } from './verification.js'
import { RateWindow } from './rate.js'
import { GitHubOAuth, githubBoundPage, githubDonePage, githubErrorPage } from './github.js'
import { readBody, writeJson, writeHtml, redirect, parseJsonObject, stringField } from '../http.js'

/** The largest account request body. */
const MAX_BODY_BYTES = 64 * 1024

/** The largest App Store notification body. Apple's envelopes are small. */
const MAX_NOTIFICATION_BYTES = 256 * 1024

/** How long a pending GitHub round-trip survives the browser. */
const GITHUB_PENDING_TTL_MS = 10 * 60_000

/** How long a handoff code waits for the phone that will claim it. */
const GITHUB_HANDOFF_TTL_MS = 10 * 60_000

/** The shape of a handoff code, `MZ-XXXX-XXXX`, unambiguous alphabet. */
const GITHUB_HANDOFF_SHAPE = /^MZ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/

/** What the API needs. */
export interface AccountApiOptions {
  readonly store: AccountStore
  readonly trustProxy: boolean
  /** Whether App Store Server Notifications V2 are accepted. */
  readonly notificationsEnabled?: boolean
  /**
   * GitHub sign-in, when this relay is configured for it. Absent answers
   * `GITHUB_NOT_CONFIGURED` on every `/github/*` route.
   */
  readonly github?: { readonly clientId: string; readonly clientSecret: string; readonly callbackURL: string }
  /** Clock, injectable for the pending/handoff TTLs. */
  readonly now?: () => number
  /** Fetch implementation for GitHub's OAuth endpoints; injectable for tests. */
  readonly fetchImpl?: typeof fetch
  readonly log?: (message: string) => void
  /** The code store, when email verification is enabled. */
  readonly verification?: VerificationCodes | null
  /** The mail client, when this relay can send. */
  readonly mail?: MailClient | null
  /** Appeal address printed on `ACCOUNT_DISABLED`. */
  readonly contact?: string
}

/** Per-request facts. */
interface RequestContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly path: string
  readonly ip: string
}

/** The account API. */
export class AccountApi {
  readonly #store: AccountStore
  readonly #trustProxy: boolean
  readonly #notificationsEnabled: boolean
  readonly #log: (message: string) => void
  readonly #ipWindow = new RateWindow(120, 60_000)
  readonly #registerWindow = new RateWindow(10, 60 * 60_000)
  readonly #loginWindow = new RateWindow(10, 15 * 60_000)
  /**
   * Invite redemptions, keyed by account.
   *
   * A code is a bearer capability for paid days, so the thing worth rate
   * limiting is the guessing of one. Keyed by the account rather than the
   * address: a phone that moves between networks keeps its budget, and an
   * attacker who spreads attempts across addresses still hits the ceiling of
   * whichever account they signed in to. Five attempts an hour is far more than
   * a person mistypes a code and far less than a scanner reads them.
   */
  readonly #redeemWindow = new RateWindow(5, 60 * 60_000)
  readonly #github: GitHubOAuth | null
  /**
   * The browser round-trip's memory: the state GitHub echoes back, and the
   * handoff codes waiting for a phone. Both live in memory only and die with
   * the process -- a restart simply asks the operator to start again, which
   * the ten-minute TTL already asks.
   */
  readonly #githubPending = new Map<
    string,
    { kind: 'login'; device: DeviceInput; expiresAt: number } | { kind: 'bind'; userId: string; expiresAt: number }
  >()
  readonly #githubHandoff = new Map<string, { userId: string; expiresAt: number }>()
  readonly #githubStartWindow = new RateWindow(10, 60_000)
  readonly #githubHandoffWindow = new RateWindow(20, 60_000)
  readonly #now: () => number
  readonly #verification: VerificationCodes | null
  readonly #mail: MailClient | null
  readonly #contact: string
  /** Password-reset starts, per address; a reset is a mail-bombing surface too. */
  readonly #resetWindow = new RateWindow(5, 60 * 60_000)

  constructor(options: AccountApiOptions) {
    this.#store = options.store
    this.#trustProxy = options.trustProxy
    this.#notificationsEnabled = options.notificationsEnabled ?? true
    this.#log = options.log ?? (() => undefined)
    this.#now = options.now ?? Date.now
    this.#verification = options.verification ?? null
    this.#mail = options.mail ?? null
    this.#contact = options.contact ?? 'shirazunagisa@icloud.com'
    this.#github =
      options.github === undefined
        ? null
        : new GitHubOAuth({
            ...options.github,
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          })
  }

  /**
   * Answer one request, if it belongs to this API.
   *
   * @param request - the request.
   * @param response - the response.
   * @param url - the parsed URL.
   * @returns whether the request was handled.
   */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/account/v1/')) return false
    const path = url.pathname.slice('/account/v1'.length).replace(/\/+$/, '') || '/'
    const ip = clientAddress(request.socket.remoteAddress, request.headers, this.#trustProxy)
    const context: RequestContext = { request, response, path, ip }
    try {
      if (!this.#ipWindow.check(ip)) {
        this.#tooMany(context)
        return true
      }
      switch (`${request.method ?? 'GET'} ${path}`) {
        case 'POST /register/start':
          await this.#registerStart(context)
          break
        case 'POST /register':
          await this.#register(context)
          break
        case 'POST /password/reset/start':
          await this.#resetStart(context)
          break
        case 'POST /password/reset/complete':
          await this.#resetComplete(context)
          break
        case 'POST /login':
          await this.#login(context)
          break
        case 'POST /apple':
          await this.#apple(context)
          break
        case 'POST /github/start':
          await this.#githubStart(context)
          break
        case 'GET /github/callback':
          await this.#githubCallback(context, url)
          break
        case 'GET /github/done':
          await this.#githubDone(context, url)
          break
        case 'POST /github/handoff':
          await this.#githubHandoffRoute(context)
          break
        case 'GET /me':
          await this.#me(context)
          break
        case 'POST /logout':
          await this.#logout(context)
          break
        case 'POST /delete':
          await this.#delete(context)
          break
        case 'POST /invite/redeem':
          await this.#redeem(context)
          break
        case 'POST /appstore/transaction':
          await this.#appStoreTransaction(context)
          break
        case 'POST /appstore/sync':
          await this.#appStoreSync(context)
          break
        case 'POST /appstore/notifications':
          await this.#appStoreNotification(context)
          break
        default:
          writeJson(response, 404, { error: 'NOT_FOUND', message: 'no such account endpoint' })
      }
    } catch (error) {
      this.#fail(context, error)
    }
    return true
  }

  // MARK: - Routes

  /**
   * Send the code that starts an email+password registration.
   *
   * Nothing is created here: the account exists only after `/register` presents
   * the code. That ordering is what makes "验证之后才可以注册" true rather than
   * a client-side promise.
   */
  async #registerStart(context: RequestContext): Promise<void> {
    if (!this.#registerWindow.check(context.ip)) {
      this.#tooMany(context, 'registration rate limit reached')
      return
    }
    const body = await this.#json(context)
    if (body === null) return
    const username = requireString(body, 'username')
    const email = requireString(body, 'email')
    const password = requireString(body, 'password')
    validateUsername(username)
    validateEmail(email)
    validatePassword(password)
    const verification = this.#verification
    const mail = this.#mail
    if (verification === null || mail === null) {
      throw new AccountError('MAIL_UNAVAILABLE', 'email verification is not configured on this server', 503)
    }
    this.#store.assertRegistrationAvailable(username, email)
    const emailKey = normalizeEmail(email)
    const issued = await verification.issue(emailKey, 'register')
    await mail.sendVerification(email.trim(), issued.code, 10)
    writeJson(context.response, 200, {
      email: email.trim(),
      expiresAt: issued.expiresAt,
      resendAfterSeconds: issued.resendAfterSeconds,
    })
  }

  async #register(context: RequestContext): Promise<void> {
    if (!this.#registerWindow.check(context.ip)) {
      this.#tooMany(context, 'registration rate limit reached')
      return
    }
    const body = await this.#json(context)
    if (body === null) return
    const username = requireString(body, 'username')
    const email = requireString(body, 'email')
    const password = requireString(body, 'password')
    const device = deviceOf(body)
    const code = stringField(body, 'code')
    if (this.#verification !== null) {
      if (code === undefined || code.trim() === '') {
        throw new AccountError(
          'EMAIL_VERIFICATION_REQUIRED',
          'request a code with /register/start and send it as "code"',
          428,
        )
      }
      const emailKey = normalizeEmail(validateEmail(email))
      await this.#verification.verify(emailKey, 'register', code.trim())
    }
    const result = await this.#store.register({
      username,
      email,
      password,
      device,
      emailVerified: this.#verification !== null,
    })
    writeJson(context.response, 200, result)
  }

  /**
   * Start a password reset.
   *
   * The answer is the same whether or not the address exists: a reset endpoint
   * that says "no such account" is an account-enumeration oracle.
   */
  async #resetStart(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    const email = requireString(body, 'email')
    validateEmail(email)
    const key = normalizeEmail(email)
    if (!this.#resetWindow.check(key)) {
      this.#tooMany(context, 'too many reset requests for this address')
      return
    }
    const verification = this.#verification
    const mail = this.#mail
    const user = this.#store.findUserByEmail(email)
    let expiresAt = this.#now() + 10 * 60_000
    if (verification !== null && mail !== null && user !== undefined) {
      const issued = await verification.issue(key, 'reset')
      expiresAt = issued.expiresAt
      try {
        await mail.sendVerification(email.trim(), issued.code, 10)
      } catch (error) {
        // Keep the uniform answer; an operator sees the failure in the log.
        this.#log(`accounts: reset mail failed: ${(error as Error).message}`)
      }
    }
    writeJson(context.response, 200, { ok: true, expiresAt, resendAfterSeconds: 60 })
  }

  /** Finish a password reset and issue a session for the claiming device. */
  async #resetComplete(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    const email = requireString(body, 'email')
    const code = requireString(body, 'code')
    const password = requireString(body, 'password')
    const device = deviceOf(body)
    validateEmail(email)
    validatePassword(password)
    if (this.#verification === null) {
      throw new AccountError('MAIL_UNAVAILABLE', 'email verification is not configured on this server', 503)
    }
    const emailKey = normalizeEmail(email)
    await this.#verification.verify(emailKey, 'reset', code.trim())
    const result = await this.#store.resetPassword(email, password, device)
    writeJson(context.response, 200, result)
  }

  async #login(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    const identifier = requireString(body, 'identifier')
    const password = requireString(body, 'password')
    const device = deviceOf(body)
    const key = identifier.trim().toLowerCase()
    if (!this.#loginWindow.check(key)) {
      this.#tooMany(context, 'too many sign-in attempts')
      return
    }
    try {
      const result = await this.#store.login({ identifier, password, device })
      this.#loginWindow.clear(key)
      writeJson(context.response, 200, result)
    } catch (error) {
      // The window counts attempts; a failed attempt deliberately stays in it.
      throw error
    }
  }

  async #apple(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    const identityToken = requireString(body, 'identityToken')
    const nonce = stringField(body, 'nonce')
    const fullName = stringField(body, 'fullName')
    const device = deviceOf(body)
    const result = await this.#store.signInWithApple({
      identityToken,
      ...(nonce === undefined ? {} : { nonce }),
      ...(fullName === undefined ? {} : { fullName }),
      device,
    })
    writeJson(context.response, 200, result)
  }

  async #me(context: RequestContext): Promise<void> {
    const token = bearer(context.request)
    const user = await this.#store.me(token, deviceIdOf(context.request))
    writeJson(context.response, 200, { user })
  }

  async #logout(context: RequestContext): Promise<void> {
    await this.#store.logout(bearer(context.request))
    writeJson(context.response, 200, { ok: true })
  }

  async #delete(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    if (body['confirmation'] !== 'DELETE') {
      throw new AccountError('INVALID_INPUT', 'send confirmation: "DELETE"', 400)
    }
    await this.#store.deleteAccount(bearer(context.request))
    writeJson(context.response, 200, { ok: true })
  }

  async #redeem(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    const code = requireString(body, 'code')
    const token = bearer(context.request)
    // Keyed on the account's token hash rather than the raw token: the window
    // holds these strings for an hour and a session token is a live credential.
    const key = hashToken(token)
    if (!this.#redeemWindow.check(key)) {
      this.#tooMany(context, 'too many invite redemptions; try again later')
      return
    }
    const user = await this.#store.redeemInvite(token, code)
    writeJson(context.response, 200, { user })
  }

  async #appStoreTransaction(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    const signedTransaction = requireString(body, 'signedTransaction')
    const user = await this.#store.appStoreTransaction(bearer(context.request), signedTransaction)
    writeJson(context.response, 200, { user })
  }

  async #appStoreSync(context: RequestContext): Promise<void> {
    const body = await this.#json(context)
    if (body === null) return
    const raw = body['signedTransactions']
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== 'string')) {
      throw new AccountError('INVALID_INPUT', 'signedTransactions must be a non-empty array of strings', 400)
    }
    const user = await this.#store.appStoreSync(
      bearer(context.request),
      raw as string[],
    )
    writeJson(context.response, 200, { user })
  }

  async #appStoreNotification(context: RequestContext): Promise<void> {
    if (!this.#notificationsEnabled) {
      writeJson(context.response, 404, { error: 'NOT_FOUND', message: 'notifications are disabled' })
      return
    }
    const body = await readBody(context.request, MAX_NOTIFICATION_BYTES)
    if (body === null) {
      writeJson(context.response, 413, { error: 'INVALID_INPUT', message: 'notification too large' })
      return
    }
    const parsed = parseJsonObject(body.toString('utf8'))
    const signedPayload = parsed === null ? undefined : stringField(parsed, 'signedPayload')
    if (signedPayload === undefined) {
      writeJson(context.response, 400, { error: 'INVALID_INPUT', message: 'signedPayload is required' })
      return
    }
    await this.#store.appStoreNotification(signedPayload)
    writeJson(context.response, 200, { ok: true })
  }

  // MARK: - GitHub

  /** Guard shared by every /github/* route: the feature must be configured. */
  #githubOr404(context: RequestContext): GitHubOAuth | null {
    if (this.#github === null) {
      writeJson(context.response, 404, {
        error: 'GITHUB_NOT_CONFIGURED',
        message: 'GitHub sign-in is not configured on this relay',
      })
      return null
    }
    return this.#github
  }

  async #githubStart(context: RequestContext): Promise<void> {
    const github = this.#githubOr404(context)
    if (github === null) return
    if (!this.#githubStartWindow.check(context.ip)) {
      this.#tooMany(context, 'too many GitHub sign-in attempts')
      return
    }
    const body = await this.#json(context)
    if (body === null) return
    const device = deviceOf(body)
    const now = this.#now()
    this.#pruneGithub(now)
    // A request that carries a session is the account page asking to LINK a
    // GitHub identity; anonymous requests are signing in or signing up.
    const token = bearerOrUndefined(context.request)
    const pending =
      token === undefined
        ? { kind: 'login' as const, device, expiresAt: now + GITHUB_PENDING_TTL_MS }
        : { kind: 'bind' as const, userId: (await this.#store.me(token, null)).id, expiresAt: now + GITHUB_PENDING_TTL_MS }
    const state = randomBytes(16).toString('hex')
    this.#githubPending.set(state, pending)
    writeJson(context.response, 200, {
      authorizeUrl: github.authorizeURL(state),
      state,
      expiresAt: pending.expiresAt,
    })
  }

  async #githubCallback(context: RequestContext, url: URL): Promise<void> {
    const github = this.#githubOr404(context)
    if (github === null) return
    const now = this.#now()
    this.#pruneGithub(now)
    const fail = (code: string, message: string, status = 400): void => {
      writeHtml(context.response, status, githubErrorPage(code, message))
    }
    // GitHub itself can refuse at the authorize step (access_denied, a redirect
    // mismatch) -- the manual's troubleshooting table starts here.
    const refused = url.searchParams.get('error')
    if (refused !== null) {
      fail('GITHUB_EXCHANGE_FAILED', `GitHub sent the callback back with an error: ${refused}`)
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code === null || state === null) {
      fail('GITHUB_INVALID_STATE', 'the callback arrived without a code or a state; start the sign-in again')
      return
    }
    const pending = this.#githubPending.get(state)
    if (pending === undefined || pending.expiresAt <= now) {
      this.#githubPending.delete(state)
      fail('GITHUB_INVALID_STATE', 'this sign-in round-trip is unknown or has expired; start again')
      return
    }
    // One round-trip, one consumption: a replayed callback cannot mint a second
    // handoff code for the same identity.
    this.#githubPending.delete(state)
    let identity: GitHubIdentity
    try {
      const accessToken = await github.exchange(code)
      identity = await github.identity(accessToken)
    } catch (error) {
      if (error instanceof AccountError) {
        fail(error.code, error.message, error.status)
        return
      }
      this.#log(`accounts: github exchange failed: ${String(error)}`)
      fail('GITHUB_EXCHANGE_FAILED', 'the GitHub exchange failed')
      return
    }
    try {
      if (pending.kind === 'bind') {
        await this.#store.linkGitHubIdentity({ userId: pending.userId, identity })
        redirect(context.response, this.#doneURL('bound=1'))
        return
      }
      const { userId } = await this.#store.resolveGitHubIdentity(identity)
      const handoff = this.#newHandoff(userId, now)
      redirect(context.response, this.#doneURL(`handoff=${encodeURIComponent(handoff.code)}`))
    } catch (error) {
      if (error instanceof AccountError) {
        fail(error.code, error.message, error.status)
        return
      }
      this.#log(`accounts: github callback failed: ${String(error)}`)
      fail('INTERNAL', 'the account service failed', 500)
    }
  }

  async #githubDone(context: RequestContext, url: URL): Promise<void> {
    if (url.searchParams.get('bound') === '1') {
      writeHtml(context.response, 200, githubBoundPage())
      return
    }
    const handoff = url.searchParams.get('handoff')
    if (handoff === null || !GITHUB_HANDOFF_SHAPE.test(handoff)) {
      writeHtml(
        context.response,
        400,
        githubErrorPage('GITHUB_INVALID_STATE', 'this handoff code is not shaped right; start the sign-in again'),
      )
      return
    }
    writeHtml(context.response, 200, githubDonePage(handoff))
  }

  async #githubHandoffRoute(context: RequestContext): Promise<void> {
    const github = this.#githubOr404(context)
    if (github === null) return
    if (!this.#githubHandoffWindow.check(context.ip)) {
      this.#tooMany(context, 'too many handoff attempts')
      return
    }
    const body = await this.#json(context)
    if (body === null) return
    const code = requireString(body, 'code')
    const device = deviceOf(body)
    if (!GITHUB_HANDOFF_SHAPE.test(code)) {
      throw new AccountError('GITHUB_HANDOFF_INVALID', 'that sign-in code is not shaped right', 400)
    }
    const now = this.#now()
    this.#pruneGithub(now)
    const key = hashToken(code)
    const entry = this.#githubHandoff.get(key)
    if (entry === undefined || entry.expiresAt <= now) {
      this.#githubHandoff.delete(key)
      throw new AccountError('GITHUB_HANDOFF_INVALID', 'that sign-in code is unknown or has expired; start again', 400)
    }
    this.#githubHandoff.delete(key)
    const result = await this.#store.createSession({ userId: entry.userId, device })
    writeJson(context.response, 200, result)
  }

  #doneURL(query: string): string {
    // The callback URL shares the deployment origin the done page lives on,
    // which is what makes a same-origin redirect safe to build from it.
    const done = new URL('/account/v1/github/done', this.#github?.callbackURL ?? 'https://relay.invalid')
    done.search = query
    return done.toString()
  }

  #newHandoff(userId: string, now: number): { code: string; expiresAt: number } {
    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
    const pick = (): string => alphabet.charAt(randomBytes(1)[0]! % alphabet.length)
    const chunk = (): string => `${pick()}${pick()}${pick()}${pick()}`
    const code = `MZ-${chunk()}-${chunk()}`
    this.#githubHandoff.set(hashToken(code), { userId, expiresAt: now + GITHUB_HANDOFF_TTL_MS })
    return { code, expiresAt: now + GITHUB_HANDOFF_TTL_MS }
  }

  #pruneGithub(now: number): void {
    for (const [state, pending] of this.#githubPending) {
      if (pending.expiresAt <= now) this.#githubPending.delete(state)
    }
    for (const [key, entry] of this.#githubHandoff) {
      if (entry.expiresAt <= now) this.#githubHandoff.delete(key)
    }
  }

  // MARK: - Internals

  /** Read and parse a JSON body, answering the request on failure. */
  async #json(context: RequestContext): Promise<Record<string, unknown> | null> {
    const body = await readBody(context.request, MAX_BODY_BYTES)
    if (body === null) {
      writeJson(context.response, 413, { error: 'INVALID_INPUT', message: 'request body too large' })
      return null
    }
    const parsed = parseJsonObject(body.toString('utf8'))
    if (parsed === null) {
      writeJson(context.response, 400, { error: 'INVALID_INPUT', message: 'a JSON object is required' })
      return null
    }
    return parsed
  }

  /** Translate an exception into the wire error shape. */
  #fail(context: RequestContext, error: unknown): void {
    if (error instanceof AccountError) {
      const contact = error.contact ?? (error.code === 'ACCOUNT_DISABLED' ? this.#contact : undefined)
      writeJson(context.response, error.status, {
        error: error.code,
        message: error.message,
        ...(contact === undefined ? {} : { contact }),
      })
      return
    }
    this.#log(`accounts: ${context.request.method ?? 'GET'} ${context.path} failed: ${String(error)}`)
    writeJson(context.response, 500, { error: 'INTERNAL', message: 'the account service failed' })
  }

  /** Answer 429. */
  #tooMany(context: RequestContext, message = 'too many requests'): void {
    context.response.setHeader('retry-after', '60')
    writeJson(context.response, 429, { error: 'RATE_LIMITED', message })
  }
}

/** The bearer token, when the request carries a well-formed one. */
function bearerOrUndefined(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string' || header.trim() === '') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null || match[1] === undefined || match[1] === '') return undefined
  return match[1].trim()
}

/** Extract the bearer token. */
export function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization
  if (typeof header !== 'string') throw new AccountError('UNAUTHENTICATED', 'a session token is required', 401)
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null || match[1] === undefined || match[1] === '') {
    throw new AccountError('UNAUTHENTICATED', 'a session token is required', 401)
  }
  return match[1].trim()
}

/** Read a required non-empty string. */
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new AccountError('INVALID_INPUT', `${key} is required`, 400)
  }
  return value
}

/** Build a validated device descriptor from a request body. */
function deviceOf(body: Record<string, unknown>): DeviceInput {
  const raw = body['device']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AccountError('INVALID_INPUT', 'device is required', 400)
  }
  const record = raw as Record<string, unknown>
  const id = requireString(record, 'id')
  return validateDevice({
    id,
    name: typeof record['name'] === 'string' ? record['name'] : 'iPhone',
    model: typeof record['model'] === 'string' ? record['model'] : 'unknown',
    platform: typeof record['platform'] === 'string' ? record['platform'] : 'ios',
    appVersion: typeof record['appVersion'] === 'string' ? record['appVersion'] : 'unknown',
  })
}

/** The installation id, when a request carries one, for `current` flags. */
function deviceIdOf(request: IncomingMessage): string | null {
  const value = request.headers['x-mizar-client-id']
  return typeof value === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : null
}
