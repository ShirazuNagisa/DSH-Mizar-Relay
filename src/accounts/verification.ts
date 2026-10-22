/**
 * Six-digit codes for registration and password reset.
 *
 * A code is stored as an HMAC, never as itself: `verifications.json` is a file
 * an operator may have to inspect, and a file full of live codes is a file full
 * of passwords. The HMAC is keyed by the account relay's internal secret and
 * bound to the address and the purpose, so a code for `a@x` cannot be replayed
 * for `b@x` or for a password reset.
 *
 * @module dsh-mizar-relay/accounts/verification
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { ensurePrivateDir, readJsonFile, writeJsonAtomic } from './state.js'
import { AccountError } from './types.js'

/** What a code is for. */
export type VerificationPurpose = 'register' | 'reset'

/** How long a code lives. */
const TTL_MS = 10 * 60_000

/** How many wrong guesses a code survives. */
const MAX_ATTEMPTS = 5

/** How long between two sends to the same address. */
const COOLDOWN_MS = 60_000

/** How many codes one address may request per hour. */
const PER_EMAIL_PER_HOUR = 5

/** Records kept; a flood of addresses must not grow the file forever. */
const MAX_RECORDS = 5_000

/** One stored code. */
interface CodeRecord {
  readonly key: string
  readonly purpose: VerificationPurpose
  readonly emailKey: string
  codeHash: string
  createdAt: number
  expiresAt: number
  attempts: number
  lastSentAt: number
  sends: number[]
}

/** The persisted file. */
interface VerificationFile {
  version: 1
  records: CodeRecord[]
}

/** What the issuer needs. */
export interface VerificationOptions {
  readonly dataDir: string
  /** HMAC key; the account relay's `internalSecret` is the intended value. */
  readonly secret: string
  readonly now?: () => number
  readonly log?: (message: string) => void
}

/** One issued code. */
export interface IssuedCode {
  readonly code: string
  readonly expiresAt: number
  readonly resendAfterSeconds: number
}

/** The code store. */
export class VerificationCodes {
  readonly #path: string
  readonly #secret: string
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #records = new Map<string, CodeRecord>()

  private constructor(options: VerificationOptions) {
    if (options.secret === '') {
      throw new Error('verification codes need a non-empty HMAC secret')
    }
    this.#path = join(options.dataDir, 'verifications.json')
    this.#secret = options.secret
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => undefined)
  }

  /** Open the store, loading anything left from the last process. */
  static async open(options: VerificationOptions): Promise<VerificationCodes> {
    const store = new VerificationCodes(options)
    await ensurePrivateDir(options.dataDir)
    const file = await readJsonFile<VerificationFile | null>(store.#path, null).catch((error: unknown) => {
      store.#log(`verifications: unreadable file (${(error as Error).message}); starting empty`)
      return null
    })
    if (file !== null && file.version === 1) {
      for (const record of file.records ?? []) store.#records.set(record.key, record)
    }
    return store
  }

  /**
   * Issue one code.
   *
   * @param email - the destination; normalised by the caller.
   * @param purpose - registration or reset.
   * @returns the code and when it expires.
   * @throws AccountError on the resend cooldown or the hourly cap.
   */
  async issue(email: string, purpose: VerificationPurpose): Promise<IssuedCode> {
    const now = this.#now()
    const key = `${purpose}:${email}`
    const existing = this.#records.get(key)
    if (existing !== undefined) {
      const waited = now - existing.lastSentAt
      if (waited < COOLDOWN_MS) {
        throw new AccountError(
          'RATE_LIMITED',
          `wait ${Math.ceil((COOLDOWN_MS - waited) / 1000)}s before asking for another code`,
          429,
        )
      }
      existing.sends = existing.sends.filter((at) => now - at < 3_600_000)
      if (existing.sends.length >= PER_EMAIL_PER_HOUR) {
        throw new AccountError('RATE_LIMITED', 'too many codes for this address; try again later', 429)
      }
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const record: CodeRecord = {
      key,
      purpose,
      emailKey: email,
      codeHash: this.#hash(email, purpose, code),
      createdAt: now,
      expiresAt: now + TTL_MS,
      attempts: 0,
      lastSentAt: now,
      sends: [...(existing?.sends ?? []), now],
    }
    this.#records.set(key, record)
    this.#prune(now)
    await this.#save()
    return {
      code,
      expiresAt: record.expiresAt,
      resendAfterSeconds: Math.ceil(COOLDOWN_MS / 1000),
    }
  }

  /**
   * Check one code and consume it.
   *
   * @param email - the address the code was sent to.
   * @param purpose - registration or reset.
   * @param code - what the phone typed.
   * @throws AccountError `VERIFICATION_EXPIRED`, `VERIFICATION_INVALID` or
   *   `VERIFICATION_ATTEMPTS`.
   */
  async verify(email: string, purpose: VerificationPurpose, code: string): Promise<void> {
    const now = this.#now()
    const key = `${purpose}:${email}`
    const record = this.#records.get(key)
    if (record === undefined || record.expiresAt <= now) {
      this.#records.delete(key)
      await this.#save()
      throw new AccountError('VERIFICATION_EXPIRED', 'that code has expired; send a new one', 400)
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new AccountError('VERIFICATION_ATTEMPTS', 'too many attempts; send a new code', 400)
    }
    if (!/^\d{6}$/.test(code)) {
      record.attempts += 1
      await this.#save()
      throw new AccountError('VERIFICATION_INVALID', 'that code is not right', 400)
    }
    const presented = Buffer.from(this.#hash(email, purpose, code), 'utf8')
    const expected = Buffer.from(record.codeHash, 'utf8')
    const matches = presented.length === expected.length && timingSafeEqual(presented, expected)
    if (!matches) {
      record.attempts += 1
      await this.#save()
      throw new AccountError('VERIFICATION_INVALID', 'that code is not right', 400)
    }
    this.#records.delete(key)
    await this.#save()
  }

  /** Whether a live code exists, without consuming it. */
  has(email: string, purpose: VerificationPurpose): boolean {
    const record = this.#records.get(`${purpose}:${email}`)
    return record !== undefined && record.expiresAt > this.#now()
  }

  /** HMAC of one code, bound to its address and purpose. */
  #hash(email: string, purpose: VerificationPurpose, code: string): string {
    return createHmac('sha256', this.#secret)
      .update(`${purpose}\n${email}\n${code}`, 'utf8')
      .digest('hex')
  }

  /** Drop expired records and keep the file bounded. */
  #prune(now: number): void {
    for (const [key, record] of this.#records) {
      if (record.expiresAt + 86_400_000 < now) this.#records.delete(key)
    }
    if (this.#records.size <= MAX_RECORDS) return
    const oldest = [...this.#records.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const record of oldest.slice(0, this.#records.size - MAX_RECORDS)) {
      this.#records.delete(record.key)
    }
  }

  /** Persist the file. */
  async #save(): Promise<void> {
    try {
      await writeJsonAtomic(this.#path, {
        version: 1,
        records: [...this.#records.values()],
      } satisfies VerificationFile)
    } catch (error) {
      this.#log(`verifications: could not persist: ${(error as Error).message}`)
    }
  }
}
