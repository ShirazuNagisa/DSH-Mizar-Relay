/**
 * Data-plane quota: how much of this relay's bandwidth one identity may use.
 *
 * Every other limit in the relay bounds a *resource* -- four tunnels per
 * address, eight phones per room, four mebibytes per body. None of them answers
 * "how many bytes may this caller push through my uplink per day", which is the
 * question an operator actually cares about when a paid account is resold, a
 * pairing code leaks, or a botnet walks through open registration. Without it a
 * single account (or a single `guest:` id, which is client-supplied and free to
 * invent) can saturate the relay for as long as it likes, and the traffic ledger
 * will faithfully record every byte of the theft.
 *
 * This module is the missing meter. Two limits, both per identity, both cheap:
 *
 *   - **A request rate** -- a token bucket refilled continuously, so a caller
 *     can burst a little and is then paced. This is what stops a flood of tiny
 *     requests; each one costs a map lookup and a tunnel round trip even when
 *     the payload is empty.
 *   - **A byte budget** -- a per-UTC-day allowance of carried bytes, in the same
 *     day buckets the traffic ledger uses so the two agree. This is what stops
 *     sustained large transfers; a caller that has spent its day is refused until
 *     the day turns over.
 *
 * Both are enforced *before* the bytes move, so an over-quota caller costs the
 * relay a map lookup rather than a megabyte. The design leans on three
 * properties worth stating because they are the reason it is written this way:
 *
 *   - **Identity-keyed, not address-keyed.** The paid gate already resolved the
 *     request to an account hash that cannot be spoofed; keying the quota on
 *     that (rather than on the peer address) means an attacker cannot get a
 *     fresh budget per request by rotating `X-Forwarded-For`, and a legitimate
 *     phone moving between networks does not lose its budget. When no account
 *     is behind a request the identity falls back to `guest:`/`anon:` exactly as
 *     the traffic ledger buckets it.
 *   - **Bounded memory.** The map is capped and evicts the least-recently-used
 *     entry, so a client-id flood cannot turn a rate limit into an OOM.
 *   - **No dependency, no I/O.** It is a map of counters; the request path never
 *     waits on it.
 *
 * What it is *not* is authentication or billing. It does not decide who may use
 * the relay -- the paid gate does -- and it does not charge anybody. It is the
 * seat-belt between the two: even a paying account cannot eat the whole uplink.
 *
 * @module dsh-mizar-relay/accounts/quota
 */

/** The decision one admission check returns. */
export interface QuotaDecision {
  readonly allowed: boolean
  /** Why a refusal happened, for the log and the phone. */
  readonly reason?: 'rate' | 'budget'
  /** Seconds until the next attempt could succeed, for `Retry-After`. */
  readonly retryAfterSeconds?: number
}

/** What the quota enforces. */
export interface DataQuotaOptions {
  /** Sustained requests per minute per identity. `0` disables the rate limit. */
  readonly requestsPerMinute: number
  /** Burst allowance for the request bucket; defaults to a small multiple of the rate. */
  readonly burst?: number
  /** Carried bytes allowed per identity per UTC day. `0` disables the budget. */
  readonly bytesPerDay: number
  /** Identity entries kept; the least recently used are evicted past this. */
  readonly maxEntries?: number
  /** Clock, injectable for tests. */
  readonly now?: () => number
  /** Where to report a spent budget, at most once an hour per identity. */
  readonly log?: (message: string) => void
}

/** One identity's counters. */
interface QuotaEntry {
  /** Request tokens left in the bucket. */
  tokens: number
  /** When the bucket was last refilled. */
  refilledAt: number
  /** The UTC day the byte counters belong to. */
  day: string
  /** Bytes carried today. */
  bytes: number
  /** When this entry was last touched, for LRU eviction. */
  touchedAt: number
  /** When the spent-budget warning was last logged. */
  warnedAt: number
}

/** Longest a `Retry-After` is ever advertised. */
const MAX_RETRY_AFTER_SECONDS = 3600

/**
 * The data-plane quota.
 *
 * One instance per relay. Both limits are per identity and independent: a
 * caller can exhaust either one and be refused until it recovers.
 */
export class DataQuota {
  readonly #requestsPerMinute: number
  readonly #burst: number
  readonly #bytesPerDay: number
  readonly #maxEntries: number
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #entries = new Map<string, QuotaEntry>()
  #refusedRate = 0
  #refusedBudget = 0

