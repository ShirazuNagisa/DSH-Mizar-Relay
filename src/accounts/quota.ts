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
  /**
   * Sustained bridged frames per minute per identity. `0` disables.
   *
   * Deliberately not part of the `abuse` config block: this is a circuit
   * breaker against a frame flood, not a product limit an operator tunes. A
   * bridged socket's frames are not requests and used to be priced as if they
   * were (see {@link DataQuota.carry}), which capped a whole conversation at
   * five frames a second. This bucket replaces that accident with a bound that
   * is far above anything a real socket emits -- twenty times the request rate
   * with a 600/min floor (6000/min at the usual 300) -- and far below what would
   * cost the relay meaningful CPU. It defaults to disabled when the request rate
   * is disabled, because "no rate limit" has to mean no rate limit.
   */
  readonly framesPerMinute?: number
  /** Burst allowance for the frame bucket; defaults to a tenth of the rate. */
  readonly frameBurst?: number
  /** Carried bytes allowed per identity per UTC day. `0` disables the budget. */
  readonly bytesPerDay: number
  /** Identity entries kept; the least recently used are evicted past this. */
  readonly maxEntries?: number
  /** Clock, injectable for tests. */
  readonly now?: () => number
  /** Where to report a spent budget, at most once an hour per identity. */
  readonly log?: (message: string) => void
  /**
   * Called once per identity/day when the byte budget is spent.
   *
   * The traffic ledger only sees bytes that were *carried*, and the meter
   * refuses the request that would cross the line -- so without this hook the
   * day the cap is hit would be the one day the warning policy never hears
   * about. The account relay turns this into a `quota` anomaly.
   */
  readonly onExhausted?: (identity: string, bytes: number, day: string) => void
}

/** One identity's counters. */
interface QuotaEntry {
  /** Request tokens left in the bucket. */
  tokens: number
  /** When the bucket was last refilled. */
  refilledAt: number
  /** Frame tokens left in the bucket. */
  frameTokens: number
  /** When the frame bucket was last refilled. */
  framesRefilledAt: number
  /** The UTC day the byte counters belong to. */
  day: string
  /** Bytes carried today. */
  bytes: number
  /** When this entry was last touched, for LRU eviction. */
  touchedAt: number
  /** When the spent-budget warning was last logged. */
  warnedAt: number
  /** The UTC day the exhaustion callback last fired. */
  exhaustedDay: string
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
  readonly #framesPerMinute: number
  readonly #frameBurst: number
  readonly #bytesPerDay: number
  readonly #maxEntries: number
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #onExhausted: ((identity: string, bytes: number, day: string) => void) | null
  readonly #entries = new Map<string, QuotaEntry>()
  #refusedRate = 0
  #refusedBudget = 0

