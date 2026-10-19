/**
 * A small in-memory sliding-window rate limiter.
 *
 * Registration, login, invite redemption, and admin login all need one. A Map
 * of timestamps per key is enough for a single-process relay and has no
 * dependency; the sweep is what keeps a scanner from turning unique keys into
 * memory growth.
 *
 * @module dsh-mizar-relay/accounts/rate
 */
export class RateWindow {
  readonly #limit: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #hits = new Map<string, number[]>()
  #lastSweep = 0

  /**
   * @param limit - requests allowed per window.
   * @param windowMs - window length.
   * @param now - clock, injectable.
   */
  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = Math.max(1, limit)
    this.#windowMs = Math.max(1, windowMs)
    this.#now = now
  }

  /**
   * Record one hit.
   *
   * @param key - the bucket (IP, identifier, ...).
   * @returns whether the hit is allowed.
   */
  check(key: string): boolean {
    const now = this.#now()
    this.#sweep(now)
    const window = this.#hits.get(key) ?? []
    const cutoff = now - this.#windowMs
    while (window.length > 0 && (window[0] ?? now) <= cutoff) window.shift()
    if (window.length >= this.#limit) {
      this.#hits.set(key, window)
      return false
    }
    window.push(now)
    this.#hits.set(key, window)
    return true
  }

  /** Seconds until the key may try again, for a `Retry-After` header. */
  retryAfterSeconds(key: string): number {
    const window = this.#hits.get(key)
    if (window === undefined || window.length === 0) return 0
    const oldest = window[0] ?? this.#now()
    return Math.max(1, Math.ceil((oldest + this.#windowMs - this.#now()) / 1000))
  }

  /** Forget every hit for one key, used after a successful login. */
  clear(key: string): void {
    this.#hits.delete(key)
  }

  /** Forget expired keys periodically. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < 60_000) return
    this.#lastSweep = now
    const cutoff = now - this.#windowMs
    for (const [key, window] of this.#hits) {
      while (window.length > 0 && (window[0] ?? now) <= cutoff) window.shift()
      if (window.length === 0) this.#hits.delete(key)
    }
  }
}
