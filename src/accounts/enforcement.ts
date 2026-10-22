/**
 * The traffic policy: warn, then ban, then mail the person about both.
 *
 * The rule, as the operator stated it:
 *
 *   - at most one warning per person per 15 minutes;
 *   - at most three warnings inside a trailing 30-day window;
 *   - the next anomaly inside that window bans the account;
 *   - a window that has aged out starts again at one;
 *   - a ban is emailed, and an unban clears the warnings.
 *
 * One warning per UTC day is the ledger's own granularity: hitting the ceiling
 * and then hitting it again ten seconds later is one day's worth of trouble, not
 * two. The 15-minute rule is a second guard for a burst that arrives through
 * different sessions.
 *
 * @module dsh-mizar-relay/accounts/enforcement
 */
import type { MailClient } from '../mail/client.js'
import type { AccountStore } from './store.js'
import type { TrafficWarning } from './types.js'

/** One anomaly, as the ledger or the quota reports it. */
export interface EnforcementAnomaly {
  /** `account:<sha256(token)>`. */
  readonly identity: string
  /** UTC day, `YYYY-MM-DD`. */
  readonly day: string
  readonly bytes: number
  readonly reason: TrafficWarning['reason']
}

/** What the policy needs. */
export interface EnforcementOptions {
  readonly store: AccountStore
  /** `null` when this relay cannot mail; the decision is still recorded. */
  readonly mail: MailClient | null
  /** Printed in the ban mail and shown by the phone. */
  readonly contact: string
  readonly now?: () => number
  readonly log?: (message: string) => void
}

/** Warnings allowed inside the window. */
export const MAX_WARNINGS = 3

/** How long a warning counts. */
export const WARNING_WINDOW_MS = 30 * 86_400_000

/** How close two warnings may be. */
export const WARNING_INTERVAL_MS = 15 * 60_000

/** The policy. */
export class Enforcement {
  readonly #store: AccountStore
  readonly #mail: MailClient | null
  readonly #contact: string
  readonly #now: () => number
  readonly #log: (message: string) => void
  /** Serializes decisions so two anomalies cannot both read "two warnings". */
  #chain: Promise<void> = Promise.resolve()

  constructor(options: EnforcementOptions) {
    this.#store = options.store
    this.#mail = options.mail
    this.#contact = options.contact
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => undefined)
  }

  /**
   * Consider one anomaly.
   *
   * Fire-and-forget on purpose: it runs after the bytes have moved, and a slow
   * decision must never delay a conversation.
   *
   * @param anomaly - what the meter noticed.
   */
  observe(anomaly: EnforcementAnomaly): void {
    this.#chain = this.#chain
      .then(() => this.#decide(anomaly))
      .catch((error: unknown) => {
        this.#log(`enforcement: ${anomaly.identity.slice(0, 20)}… failed: ${String(error)}`)
      })
  }

  /** Wait for every queued decision, for tests and shutdown. */
  async settle(): Promise<void> {
    await this.#chain
  }

  /** The decision itself. */
  async #decide(anomaly: EnforcementAnomaly): Promise<void> {
    if (!anomaly.identity.startsWith('account:')) return
    const hash = anomaly.identity.slice('account:'.length)
    const user = this.#store.findUserBySessionHash(hash)
    if (user === undefined) {
      // A session that was revoked between the byte and the decision; there is
      // nobody to warn.
      return
    }
    if (user.disabled) return
    const now = this.#now()
    const warnings = this.#store.warningsFor(user)
    // One decision per UTC day, whichever meter noticed first.
    if (warnings.some((entry) => entry.day === anomaly.day)) return
    const last = warnings[warnings.length - 1]
    if (last !== undefined && now - last.at < WARNING_INTERVAL_MS) {
      this.#log(`enforcement: suppressed a warning for ${user.username} (within 15 minutes of the last one)`)
      return
    }

    if (warnings.length >= MAX_WARNINGS) {
      await this.#store.banUser(user.id, { reason: anomaly.reason, bytes: anomaly.bytes })
      this.#log(
        `enforcement: BANNED ${user.username} after ${warnings.length} warnings; ` +
          `${formatBytes(anomaly.bytes)} on ${anomaly.day}`,
      )
      await this.#mailBan(user.email, user.emailVerified)
      return
    }

    const count = await this.#store.addWarning(user.id, {
      at: now,
      day: anomaly.day,
      bytes: anomaly.bytes,
      reason: anomaly.reason,
    })
    this.#log(
      `enforcement: warning ${count}/${MAX_WARNINGS} for ${user.username}; ` +
        `${formatBytes(anomaly.bytes)} on ${anomaly.day}`,
    )
    if (user.email !== null && user.emailVerified && this.#mail !== null) {
      try {
        await this.#mail.sendWarning(user.email, {
          day: anomaly.day,
          bytes: formatBytes(anomaly.bytes),
          count,
        })
      } catch (error) {
        // The warning is recorded; the mail is retried by the service queue only
        // if it was accepted. A service that is down is logged and left there.
        this.#log(`enforcement: warning mail failed for ${user.username}: ${(error as Error).message}`)
      }
    }
  }

  /** Send the ban mail, when the account has a proved address. */
  async #mailBan(email: string | null, verified: boolean): Promise<void> {
    if (this.#mail === null || email === null || !verified) return
    try {
      await this.#mail.sendBanned(email, this.#contact)
    } catch (error) {
      this.#log(`enforcement: ban mail failed: ${(error as Error).message}`)
    }
  }
}

/** Bytes as a person reads them. */
export function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024)
  if (mib < 1024) return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`
  return `${(mib / 1024).toFixed(1)} GB`
}
