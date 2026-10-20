/**
 * The paid gate: who may use this relay's bandwidth.
 *
 * Every other limit in the relay is a resource guard -- four tunnels per
 * address, eight phones per room, four mebibytes per body. None of them asks
 * whether the phone is paying, which is why the paid relay used to be a paid
 * hostname and nothing more: a free account, or no account at all, could put
 * unlimited bytes through it as long as it knew a room id.
 *
 * This module is the missing question. A phone presents its account session
 * token in `x-mizar-session`; the gate resolves it against the account store
 * and decides. Three properties are worth stating because they are the design:
 *
 *   - **It fails closed.** A missing, unknown, revoked or expired token is a
 *     refusal, not a pass. The only way through is a token that resolves to an
 *     account whose paid period is still running.
 *   - **It is cheap.** The store lookup is a map read and the result is cached
 *     for a minute, so a gate on every relayed request does not turn a
 *     conversation into a series of disk-adjacent checks. Refunds, sign-outs
 *     and admin downgrades invalidate the cache through the store's listener
 *     rather than waiting for the TTL.
 *   - **It can watch before it blocks.** `observe` counts and logs what it
 *     would have refused and lets the request through, which is how a rollout
 *     is supposed to work: deploy, watch the refusals for a day, then enforce.
 *
 * What it does *not* do is authenticate the phone to the computer. The device
 * token from pairing still does that, over the tunnel, and the relay still
 * cannot forge it. This only decides whether the relay carries the bytes.
 *
 * @module dsh-mizar-relay/accounts/gate
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { PaidGateMode } from '../config.js'
import { SESSION_HEADER } from './identity.js'
import { hashToken, type AccountStore } from './store.js'

/** Why a request was refused, in the codes the phone switches on. */
export type GateRefusalCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_REVOKED'
  | 'ACCOUNT_DISABLED'
  | 'PAID_REQUIRED'

/** A request the gate let through. */
export interface GateAllowance {
  readonly allowed: true
  /** The account behind the token. */
  readonly userId: string
  /** SHA-256 of the token, which is the traffic ledger's identity key. */
  readonly tokenHash: string
  /** End of the paid period, or `null` when `allowUnaccounted` let it through. */
  readonly paidUntil: number | null
  /** Whether the answer came from the cache rather than the store. */
  readonly cached: boolean
  /** Set in `observe` mode: this is what enforcement would have refused. */
  readonly observed?: { readonly status: 401 | 402 | 403; readonly code: GateRefusalCode }
}

/** A request the gate refused. */
export interface GateRefusal {
  readonly allowed: false
  readonly status: 401 | 402 | 403
  readonly code: GateRefusalCode
  readonly message: string
  /** Whether the answer came from the cache rather than the store. */
  readonly cached: boolean
}

/** What the gate decided about one request. */
export type GateDecision = GateAllowance | GateRefusal

/** What the gate needs. */
export interface PaidGateOptions {
  readonly store: AccountStore
  readonly mode: PaidGateMode
  readonly allowUnaccounted: boolean
  readonly cacheTtlMs: number
  /** Clock, injectable for tests. */
  readonly now?: () => number
  /** Where to report, at most once every ten seconds per reason. */
  readonly log?: (message: string) => void
  /** Cache bound; a token flood must not become memory growth. */
  readonly maxCacheEntries?: number
}

/** One cached allowance. */
interface CacheEntry {
  readonly userId: string
  readonly paidUntil: number | null
  readonly checkedAt: number
}

/** How often one refusal reason may be logged. */
const LOG_INTERVAL_MS = 10_000

/** Longest token the gate will look at; a session token is ~47 characters. */
const MAX_TOKEN_LENGTH = 512

/** Shortest token worth hashing. */
const MIN_TOKEN_LENGTH = 16

