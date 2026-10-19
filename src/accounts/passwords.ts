/**
 * Password hashing for accounts.
 *
 * scrypt from `node:crypto` rather than bcrypt/argon2: the relay's whole
 * dependency budget is one WebSocket package, and a native password addon is
 * the kind of thing that turns a self-contained bundle into a server that needs
 * a compiler. scrypt is memory-hard, in the standard library, and its parameter
 * string is stored next to the hash so a future cost increase does not lock old
 * accounts out.
 *
 * @module dsh-mizar-relay/accounts/passwords
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'


/** Cost parameters. `N=16384` is about 16 MiB per verification, which is a
 * sensible default for a single-process relay; the encoded prefix makes it
 * changeable without invalidating existing hashes. */
export interface ScryptParams {
  readonly N: number
  readonly r: number
  readonly p: number
}

/** The production cost. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 16_384, r: 8, p: 1 }

/** A hash as it is stored. */
const PREFIX = 'scrypt'

/**
 * Hash one password.
 *
 * @param password - the plaintext, already validated by the caller.
 * @param params - cost parameters; tests use a cheaper set.
 * @returns the encoded hash.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64, params)
  return [PREFIX, params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join(
    '$',
  )
}

/**
 * Verify one password against an encoded hash.
 *
 * A malformed hash is a failed verification, not an exception: a corrupted
 * account file must not turn a login attempt into a 500 that says the password
 * was almost right.
 *
 * @param password - the candidate.
 * @param encoded - the stored hash.
 * @returns whether it matches.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded)
  if (parsed === null) return false
  const actual = await scryptAsync(password, parsed.salt, parsed.hash.length, parsed)
  if (actual.length !== parsed.hash.length) return false
  return timingSafeEqual(actual, parsed.hash)
}

/**
 * Burn the same work as a real verification for an identifier that does not
 * exist.
 *
 * Without this, "no such user" returns in a millisecond and "wrong password"
 * returns in tens of milliseconds -- an account-existence oracle that no amount
 * of generic error text hides.
 *
 * @param password - the candidate; its content is irrelevant.
 * @param params - the cost to burn.
 */
export async function burnPasswordCheck(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<void> {
  await scryptAsync(password, randomBytes(16), 64, params)
}

/**
 * Parse an encoded hash.
 *
 * @param encoded - the stored string.
 * @returns its parts, or `null` when it is not a hash this build understands.
 */
export function parseHash(
  encoded: string,
): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return null
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  if (N <= 0 || r <= 0 || p <= 0) return null
  let salt: Buffer
  let hash: Buffer
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64')
    hash = Buffer.from(parts[5] ?? '', 'base64')
  } catch {
    return null
  }
  if (salt.length === 0 || hash.length === 0) return null
  return { N, r, p, salt, hash }
}


/** Promisified scrypt with the options overload this file needs. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error !== null) reject(error)
        else resolve(key as Buffer)
      },
    )
  })
}
