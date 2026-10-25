/**
 * The rate limits that stand between a UDP responder and a reflector.
 *
 * Every UDP service here has the same shape: a datagram arrives with a source
 * address that may be forged, and an answer goes back to that address. Without
 * a limit, anyone can point the relay at a victim and multiply their bandwidth
 * by the ratio of reply size to request size. The relay has two such services —
 * the diagnostic probe and the STUN responder — and both are small enough that
 * the interesting question is not throughput but whether the guard is correct,
 * so it lives in one place and is tested once.
 *
 * Two buckets, because one is not enough. The per-source bucket keeps an
 * ordinary peer from hammering; the global bucket is what a distributed spoof
 * cannot walk past, since it is charged before the source is even consulted.
 * Both refill by wall-clock rather than counting inside a window, so a steady
 * trickle at the limit is served and a flood is shed instead of queued — a
 * queue here would only turn a burst into latency.
 */

/** How many replies the guard will allow. */
export interface UdpGuardLimits {
  /** Replies per second across every source. */
  readonly repliesPerSecond: number
  /** Replies per second for one source address. */
  readonly repliesPerSecondPerSource: number
}

/** The addresses remembered individually before the table is dropped. */
const MAX_TRACKED_SOURCES = 10_000

/**
 * A token bucket per source, and one for the whole socket.
 *
 * Not a rate limiter in the queuing sense: `allow` answers immediately, and a
 * `false` means the datagram is dropped, not delayed. Dropping is right for
 * both services — a probe or a binding request that did not get an answer
 * within its own timeout is retried by the peer, and a peer that retries too
 * fast is the case this exists to stop.
 */
export class UdpGuard {
  private readonly limits: UdpGuardLimits
  private readonly perSource = new Map<string, number>()
  private globalTokens: number
  private lastRefill: number

  /**
   * @param limits - the two caps.
   * @param now - the clock, injectable so a test can advance time instead of sleeping.
   */
  constructor(limits: UdpGuardLimits, private readonly now: () => number = Date.now) {
    this.limits = limits
    this.globalTokens = limits.repliesPerSecond
    this.lastRefill = now()
  }

  /**
   * Charge one reply against both buckets.
   *
   * @param source - the datagram's source address, forged or not.
   * @returns whether the reply may be sent.
   */
  allow(source: string): boolean {
    this.refill()
    // The global bucket is checked first so a single spoofed source cannot
    // exhaust it against one victim and starve every real peer at once.
    if (this.globalTokens < 1) return false
    const available = this.perSource.get(source) ?? this.limits.repliesPerSecondPerSource
    if (available < 1) return false
    this.globalTokens -= 1
    this.perSource.set(source, available - 1)
    return true
  }

  /** The number of sources currently tracked individually; for tests. */
  get trackedSources(): number {
    return this.perSource.size
  }

  private refill(): void {
    const now = this.now()
    const elapsedMs = Math.max(0, now - this.lastRefill)
    this.lastRefill = now
    const seconds = elapsedMs / 1000
    if (seconds > 0) {
      this.globalTokens = Math.min(
        this.limits.repliesPerSecond,
        this.globalTokens + seconds * this.limits.repliesPerSecond,
      )
    }
    // A table that grows without bound is its own denial of service: a spoofed
    // flood would allocate an entry per forged address. Clearing wholesale
    // rather than evicting one at a time is deliberate — the cost of a reset is
    // that a few honest peers get their per-source allowance back early, and
    // the global bucket still bounds the total.
    if (this.perSource.size > MAX_TRACKED_SOURCES) this.perSource.clear()
    for (const [address, tokens] of this.perSource) {
      const next = Math.min(
        this.limits.repliesPerSecondPerSource,
        tokens + seconds * this.limits.repliesPerSecondPerSource,
      )
      // Dropping entries that are back at full is what keeps this table small
      // in the ordinary case: a peer that behaved is forgotten.
      if (next >= this.limits.repliesPerSecondPerSource) this.perSource.delete(address)
      else this.perSource.set(address, next)
    }
  }
}
