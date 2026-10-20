/**
 * The admin WebUI: authentication and routes.
 *
 * Password auth is scrypt against the hash in the relay config; the session is
 * a signed, HttpOnly cookie with an HMAC key derived from that hash, so changing
 * the admin password invalidates every existing session. Every state-changing
 * form carries a CSRF token derived from the same cookie, and the login route is
 * rate-limited.
 *
 * @module dsh-mizar-relay/accounts/admin
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientAddress } from '../client-address.js'
import { readBody, redirect, writeHtml } from '../http.js'
import { verifyPassword } from './passwords.js'
import { RateWindow } from './rate.js'
import type { AccountStore } from './store.js'
import type { TrafficLedger } from './traffic.js'
import { effectivePaidUntil } from './appstore/entitlements.js'
import { dayKey } from './traffic.js'
import {
  dashboardPage,
  formatBytes,
  guestsPage,
  invitesPage,
  loginPage,
  settingsPage,
  trafficPage,
  userPage,
  usersPage,
  type AdminGuestRow,
  type AdminInviteRow,
  type AdminTrafficData,
  type AdminUserDetail,
  type AdminUserRow,
} from './admin-html.js'

/** The cookie the admin session lives in. */
const COOKIE = 'mizar_admin'

/** Session lifetime. */
const SESSION_SECONDS = 24 * 60 * 60

/** Largest admin form body. */
const MAX_FORM_BYTES = 64 * 1024

/** What the admin UI needs. */
export interface AdminOptions {
  readonly store: AccountStore
  readonly traffic: TrafficLedger
  readonly passwordHash: string
  readonly role: 0 | 1
  readonly dataDir: string
  readonly publicBaseURL: string
  readonly bundleId: string
  readonly productId: string
  readonly version: string
  readonly trustProxy: boolean
  /** The paid gate's mode, for the settings page. */
  readonly paidGate?: string
  readonly now?: () => number
}

/** One authenticated admin session. */
interface AdminSession {
  readonly nonce: string
  readonly csrf: string
}

/** The admin UI. */
export class AdminApi {
  readonly #options: AdminOptions
  readonly #now: () => number
  readonly #loginWindow: RateWindow
  readonly #key: Buffer

  constructor(options: AdminOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#loginWindow = new RateWindow(5, 60_000, this.#now)
    this.#key = createHmac('sha256', 'dsh-mizar/admin')
      .update(options.passwordHash, 'utf8')
      .digest()
  }

