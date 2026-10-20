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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientAddress } from '../client-address.js'
import type { AccountStore } from './store.js'
import { hashToken, validateDevice } from './store.js'
import { AccountError, type DeviceInput } from './types.js'
import { RateWindow } from './rate.js'
import { readBody, writeJson, parseJsonObject, stringField } from '../http.js'

/** The largest account request body. */
const MAX_BODY_BYTES = 64 * 1024

/** The largest App Store notification body. Apple's envelopes are small. */
const MAX_NOTIFICATION_BYTES = 256 * 1024

/** What the API needs. */
export interface AccountApiOptions {
  readonly store: AccountStore
  readonly trustProxy: boolean
  /** Whether App Store Server Notifications V2 are accepted. */
  readonly notificationsEnabled?: boolean
  readonly log?: (message: string) => void
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

  constructor(options: AccountApiOptions) {
    this.#store = options.store
    this.#trustProxy = options.trustProxy
    this.#notificationsEnabled = options.notificationsEnabled ?? true
    this.#log = options.log ?? (() => undefined)
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
        case 'POST /register':
          await this.#register(context)
          break
        case 'POST /login':
          await this.#login(context)
          break
        case 'POST /apple':
          await this.#apple(context)
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
    const result = await this.#store.register({ username, email, password, device })
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
      writeJson(context.response, error.status, { error: error.code, message: error.message })
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
