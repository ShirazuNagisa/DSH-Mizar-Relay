/**
 * The data-plane quota: the meter between "records every byte of a theft" and
 * "refuses the theft as it happens".
 *
 * What is worth asserting is not that a counter increments -- it is the three
 * properties that decide whether the meter actually stops an abuse:
 *
 *   - an identity that spends its day is refused until the day turns over,
 *   - a request flood is paced rather than served,
 *   - a flood of *different* identities cannot grow the map without bound.
 *
 * @module dsh-mizar-relay/test/quota
 */
import { describe, expect, it } from 'vitest'
import { DataQuota } from '../src/accounts/quota.js'

const ID = 'account:' + 'a'.repeat(64)
const DAY = 86_400_000

describe('the request rate', () => {
  it('paces a caller instead of serving an unbounded flood', () => {
    // A clock the test drives by hand, so "a minute later" is exact.
    let now = Date.parse('2026-10-20T12:00:00Z')
    const quota = new DataQuota({
      requestsPerMinute: 60,
      burst: 2,
      bytesPerDay: 0,
      now: () => now,
    })
    // The burst is served immediately: a conversation's request/response pairs
    // must not stall behind a rate limiter.
    expect(quota.admit(ID).allowed).toBe(true)
    expect(quota.admit(ID).allowed).toBe(true)
    // Past the burst the caller is refused, and told how long to wait.
    const refused = quota.admit(ID)
    expect(refused.allowed).toBe(false)
    expect(refused.reason).toBe('rate')
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    // A minute later the bucket has refilled.
    now += 60_000
    expect(quota.admit(ID).allowed).toBe(true)
  })

  it('counts a fresh identity separately', () => {
    // `burst` has a floor of two requests (see `DataQuota`), so a fresh
    // identity is served twice and paced from the third request on.
    const quota = new DataQuota({ requestsPerMinute: 1, burst: 2, bytesPerDay: 0 })
    expect(quota.admit(ID).allowed).toBe(true)
    expect(quota.admit(ID).allowed).toBe(true)
    expect(quota.admit(ID).allowed).toBe(false)
    // Another account has its own budget; the limit is per identity, not global.
    expect(quota.admit('account:' + 'b'.repeat(64)).allowed).toBe(true)
  })
})

describe('the byte budget', () => {
  it('refuses a caller that has spent its day, and forgives it tomorrow', () => {
    let now = Date.parse('2026-10-20T12:00:00Z')
    const quota = new DataQuota({
      requestsPerMinute: 0,
      bytesPerDay: 1000,
      now: () => now,
    })
    expect(quota.admit(ID, 600).allowed).toBe(true)
    expect(quota.admit(ID, 400).allowed).toBe(true)
    // The day's allowance is exactly spent.
    const over = quota.admit(ID, 1)
    expect(over.allowed).toBe(false)
    expect(over.reason).toBe('budget')
    // The next UTC day restores it.
    now += DAY
    expect(quota.admit(ID, 600).allowed).toBe(true)
  })

  it('charges bytes delivered after the fact, and refuses the next request', () => {
    let now = Date.parse('2026-10-20T12:00:00Z')
    const quota = new DataQuota({
      requestsPerMinute: 0,
      bytesPerDay: 1000,
      now: () => now,
    })
    // An HTTP answer whose size is only known once it has been carried.
    quota.charge(ID, 1500)
    const next = quota.admit(ID, 1)
    expect(next.allowed).toBe(false)
    expect(next.reason).toBe('budget')
  })

  it('keeps identities on separate budgets', () => {
    const quota = new DataQuota({ requestsPerMinute: 0, bytesPerDay: 1000 })
    quota.charge(ID, 5000)
    // One account exhausting its day does not spend another's.
    expect(quota.admit(ID, 1).allowed).toBe(false)
    expect(quota.admit('account:' + 'c'.repeat(64), 1).allowed).toBe(true)
  })
})

describe('its memory', () => {
  it('evicts least-recently-used identities rather than growing forever', () => {
    let now = Date.parse('2026-10-20T12:00:00Z')
    const quota = new DataQuota({
      requestsPerMinute: 600,
      burst: 2,
      bytesPerDay: 0,
      maxEntries: 16,
      now: () => now,
    })
    // A client-id flood: more distinct identities than the map is allowed to
    // hold. Each advances the clock so the eviction order is unambiguous.
    for (let index = 0; index < 200; index += 1) {
      now += 1
      quota.admit(`guest:device-${index}`)
    }
    // The cap is respected -- the map holds at most the bound plus the quarter
    // evicted in one pass, and never the number of ids the flood created.
    expect(quota.stats.entries).toBeLessThanOrEqual(16 + 4)
  })
})

describe('a disabled quota', () => {
  it('lets everything through when both limits are zero', () => {
    // `0` is the deliberate way to turn a limit off; it must mean "no limit",
    // not "nothing is allowed".
    const quota = new DataQuota({ requestsPerMinute: 0, bytesPerDay: 0 })
    for (let index = 0; index < 50; index += 1) {
      expect(quota.admit(ID, 10_000).allowed).toBe(true)
    }
  })
})