  /**
   * Handle one `/admin` request.
   *
   * @param request - the request.
   * @param response - the response.
   * @param url - parsed URL.
   * @returns whether the path belongs to the admin UI.
   */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false
    const path = url.pathname.replace(/\/+$/, '') || '/admin'
    const method = request.method ?? 'GET'
    try {
      if (path === '/admin/login') {
        if (method === 'GET') return this.#loginPage(request, response)
        if (method === 'POST') return this.#login(request, response)
      }
      if (method === 'POST' && path === '/admin/logout') return this.#logout(response)
      const session = this.#session(request)
      if (session === null) {
        redirect(response, '/admin/login')
        return true
      }
      if (method === 'GET') {
        switch (path) {
          case '/admin':
            return this.#dashboard(response, url)
          case '/admin/users':
            return this.#users(response, url)
          case '/admin/guests':
            return this.#guests(response)
          case '/admin/invites':
            return this.#invites(response, url, session.csrf)
          case '/admin/traffic':
            return this.#traffic(response)
          case '/admin/settings':
            return this.#settings(response)
          default:
            if (path.startsWith('/admin/users/')) return this.#user(response, url, session.csrf)
            break
        }
      }
      if (method === 'POST') {
        return await this.#mutate(request, response, url, path)
      }
      writeHtml(response, 405, '<!doctype html><title>405</title><p>Method not allowed.</p>')
      return true
    } catch (error) {
      writeHtml(
        response,
        500,
        `<!doctype html><title>500</title><p>${escapeForError((error as Error).message)}</p>`,
      )
      return true
    }
  }

  // MARK: - Auth

  /** Serve the login page. */
  #loginPage(request: IncomingMessage, response: ServerResponse): boolean {
    if (this.#session(request) !== null) {
      redirect(response, '/admin')
      return true
    }
    writeHtml(response, 200, loginPage())
    return true
  }

  /** Handle a login form. */
  async #login(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const ip = clientAddress(request.socket.remoteAddress, request.headers, this.#options.trustProxy)
    if (!this.#loginWindow.check(ip)) {
      writeHtml(response, 429, loginPage('尝试过于频繁，请稍后再试。'))
      return true
    }
    const form = await this.#form(request)
    const password = form.get('password') ?? ''
    if (this.#options.passwordHash === '' || !(await verifyPassword(password, this.#options.passwordHash))) {
      writeHtml(response, 401, loginPage('密码不正确。'))
      return true
    }
    const nonce = randomNonce()
    const payload = JSON.stringify({ exp: this.#now() + SESSION_SECONDS * 1000, nonce })
    const cookie = `v1.${base64url(Buffer.from(payload, 'utf8'))}.${this.#sign(payload)}`
    const secure =
      request.headers['x-forwarded-proto'] === 'https' || 'encrypted' in request.socket
    response.setHeader(
      'set-cookie',
      `${COOKIE}=${cookie}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`,
    )
    redirect(response, '/admin')
    return true
  }

  /** Log out. */
  #logout(response: ServerResponse): boolean {
    response.setHeader('set-cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`)
    redirect(response, '/admin/login')
    return true
  }

  /** Read and verify the cookie. */
  #session(request: IncomingMessage): AdminSession | null {
    const cookie = parseCookies(request.headers.cookie)[COOKIE]
    if (cookie === undefined) return null
    const parts = cookie.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') return null
    const body = parts[1]
    const signature = parts[2]
    if (body === undefined || signature === undefined) return null
    const payload = Buffer.from(body, 'base64url').toString('utf8')
    if (!safeEqual(this.#sign(payload), signature)) return null
    let parsed: { exp?: unknown; nonce?: unknown }
    try {
      parsed = JSON.parse(payload) as { exp?: unknown; nonce?: unknown }
    } catch {
      return null
    }
    if (typeof parsed.exp !== 'number' || parsed.exp <= this.#now()) return null
    if (typeof parsed.nonce !== 'string' || parsed.nonce === '') return null
    return { nonce: parsed.nonce, csrf: this.#csrfFor(parsed.nonce) }
  }

  /** Sign a payload. */
  #sign(payload: string): string {
    return createHmac('sha256', this.#key).update(payload, 'utf8').digest('base64url')
  }

  /** Derive the CSRF token from the session nonce. */
  #csrfFor(nonce: string): string {
    return createHmac('sha256', this.#key).update(`csrf:${nonce}`, 'utf8').digest('base64url')
  }

  // MARK: - Pages

  /** Dashboard. */
  #dashboard(response: ServerResponse, url: URL): boolean {
    const now = this.#now()
    const snapshot = this.#options.traffic.snapshot()
    let todayIn = 0
    let todayOut = 0
    const today = dayKey(now)
    let guests = 0
    for (const identity of snapshot.identities) {
      if (identity.identity.startsWith('guest:') || identity.identity.startsWith('anon:')) guests += 1
      for (const [day, relays] of Object.entries(identity.days)) {
        if (day !== today) continue
        for (const counters of Object.values(relays)) {
          todayIn += counters.in
          todayOut += counters.out
        }
      }
    }
    const users = this.#options.store.allUsers()
    const paid = users.filter((user) => (effectivePaidUntil(user) ?? 0) > now).length
    writeHtml(
      response,
      200,
      dashboardPage(
        {
          userCount: users.length,
          paidCount: paid,
          guestCount: guests,
          todayIn,
          todayOut,
          relays: snapshot.relays,
          productId: this.#options.productId,
        },
        url.searchParams.get('notice') ?? undefined,
      ),
    )
    return true
  }

  /** Users list. */
  #users(response: ServerResponse, url: URL): boolean {
    const query = url.searchParams.get('q') ?? ''
    const page = Number(url.searchParams.get('page') ?? '1')
    const result = this.#options.store.listUsers(query, Number.isFinite(page) ? page : 1, 50)
    const now = this.#now()
    const rows: AdminUserRow[] = result.users.map((user) => {
      const traffic = this.#options.traffic.summaryForHashes(this.#options.store.sessionHashesForUser(user.id))
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        plan: (effectivePaidUntil(user) ?? 0) > now ? 'paid' : 'free',
        disabled: user.disabled,
        paidUntil: effectivePaidUntil(user),
        paidSources: [
          ...((user.entitlements.grantedPaidUntil ?? 0) > now ? ['invite'] : []),
          ...((user.entitlements.appStore?.paidUntil ?? 0) > now ? ['appstore'] : []),
        ],
        devices: user.devices.length,
        lastSeenAt: user.lastSeenAt,
        todayIn: traffic.todayIn,
        todayOut: traffic.todayOut,
      }
    })
    writeHtml(
      response,
      200,
      usersPage(
        { rows, total: result.total, page: result.page, pageSize: result.pageSize, query },
        url.searchParams.get('notice') ?? undefined,
      ),
    )
    return true
  }

  /** One user. */
  #user(response: ServerResponse, url: URL, csrf: string): boolean {
    const id = decodeURIComponent(url.pathname.slice('/admin/users/'.length))
    const user = this.#options.store.findUser(id)
    if (user === undefined) {
      writeHtml(response, 404, '<!doctype html><title>404</title><p>没有这个账户。</p>')
      return true
    }
    const now = this.#now()
    const traffic = this.#options.traffic.summaryForHashes(this.#options.store.sessionHashesForUser(user.id))
    const detail: AdminUserDetail = {
      row: {
        id: user.id,
        username: user.username,
        email: user.email,
        plan: (effectivePaidUntil(user) ?? 0) > now ? 'paid' : 'free',
        disabled: user.disabled,
        paidUntil: effectivePaidUntil(user),
        paidSources: [
          ...((user.entitlements.grantedPaidUntil ?? 0) > now ? ['invite'] : []),
          ...((user.entitlements.appStore?.paidUntil ?? 0) > now ? ['appstore'] : []),
        ],
        devices: user.devices.length,
        lastSeenAt: user.lastSeenAt,
        todayIn: traffic.todayIn,
        todayOut: traffic.todayOut,
      },
      emailVerified: user.emailVerified,
      apple: user.appleSub !== null,
      createdAt: user.createdAt,
      grantedPaidUntil: user.entitlements.grantedPaidUntil,
      appStore: user.entitlements.appStore === null
        ? null
        : {
            paidUntil: user.entitlements.appStore.paidUntil,
            environment: user.entitlements.appStore.environment,
            autoRenew: user.entitlements.appStore.autoRenew,
            revokedAt: user.entitlements.appStore.revokedAt,
            lastVerifiedAt: user.entitlements.appStore.lastVerifiedAt,
            originalTransactionId: user.entitlements.appStore.originalTransactionId,
          },
      devices: user.devices.map((device) => ({
        id: device.id,
        name: device.name,
        model: device.model,
        platform: device.platform,
        loginAt: device.loginAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
      })),
      traffic,
      sessionCount: this.#options.store.sessionHashesForUser(user.id).length,
    }
    writeHtml(response, 200, userPage(detail, csrf, url.searchParams.get('notice') ?? undefined))
    return true
  }

  /** Guests page. */
  #guests(response: ServerResponse): boolean {
    const now = this.#now()
    const today = dayKey(now)
    const rows: AdminGuestRow[] = this.#options.traffic
      .snapshot()
      .identities.filter((entry) => entry.identity.startsWith('guest:') || entry.identity.startsWith('anon:'))
      .map((entry) => {
        let todayIn = 0
        let todayOut = 0
        for (const [day, relays] of Object.entries(entry.days)) {
          if (day !== today) continue
          for (const counters of Object.values(relays)) {
            todayIn += counters.in
            todayOut += counters.out
          }
        }
        return {
          identity: entry.identity,
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
          totalIn: entry.totalIn,
          totalOut: entry.totalOut,
          todayIn,
          todayOut,
        }
      })
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 500)
    writeHtml(response, 200, guestsPage(rows))
    return true
  }

  /** Invites page. */
  #invites(response: ServerResponse, url: URL, csrf: string): boolean {
    const rows: AdminInviteRow[] = this.#options.store.allInvites().map((invite) => ({
      code: invite.code,
      days: invite.days,
      uses: invite.uses,
      maxUses: invite.maxUses,
      expiresAt: invite.expiresAt,
      disabled: invite.disabled,
      createdAt: invite.createdAt,
    }))
    writeHtml(response, 200, invitesPage(rows, csrf, url.searchParams.get('notice') ?? undefined))
    return true
  }

  /** Traffic page. */
  #traffic(response: ServerResponse): boolean {
    const snapshot = this.#options.traffic.snapshot()
    const today = dayKey(this.#now())
    let todayIn = 0
    let todayOut = 0
    let totalIn = 0
    let totalOut = 0
    const rows = snapshot.identities
      .map((entry) => {
        let rowTodayIn = 0
        let rowTodayOut = 0
        for (const [day, relays] of Object.entries(entry.days)) {
          if (day !== today) continue
          for (const counters of Object.values(relays)) {
            rowTodayIn += counters.in
            rowTodayOut += counters.out
          }
        }
        totalIn += entry.totalIn
        totalOut += entry.totalOut
        todayIn += rowTodayIn
        todayOut += rowTodayOut
        return {
          identity: entry.identity,
          totalIn: entry.totalIn,
          totalOut: entry.totalOut,
          todayIn: rowTodayIn,
          todayOut: rowTodayOut,
          lastSeenAt: entry.lastSeenAt,
        }
      })
      .sort((a, b) => b.totalIn + b.totalOut - (a.totalIn + a.totalOut))
      .slice(0, 200)
    const data: AdminTrafficData = {
      todayIn,
      todayOut,
      totalIn,
      totalOut,
      identities: snapshot.identities.length,
      relays: snapshot.relays,
      rows,
    }
    writeHtml(response, 200, trafficPage(data))
    return true
  }

  /** Settings page. */
  #settings(response: ServerResponse): boolean {
    writeHtml(
      response,
      200,
      settingsPage({
        role: this.#options.role,
        dataDir: this.#options.dataDir,
        publicBaseURL: this.#options.publicBaseURL,
        bundleId: this.#options.bundleId,
        productId: this.#options.productId,
        version: this.#options.version,
        paidGate: this.#options.paidGate ?? 'off',
      }),
    )
    return true
  }

  /** Compare one form's `_csrf` to the session token. */
  #csrfMatches(form: URLSearchParams, session: AdminSession): boolean {
    const value = form.get('_csrf')
    return value !== null && safeEqual(this.#csrfFor(session.nonce), value)
  }

  // MARK: - Mutations

  /** Route a POST after auth/CSRF. */
  async #mutate(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    path: string,
  ): Promise<boolean> {
    const session = this.#session(request)
    if (session === null) {
      redirect(response, '/admin/login')
      return true
    }
    const form = await this.#form(request)
    if (!this.#csrfMatches(form, session)) {
      writeHtml(response, 403, '<!doctype html><title>403</title><p>CSRF token is not valid.</p>')
      return true
    }
    const userMatch = /^\/admin\/users\/([^/]+)\/plan$/.exec(path)
    if (userMatch !== null) {
      const id = decodeURIComponent(userMatch[1] ?? '')
      const days = Number(form.get('days') ?? '0')
      await this.#options.store.setGrant(id, Number.isFinite(days) && days > 0 ? Math.min(3650, Math.round(days)) : null)
      redirect(response, `/admin/users/${encodeURIComponent(id)}?notice=${encodeURIComponent('人工权益已更新')}`)
      return true
    }
    const disableMatch = /^\/admin\/users\/([^/]+)\/disable$/.exec(path)
    if (disableMatch !== null) {
      const id = decodeURIComponent(disableMatch[1] ?? '')
      await this.#options.store.setDisabled(id, form.get('disabled') === '1')
      redirect(response, `/admin/users/${encodeURIComponent(id)}?notice=${encodeURIComponent('账户状态已更新')}`)
      return true
    }
    const deviceMatch = /^\/admin\/users\/([^/]+)\/devices\/([^/]+)\/revoke$/.exec(path)
    if (deviceMatch !== null) {
      const id = decodeURIComponent(deviceMatch[1] ?? '')
      const deviceId = decodeURIComponent(deviceMatch[2] ?? '')
      await this.#options.store.revokeDevice(id, deviceId)
      redirect(response, `/admin/users/${encodeURIComponent(id)}?notice=${encodeURIComponent('设备已吊销')}`)
      return true
    }
    if (path === '/admin/invites') {
      const code = form.get('code') ?? ''
      const days = Number(form.get('days') ?? '30')
      const maxUses = Number(form.get('maxUses') ?? '1')
      const expiresDays = Number(form.get('expiresDays') ?? '0')
      await this.#options.store.createInvite({
        ...(code.trim() === '' ? {} : { code }),
        days: Number.isFinite(days) ? days : 30,
        maxUses: Number.isFinite(maxUses) ? maxUses : 1,
        expiresAt:
          Number.isFinite(expiresDays) && expiresDays > 0
            ? this.#now() + Math.min(3650, Math.round(expiresDays)) * 86_400_000
            : null,
      })
      redirect(response, `/admin/invites?notice=${encodeURIComponent('邀请码已创建')}`)
      return true
    }
    const inviteMatch = /^\/admin\/invites\/([^/]+)\/(disable|enable|delete)$/.exec(path)
    if (inviteMatch !== null) {
      const code = decodeURIComponent(inviteMatch[1] ?? '')
      const action = inviteMatch[2]
      if (action === 'delete') await this.#options.store.deleteInvite(code)
      else await this.#options.store.setInviteDisabled(code, action === 'disable')
      redirect(response, `/admin/invites?notice=${encodeURIComponent('邀请码已更新')}`)
      return true
    }
    void url
    writeHtml(response, 404, '<!doctype html><title>404</title><p>没有这个后台操作。</p>')
    return true
  }

  // MARK: - Form helpers

  /** Read a urlencoded form. */
  async #form(request: IncomingMessage): Promise<URLSearchParams> {
    const body = await readBody(request, MAX_FORM_BYTES)
    if (body === null) return new URLSearchParams()
    return new URLSearchParams(body.toString('utf8'))
  }

}

/** Parse a Cookie header. */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name !== '') out[name] = value
  }
  return out
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** A random nonce. */
function randomNonce(): string {
  return randomBytes(16).toString('hex')
}

/** Base64url one buffer. */
function base64url(value: Buffer): string {
  return value.toString('base64url')
}

/** Escape a message for a minimal error page. */
function escapeForError(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export { formatBytes }
