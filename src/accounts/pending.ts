/**
 * The two short-lived things a GitHub sign-in needs.
 *
 * A **state** ties the browser round trip to the phone that started it, and
 * carries the device so the callback does not have to trust anything the
 * browser says. A **handoff** is what the browser is allowed to see: a
 * five-minute, single-use code that buys exactly one session exchange. Neither
 * is persisted — losing them on restart costs one retry, while writing device
 * fingerprints into `accounts.json` would cost privacy for no benefit.
 *
 * @module dsh-mizar-relay/accounts/pending
 */
import { createHash, randomBytes } from 'node:crypto'
import { AccountError, type DeviceInput } from './types.js'

/** How long a started flow may wait for the operator to approve it. */
const FLOW_TTL_MS = 10 * 60_000

/** How long the landing page's code may be exchanged. */
const HANDOFF_TTL_MS = 5 * 60_000

/** The most flows kept at once; beyond this the oldest is dropped. */
const MAX_FLOWS = 2_000

/** A handoff is 40 bits; five wrong devices retire it rather than allow a scan. */
const MAX_FAILURES = 5

/** The alphabet invite codes use: no I, L, O or U, so it can be read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** One started flow: who it resolves to, and when it stops being usable. */
interface PendingFlow {
  readonly device: DeviceInput
  readonly userId: string
  readonly token: string
  readonly expiresAt: number
}

/** One issued handoff code, keyed by its hash. */
interface PendingHandoff {
  readonly token: string
  readonly deviceId: string
  readonly expiresAt: number
  /** Wrong-device attempts, counted so a guesser cannot keep trying. */
  failures: number
}

/** A random state, long enough that guessing is not a strategy. */
export function newState(): string {
  return randomBytes(32).toString('base64url')
}

/** A readable, single-use handoff code. */
export function newHandoff(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]!
  return `MZ-${out.slice(0, 4)}-${out.slice(4, 8)}`
}

/** The key a handoff is stored under. */
export function hashHandoff(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex')
}

/** The in-memory store for both. */
export class PendingGithubFlows {
  readonly #flows = new Map<string, PendingFlow>()
  readonly #handoffs = new Map<string, PendingHandoff>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Remember a flow and return its state. */
  begin(device: DeviceInput, userId: string, token: string): { state: string; expiresAt: number } {
    this.#sweep()
    const state = newState()
    const expiresAt = this.#now() + FLOW_TTL_MS
    this.#flows.set(state, { device, userId, token, expiresAt })
    while (this.#flows.size > MAX_FLOWS) {
      const oldest = this.#flows.keys().next().value
      if (typeof oldest !== 'string') break
      this.#flows.delete(oldest)
    }
    return { state, expiresAt }
  }

  /** Consume a state. A state is good exactly once. */
  take(state: string): PendingFlow {
    const flow = this.#flows.get(state)
    if (flow === undefined) {
      throw new AccountError('GITHUB_STATE_INVALID', 'this sign-in did not start here', 400)
    }
    this.#flows.delete(state)
    if (flow.expiresAt <= this.#now()) {
      throw new AccountError('GITHUB_STATE_EXPIRED', 'this sign-in took too long; start again', 400)
    }
    return flow
  }

  /** Issue a handoff for one session, bound to the device that started the flow. */
  issue(token: string, deviceId: string): string {
    this.#sweep()
    const code = newHandoff()
    this.#handoffs.set(hashHandoff(code), {
      token,
      deviceId,
      expiresAt: this.#now() + HANDOFF_TTL_MS,
      failures: 0,
    })
    return code
  }

  /** Trade a handoff for its session. Single use, and only on the same device. */
  redeem(code: string, deviceId: string): PendingHandoff {
    const key = hashHandoff(code)
    const record = this.#handoffs.get(key)
    if (record === undefined) {
      throw new AccountError('GITHUB_HANDOFF_INVALID', 'that sign-in code is not valid', 400)
    }
    if (record.expiresAt <= this.#now()) {
      this.#handoffs.delete(key)
      throw new AccountError('GITHUB_HANDOFF_EXPIRED', 'that sign-in code has expired; start again', 400)
    }
    if (record.deviceId !== deviceId) {
      record.failures += 1
      if (record.failures >= MAX_FAILURES) this.#handoffs.delete(key)
      throw new AccountError('GITHUB_DEVICE_MISMATCH', 'finish signing in on the phone that started it', 400)
    }
    this.#handoffs.delete(key)
    return record
  }

  /** Drop everything that has expired. */
  #sweep(): void {
    const now = this.#now()
    for (const [key, flow] of this.#flows) if (flow.expiresAt <= now) this.#flows.delete(key)
    for (const [key, handoff] of this.#handoffs) if (handoff.expiresAt <= now) this.#handoffs.delete(key)
  }
}