  /**
   * @param options - the limits and the clock.
   */
  constructor(options: DataQuotaOptions) {
    this.#requestsPerMinute = Math.max(0, Math.floor(options.requestsPerMinute))
    // A bucket that cannot burst is a hard gate every 60/rate seconds, which
    // stalls a normal conversation's request/response pairs. One second of rate
    // as the burst floor, twice the rate as the default, keeps ordinary traffic
    // smooth while still bounding a flood.
    this.#burst = Math.max(
      1,
      Math.floor(options.burst ?? Math.max(2, (this.#requestsPerMinute * 2) / 60)),
    )
    this.#bytesPerDay = Math.max(0, Math.floor(options.bytesPerDay))
    this.#maxEntries = Math.max(16, options.maxEntries ?? 20_000)
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => undefined)
  }

  /** Counters for `/healthz` and the admin pages. */
  get stats(): {
    readonly entries: number
    readonly refusedRate: number
    readonly refusedBudget: number
  } {
    return {
      entries: this.#entries.size,
      refusedRate: this.#refusedRate,
      refusedBudget: this.#refusedBudget,
    }
  }

  /**
   * Whether this identity may spend `bytes` more of its allowance.
   *
   * Charges both limits and reports the first one that is spent. The request
   * bucket is charged one token per call regardless of `bytes`; the byte budget
   * is charged the carried size. Passing `bytes = 0` checks the rate only, which
   * is what a WebSocket upgrade does -- it is one request whose frames are then
   * charged individually.
   *
   * @param identity - the traffic ledger's identity key.
   * @param bytes - payload bytes about to be carried, `0` for a bare request.
   * @returns the decision.
   */
  admit(identity: string, bytes = 0): QuotaDecision {
    if (identity === '') return { allowed: true }
    const disabled = this.#requestsPerMinute === 0 && this.#bytesPerDay === 0
    if (disabled) return { allowed: true }

    const now = this.#now()
    const entry = this.#entry(identity, now)

    // 1. The request rate. Refilled continuously rather than on a fixed window,
    //    so a caller is paced smoothly instead of being blocked for the rest of
    //    a window after one burst.
    if (this.#requestsPerMinute > 0) {
      this.#refill(entry, now)
      if (entry.tokens < 1) {
        this.#refusedRate += 1
        return {
          allowed: false,
          reason: 'rate',
          retryAfterSeconds: this.#retryAfter(entry, now),
        }
      }
      entry.tokens -= 1
    }

    // 2. The byte budget, charged for the carried size. Checked before the move
    //    so an over-budget caller costs a lookup, not a megabyte.
    if (this.#bytesPerDay > 0) {
      const day = dayKey(now)
      if (entry.day !== day) {
        // The day turned over: the allowance is fresh. Cheap to do lazily here
        // rather than on a timer, and an idle identity never needs it.
        entry.day = day
        entry.bytes = 0
        entry.warnedAt = 0
      }
      if (entry.bytes + bytes > this.#bytesPerDay) {
        this.#refusedBudget += 1
        this.#warnSpend(identity, entry, now)
        return {
          allowed: false,
          reason: 'budget',
          retryAfterSeconds: secondsUntilNextDay(now),
        }
      }
      entry.bytes += bytes
    }

    entry.touchedAt = now
    return { allowed: true }
  }

  /**
   * Account bytes already carried, without spending a request token.
   *
   * For the case where the size is only known after the fact -- an HTTP answer
   * whose body the relay measured on the way through. The budget still refuses
   * the *next* request once it is spent; nothing already sent is recalled.
   *
   * @param identity - the traffic ledger's identity key.
   * @param bytes - payload bytes carried.
   */
  charge(identity: string, bytes: number): void {
    if (identity === '' || this.#bytesPerDay === 0 || bytes <= 0) return
    const now = this.#now()
    const entry = this.#entry(identity, now)
    const day = dayKey(now)
    if (entry.day !== day) {
      entry.day = day
      entry.bytes = 0
      entry.warnedAt = 0
    }
    entry.bytes += Math.floor(bytes)
    entry.touchedAt = now
    if (entry.bytes > this.#bytesPerDay) this.#warnSpend(identity, entry, now)
  }

  /** Forget one identity, used when an account is deleted. */
  forget(identity: string): void {
    this.#entries.delete(identity)
  }

  /** Forget everything. */
  clear(): void {
    this.#entries.clear()
  }

  /** Get or create one identity's counters, evicting LRU entries when full. */
  #entry(identity: string, now: number): QuotaEntry {
    const existing = this.#entries.get(identity)
    if (existing !== undefined) {
      existing.touchedAt = now
      return existing
    }
    if (this.#entries.size >= this.#maxEntries) {
      // Evict the least recently used quarter rather than one entry at a time:
      // the churn is amortized and a flood of new ids cannot walk the map.
      const drop = Math.ceil(this.#entries.size / 4)
      let index = 0
      for (const key of this.#lruOrder()) {
        if (index >= drop) break
        this.#entries.delete(key)
        index += 1
      }
    }
    const entry: QuotaEntry = {
      tokens: this.#burst,
      refilledAt: now,
      day: dayKey(now),
      bytes: 0,
      touchedAt: now,
      warnedAt: 0,
    }
    this.#entries.set(identity, entry)
    return entry
  }

  /** Entry keys ordered least-recently-used first. */
  *#lruOrder(): Generator<string> {
    const sorted = [...this.#entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    for (const [key] of sorted) yield key
  }

  /** Refill one bucket for the elapsed time. */
  #refill(entry: QuotaEntry, now: number): void {
    const perMs = this.#requestsPerMinute / 60_000
    const elapsed = Math.max(0, now - entry.refilledAt)
    entry.tokens = Math.min(this.#burst, entry.tokens + elapsed * perMs)
    entry.refilledAt = now
  }

  /** Seconds until one token exists, capped so the header stays sane. */
  #retryAfter(entry: QuotaEntry, now: number): number {
    const perMs = this.#requestsPerMinute / 60_000
    if (perMs <= 0) return MAX_RETRY_AFTER_SECONDS
    const deficit = 1 - entry.tokens
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(deficit / perMs / 1000)))
  }

  /** Log a spent budget at most once an hour per identity. */
  #warnSpend(identity: string, entry: QuotaEntry, now: number): void {
    if (now - entry.warnedAt < 3_600_000) return
    entry.warnedAt = now
    const label = identity.length > 24 ? `${identity.slice(0, 24)}…` : identity
    this.#log(
      `quota: ${label} spent its ${Math.round(this.#bytesPerDay / (1024 * 1024))}MiB daily budget ` +
        `(${Math.round(entry.bytes / (1024 * 1024))}MiB); further requests are refused until the day turns over`,
    )
  }
}

/** The UTC day key, matching the traffic ledger's. */
function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/** Seconds from now until the next UTC midnight. */
function secondsUntilNextDay(now: number): number {
  const next = Date.parse(`${dayKey(now)}T00:00:00Z`) + 86_400_000
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil((next - now) / 1000)))
}