  /**
   * @param options - the limits and the clock.
   */
  constructor(options: DataQuotaOptions) {
    this.#requestsPerMinute = Math.max(0, Math.floor(options.requestsPerMinute))
    // A bucket that cannot burst is a hard gate every 60/rate seconds, which
    // stalls a normal conversation's request/response pairs. Two seconds of
    // rate as the burst floor, a sixth of the rate as the default (50 for the
    // usual 300/min), keeps a launch burst -- the list, the titles, the stats,
    // the interactions -- from looking like a flood.
    this.#burst = Math.max(
      2,
      Math.floor(options.burst ?? Math.max(2, this.#requestsPerMinute / 6)),
    )
    // Twenty times the request rate with a 600/min floor, and off when the
    // request rate is off. A frame is much cheaper than a request (no tunnel
    // round trip), so its bound has to sit well above the request one; 6000/min
    // at the usual 300 is a hundred a second, which no real socket approaches
    // and which still costs the relay almost nothing if somebody tries. The
    // floor keeps a deliberately tight request limit from turning into a
    // silently tight frame limit.
    this.#framesPerMinute = Math.max(
      0,
      Math.floor(
        options.framesPerMinute ??
          (this.#requestsPerMinute === 0 ? 0 : Math.max(600, this.#requestsPerMinute * 20)),
      ),
    )
    this.#frameBurst = Math.max(
      10,
      Math.floor(options.frameBurst ?? Math.max(100, this.#framesPerMinute / 10)),
    )
    this.#bytesPerDay = Math.max(0, Math.floor(options.bytesPerDay))
    this.#maxEntries = Math.max(16, options.maxEntries ?? 20_000)
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => undefined)
    this.#onExhausted = options.onExhausted ?? null
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
        entry.exhaustedDay = ''
      }
      if (entry.bytes + bytes > this.#bytesPerDay) {
        this.#refusedBudget += 1
        this.#warnSpend(identity, entry, now)
        this.#noteExhausted(identity, entry, now)
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
   * Whether one WebSocket frame may carry `bytes`.
   *
   * A frame is not a request, and charging it one token from the request bucket
   * is what made a bridged phone socket look like a flood: with the default
   * 300/min and a burst of 50, a phone could put about five frames a second on
   * the wire, and every frame past that was dropped in silence (the socket
   * stayed up, so the request it belonged to waited out its full timeout). A
   * streamed turn alone emits more than that, and a bounded-parallel sync
   * multiplies it again -- the limiter, not the uplink, was the ceiling.
   *
   * So this checks a **separate, much higher** bucket (see
   * `DataQuotaOptions.framesPerMinute`) plus the day's bytes. The request bucket
   * keeps counting what it was built for: HTTP requests and socket upgrades,
   * each of which buys a tunnel round trip. The frame bucket is a circuit
   * breaker against a flood of tiny frames, not a product limit -- a real socket
   * does not approach it.
   *
   * @param identity - the traffic ledger's identity key.
   * @param bytes - payload bytes about to be carried.
   * @returns the decision. `rate` means the frame flood breaker tripped;
   *   `budget` means the day's bytes are spent.
   */
  carry(identity: string, bytes = 0): QuotaDecision {
    if (identity === '') return { allowed: true }
    if (this.#framesPerMinute === 0 && this.#bytesPerDay === 0) return { allowed: true }

    const now = this.#now()
    const entry = this.#entry(identity, now)

    if (this.#framesPerMinute > 0) {
      this.#refillFrames(entry, now)
      if (entry.frameTokens < 1) {
        this.#refusedRate += 1
        return {
          allowed: false,
          reason: 'rate',
          retryAfterSeconds: this.#frameRetryAfter(entry, now),
        }
      }
      entry.frameTokens -= 1
    }

    if (this.#bytesPerDay === 0) {
      entry.touchedAt = now
      return { allowed: true }
    }

    const day = dayKey(now)
    if (entry.day !== day) {
      entry.day = day
      entry.bytes = 0
      entry.warnedAt = 0
      entry.exhaustedDay = ''
    }
    if (entry.bytes + bytes > this.#bytesPerDay) {
      this.#refusedBudget += 1
      this.#warnSpend(identity, entry, now)
      this.#noteExhausted(identity, entry, now)
      return {
        allowed: false,
        reason: 'budget',
        retryAfterSeconds: secondsUntilNextDay(now),
      }
    }
    entry.bytes += bytes
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
      entry.exhaustedDay = ''
    }
    entry.bytes += Math.floor(bytes)
    entry.touchedAt = now
    if (entry.bytes > this.#bytesPerDay) {
      this.#warnSpend(identity, entry, now)
      this.#noteExhausted(identity, entry, now)
    }
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
      frameTokens: this.#frameBurst,
      framesRefilledAt: now,
      day: dayKey(now),
      bytes: 0,
      touchedAt: now,
      warnedAt: 0,
      exhaustedDay: '',
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

  /** Refill the frame bucket for the elapsed time. */
  #refillFrames(entry: QuotaEntry, now: number): void {
    const perMs = this.#framesPerMinute / 60_000
    const elapsed = Math.max(0, now - entry.framesRefilledAt)
    entry.frameTokens = Math.min(this.#frameBurst, entry.frameTokens + elapsed * perMs)
    entry.framesRefilledAt = now
  }

  /** Seconds until one frame token exists, capped like the request one. */
  #frameRetryAfter(entry: QuotaEntry, now: number): number {
    const perMs = this.#framesPerMinute / 60_000
    if (perMs <= 0) return MAX_RETRY_AFTER_SECONDS
    const deficit = 1 - entry.frameTokens
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

  /** Tell the policy once per identity/day that the budget is gone. */
  #noteExhausted(identity: string, entry: QuotaEntry, now: number): void {
    const day = dayKey(now)
    if (entry.exhaustedDay === day) return
    entry.exhaustedDay = day
    try {
      this.#onExhausted?.(identity, entry.bytes, day)
    } catch {
      // A policy that throws must not refuse a request twice.
    }
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