/**
 * The Mizar paths a phone must reach before it has a session.
 *
 * `/hello` is how the app confirms the address answers, and `/pair` exchanges a
 * live single-use code for a device token. Both are the pre-auth handshake, and
 * gating them would mean a new user could not pair on the paid relay in order
 * to sign in. Neither carries conversation traffic: `/pair` is rate limited by
 * the plugin and issues one device token, and everything after it arrives on
 * `/mizar/v1/ws`, which *is* gated.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set(['/mizar/v1/hello', '/mizar/v1/pair'])

/**
 * Whether a Mizar path is the pre-pairing handshake.
 *
 * @param path - the path as the phone sent it, including `/mizar/v1`.
 * @returns whether the gate must let it through unexamined.
 */
export function isGateExempt(path: string): boolean {
  // A query string is not part of the route, and a trailing slash is a typo the
  // router tolerates; neither may be the difference between "the handshake" and
  // "a paywalled request".
  const route = (path.split('?')[0] ?? '').replace(/\/+$/, '')
  return EXEMPT_PATHS.has(route)
}

/** The paid gate. */
export class PaidGate {
  readonly #store: AccountStore
  readonly #mode: PaidGateMode
  readonly #allowUnaccounted: boolean
  readonly #cacheTtlMs: number
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #maxCacheEntries: number
  readonly #cache = new Map<string, CacheEntry>()
  readonly #lastLogAt = new Map<string, number>()
  #allowed = 0
  #refused = 0
  #cachedHits = 0
  #observed = 0

