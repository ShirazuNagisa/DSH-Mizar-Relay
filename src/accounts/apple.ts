/**
 * Sign in with Apple: verify the identity token the app hands us.
 *
 * Native Sign in with Apple returns a JWT signed by Apple. Verifying it against
 * Apple's published JWKS is enough to establish `sub` (stable Apple user id) and
 * the verified email; no client secret, no authorization-code exchange, no
 * per-app key is needed for that. That keeps the account server free of Apple
 * developer credentials -- the one thing it cannot ask a self-hoster for.
 *
 * The JWKS is cached because fetching it per sign-in would put Apple in the
 * path of every login; an unknown `kid` forces one refresh, which is what makes
 * Apple's key rotation work without a restart.
 *
 * @module dsh-mizar-relay/accounts/apple
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { AccountError } from './types.js'

/** What a verified Apple identity tells us. */
export interface AppleIdentity {
  readonly sub: string
  readonly email: string | null
  readonly emailVerified: boolean
}

/** A JWKS key as Apple publishes it. */
interface AppleJwk {
  readonly kid?: string
  readonly kty?: string
  readonly n?: string
  readonly e?: string
  readonly alg?: string
  readonly use?: string
}

/** One cached JWKS response. */
interface CachedKeys {
  readonly keys: Map<string, AppleJwk>
  readonly fetchedAt: number
}

/** How long a JWKS response is reused. */
const KEY_TTL_MS = 60 * 60 * 1000

/** How long a JWKS fetch may take. */
const FETCH_TIMEOUT_MS = 5_000

/** Verify Apple identity tokens. */
export class AppleIdentityVerifier {
  readonly #audiences: readonly string[]
  readonly #keysURL: string
  readonly #fetch: typeof fetch
  readonly #now: () => number
  #cache: CachedKeys | null = null
  #inflight: Promise<CachedKeys> | null = null

  constructor(options: {
    readonly audiences: readonly string[]
    readonly keysURL: string
    readonly fetchImpl?: typeof fetch
    readonly now?: () => number
  }) {
    this.#audiences = options.audiences
    this.#keysURL = options.keysURL
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    if (this.#audiences.length === 0) {
      throw new Error('apple audiences must contain at least the app bundle id')
    }
  }

  /**
   * Verify one identity token.
   *
   * @param identityToken - the compact JWS from `ASAuthorizationAppleIDCredential`.
   * @param rawNonce - the nonce the app generated; its SHA-256 is compared to the claim.
   * @returns the verified identity.
   * @throws AccountError when the token is invalid or Apple cannot be reached.
   */
  async verify(identityToken: string, rawNonce?: string): Promise<AppleIdentity> {
    const parsed = parseCompactJws(identityToken)
    if (parsed === null) {
      throw invalid('the Apple identity token is not a compact JWS')
    }
    const { header, payload, signingInput, signature } = parsed
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw invalid('the Apple identity token is not RS256 with a key id')
    }
    const key = await this.#key(header.kid)
    const publicKey = publicKeyOf(key)
    if (!verifySignature('RSA-SHA256', Buffer.from(signingInput), publicKey, signature)) {
      throw invalid('the Apple identity token signature did not verify')
    }

    const now = this.#now()
    if (payload.iss !== 'https://appleid.apple.com') {
      throw invalid('the Apple token issuer is not Apple')
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!audiences.some((audience) => typeof audience === 'string' && this.#audiences.includes(audience))) {
      throw invalid('the Apple token audience is not this app')
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now - 60_000) {
      throw invalid('the Apple identity token has expired')
    }
    if (typeof payload.iat === 'number' && payload.iat * 1000 > now + 60_000) {
      throw invalid('the Apple identity token was issued in the future')
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw invalid('the Apple identity token has no subject')
    }
    if (rawNonce !== undefined) {
      const expected = createHash('sha256').update(rawNonce, 'utf8').digest('hex')
      if (payload.nonce !== expected) {
        throw invalid('the Apple token nonce does not match this request')
      }
    }
    const emailVerified =
      payload.email_verified === true ||
      payload.email_verified === 'true' ||
      payload.email_verified === '1'
    const email = typeof payload.email === 'string' && payload.email.includes('@') ? payload.email : null
    return { sub: payload.sub, email, emailVerified }
  }

  /** Fetch or refresh the JWKS. */
  async #key(kid: string): Promise<AppleJwk> {
    const cached = this.#cache
    if (cached !== null && this.#now() - cached.fetchedAt < KEY_TTL_MS) {
      const found = cached.keys.get(kid)
      if (found !== undefined) return found
    }
    const fresh = await this.#refresh()
    const found = fresh.keys.get(kid)
    if (found === undefined) throw invalid('Apple published no key with this id')
    return found
  }

  /** Fetch JWKS once, coalescing concurrent callers. */
  async #refresh(): Promise<CachedKeys> {
    if (this.#inflight !== null) return this.#inflight
    this.#inflight = (async () => {
      let response: Response
      try {
        response = await this.#fetch(this.#keysURL, {
          method: 'GET',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      } catch (error) {
        throw new AccountError(
          'APPLE_UNAVAILABLE',
          `could not reach Apple's key endpoint: ${(error as Error).message}`,
          503,
        )
      }
      if (!response.ok) {
        throw new AccountError('APPLE_UNAVAILABLE', `Apple's key endpoint answered ${response.status}`, 503)
      }
      let body: { keys?: unknown }
      try {
        body = (await response.json()) as { keys?: unknown }
      } catch {
        throw new AccountError('APPLE_UNAVAILABLE', "Apple's key endpoint answered no JSON", 503)
      }
      const keys = new Map<string, AppleJwk>()
      if (Array.isArray(body.keys)) {
        for (const value of body.keys) {
          if (typeof value !== 'object' || value === null) continue
          const key = value as AppleJwk
          if (typeof key.kid === 'string' && key.kty === 'RSA' && key.n !== undefined && key.e !== undefined) {
            keys.set(key.kid, key)
          }
        }
      }
      const fresh = { keys, fetchedAt: this.#now() }
      this.#cache = fresh
      this.#inflight = null
      return fresh
    })()
    try {
      return await this.#inflight
    } finally {
      this.#inflight = null
    }
  }
}

/** A compact JWS split into the pieces verification needs. */
interface ParsedJws {
  readonly header: Record<string, unknown> & { alg?: string; kid?: string }
  readonly payload: Record<string, unknown>
  readonly signingInput: string
  readonly signature: Buffer
}

/** Parse a compact JWS without verifying it. */
export function parseCompactJws(token: string): ParsedJws | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerText, payloadText, signatureText] = parts
  if (headerText === undefined || payloadText === undefined || signatureText === undefined) return null
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(base64urlDecode(headerText).toString('utf8')) as Record<string, unknown>
    payload = JSON.parse(base64urlDecode(payloadText).toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  return {
    header: header as ParsedJws['header'],
    payload,
    signingInput: `${headerText}.${payloadText}`,
    signature: base64urlDecode(signatureText),
  }
}

/** Decode base64url with or without padding. */
export function base64urlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64')
}

/** Build a public key from an RSA JWK. */
export function publicKeyOf(jwk: AppleJwk): ReturnType<typeof createPublicKey> {
  if (jwk.n === undefined || jwk.e === undefined) {
    throw invalid('Apple published an RSA key without its modulus')
  }
  try {
    return createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
  } catch (error) {
    throw invalid(`Apple published an unusable RSA key: ${(error as Error).message}`)
  }
}

/** A 400 for a token that did not verify. */
function invalid(message: string): AccountError {
  return new AccountError('APPLE_TOKEN_INVALID', message, 400)
}