  /**
   * @param options - the store, the policy and the clock.
   */
  constructor(options: PaidGateOptions) {
    this.#store = options.store
    this.#mode = options.mode
    this.#allowUnaccounted = options.allowUnaccounted
    this.#cacheTtlMs = Math.max(0, options.cacheTtlMs)
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => undefined)
    this.#maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 20_000)
    // Registered here rather than by the caller: a gate that is built without
    // its invalidation hook is a gate that keeps honouring a refunded account
    // for a minute, and that is exactly the kind of wiring that gets forgotten.
    // There is one gate per relay, so one listener is enough.
    this.#store.setEntitlementListener((userId) => this.invalidate(userId))
  }

  /** Whether this gate refuses, watches, or is off. */
  get mode(): PaidGateMode {
    return this.#mode
  }

  /** Counters for `/healthz` and the admin pages. */
  get stats(): {
    readonly mode: PaidGateMode
    readonly allowed: number
    readonly refused: number
    readonly cached: number
    readonly observed: number
    readonly cacheSize: number
  } {
    return {
      mode: this.#mode,
      allowed: this.#allowed,
      refused: this.#refused,
      cached: this.#cachedHits,
      observed: this.#observed,
      cacheSize: this.#cache.size,
    }
  }

  /**
   * Decide one request.
   *
   * `mode === 'off'` is never reached: the relay does not build a gate then.
   * `observe` returns an allowance carrying what enforcement would have said.
   *
   * @param headers - the request or upgrade headers.
   * @returns the decision.
   */
  authorize(headers: IncomingHttpHeaders): GateDecision {
    const token = this.#tokenOf(headers)
    if (token === null) {
      return this.#refuse(
        'UNAUTHENTICATED',
        401,
        'this relay carries paying accounts only; sign in and try again',
        this.#allowUnaccounted ? 'policy' : 'observe-if-watching',
      )
    }

    const tokenHash = hashToken(token)
    const now = this.#now()
    const cached = this.#cache.get(tokenHash)
    if (cached !== undefined && now - cached.checkedAt < this.#cacheTtlMs) {
      if (cached.paidUntil !== null && cached.paidUntil > now) {
        this.#cachedHits += 1
        this.#allowed += 1
        return {
          allowed: true,
          userId: cached.userId,
          tokenHash,
          paidUntil: cached.paidUntil,
          cached: true,
        }
      }
      // The cached period ran out while it sat in the cache. Fall through to the
      // store: a renewal may have landed since.
    }

    const entitlement = this.#store.tokenEntitlement(token)
    if (!entitlement.ok) {
      this.#cache.delete(tokenHash)
      switch (entitlement.reason) {
        case 'revoked':
          return this.#refuse('SESSION_REVOKED', 401, 'this session was signed out elsewhere', 'observe-if-watching')
        case 'expired':
          return this.#refuse('UNAUTHENTICATED', 401, 'this session has expired', 'observe-if-watching')
        case 'disabled':
          return this.#refuse('ACCOUNT_DISABLED', 403, 'this account is disabled', 'observe-if-watching')
        case 'unknown':
        default:
          return this.#refuse('UNAUTHENTICATED', 401, 'this session is not valid', 'observe-if-watching')
      }
    }

    if (!entitlement.paid) {
      return this.#refuse(
        'PAID_REQUIRED',
        402,
        'the paid relay is for paid accounts; this account is on the free plan',
        'observe-if-watching',
      )
    }

    this.#remember(tokenHash, {
      userId: entitlement.userId,
      paidUntil: entitlement.paidUntil,
      checkedAt: now,
    })
    this.#allowed += 1
    return {
      allowed: true,
      userId: entitlement.userId,
      tokenHash,
      paidUntil: entitlement.paidUntil,
      cached: false,
    }
  }

  /**
   * Forget every cached answer for one account.
   *
   * Called by the store whenever an entitlement or a session changes, so a
   * refund, a sign-out or a downgrade takes effect on the next request instead
   * of up to a cache TTL later.
   *
   * @param userId - the account that changed.
   */
  invalidate(userId: string): void {
    for (const [hash, entry] of this.#cache) {
      if (entry.userId === userId) this.#cache.delete(hash)
    }
  }

  /**
   * Build a refusal, or let the request through.
   *
   * Three outcomes share this path because they all start as "this request
   * should not be here":
   *
   *   - `refuse` -- answer 401/402/403.
   *   - `policy` -- `allowUnaccounted` is on and the phone simply has no
   *     account. Allowed deliberately, not observed; there is nothing to fix.
   *   - `observe-if-watching` -- refuse in `enforce`, count and allow in
   *     `observe`.
   */
  #refuse(
    code: GateRefusalCode,
    status: 401 | 402 | 403,
    message: string,
    through: 'refuse' | 'policy' | 'observe-if-watching',
  ): GateDecision {
    const observing = through === 'observe-if-watching' && this.#mode === 'observe'
    if (through === 'policy' || observing) {
      if (observing) {
        this.#observed += 1
        this.#logThrottled(code, `gate: would refuse a request (${code}); allowing it through (observe mode)`)
      }
      return {
        allowed: true,
        userId: '',
        tokenHash: '',
        paidUntil: null,
        cached: false,
        ...(observing ? { observed: { status, code } } : {}),
      }
    }
    this.#refused += 1
    this.#logThrottled(code, `gate: refused a request (${code})`)
    return { allowed: false, status, code, message, cached: false }
  }

  /** Read the session token off the headers. */
  #tokenOf(headers: IncomingHttpHeaders): string | null {
    const raw = headers[SESSION_HEADER]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string') return null
    const token = value.trim()
    if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return null
    // A token is `mza_` + base64url. Anything else cannot be one of ours, and
    // rejecting it here keeps the hash map from being used as a probe.
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) return null
    return token
  }

  /** Store one allowance, evicting the oldest quarter when the cache is full. */
  #remember(tokenHash: string, entry: CacheEntry): void {
    // A zero TTL is an explicit "check every request"; caching anyway would grow
    // a map nothing ever reads.
    if (this.#cacheTtlMs === 0) return
    if (this.#cache.size >= this.#maxCacheEntries && !this.#cache.has(tokenHash)) {
      const drop = Math.ceil(this.#cache.size / 4)
      let index = 0
      for (const key of this.#cache.keys()) {
        if (index >= drop) break
        this.#cache.delete(key)
        index += 1
      }
    }
    this.#cache.set(tokenHash, entry)
  }

  /** Log one reason at most every {@link LOG_INTERVAL_MS}. */
  #logThrottled(reason: string, message: string): void {
    const now = this.#now()
    const last = this.#lastLogAt.get(reason) ?? 0
    if (now - last < LOG_INTERVAL_MS) return
    this.#lastLogAt.set(reason, now)
    this.#log(message)
  }
}
