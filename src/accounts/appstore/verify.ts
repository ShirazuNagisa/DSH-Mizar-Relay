/**
 * Verify Apple's App Store JWS envelopes.
 *
 * Both StoreKit's `Transaction.jsonRepresentation` and App Store Server
 * Notifications V2 are compact JWS signed by a short-lived Apple certificate
 * chain. The chain rides in the JWS header's `x5c`, so verifying the signature
 * with the leaf alone proves nothing; the chain has to end at a pinned Apple
 * root. That is the entire security boundary between "a user paid" and "a user
 * posted some JSON".
 *
 * The verifier is deliberately oblivious to what the payload means. It answers
 * "Apple signed this and the chain is rooted in Apple", then the transaction /
 * notification layer checks bundle, product, account, and dates.
 *
 * @module dsh-mizar-relay/accounts/appstore/verify
 */
import { X509Certificate, verify as verifySignature } from 'node:crypto'
import { base64urlDecode, parseCompactJws } from '../apple.js'
import { AccountError } from '../types.js'
import { APPLE_ROOT_CA_BASE64 } from './roots.js'

/** One verified App Store transaction's fields, in Apple's names. */
export interface VerifiedTransaction {
  readonly bundleId: string
  readonly productId: string
  readonly type: string
  readonly environment: string
  readonly transactionId: string
  readonly originalTransactionId: string
  readonly appAccountToken: string | null
  readonly expiresDate: number
  readonly revocationDate: number | null
  readonly signedDate: number | null
  readonly raw: Record<string, unknown>
}

/** One verified notification. */
export interface VerifiedNotification {
  readonly notificationType: string
  readonly subtype: string | null
  readonly notificationUUID: string | null
  readonly transaction: VerifiedTransaction | null
  readonly renewal: Record<string, unknown> | null
  readonly raw: Record<string, unknown>
}

/** What the transaction layer needs to accept a payload. */
export interface TransactionPolicy {
  readonly bundleId: string
  readonly productId: string
  readonly allowSandbox: boolean
}

/** Why a transaction was refused. */
export class AppStoreError extends AccountError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status)
    this.name = 'AppStoreError'
  }
}

/** Learn the trust anchors once. */
export class AppStoreVerifier {
  readonly #roots: readonly X509Certificate[]
  readonly #now: () => number

  /**
   * @param roots - trusted root certificates, base64 DER. Defaults to Apple's
   *   embedded G2/G3; tests pass a local test root.
   * @param now - clock, injectable.
   */
  constructor(options: { readonly roots?: readonly string[]; readonly now?: () => number } = {}) {
    this.#roots = (options.roots ?? APPLE_ROOT_CA_BASE64).map(
      (base64) => new X509Certificate(Buffer.from(base64, 'base64')),
    )
    if (this.#roots.length === 0) throw new Error('App Store verifier needs a trust root')
    this.#now = options.now ?? Date.now
  }

  /**
   * Verify one JWS and return its payload.
   *
   * @param token - compact JWS.
   * @returns the JSON payload.
   * @throws AppStoreError when the signature, chain, or certificate is not valid.
   */
  verifyJws(token: string): Record<string, unknown> {
    const parsed = parseCompactJws(token)
    if (parsed === null) throw invalid('the App Store JWS is not a compact JWS')
    if (parsed.header.alg !== 'ES256') throw invalid('the App Store JWS is not ES256')
    const chain = certificateChain(parsed.header['x5c'])
    const leaf = this.#verifyChain(chain)
    const signed = verifySignature(
      'sha256',
      Buffer.from(parsed.signingInput),
      { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
      parsed.signature,
    )
    if (!signed) throw invalid('the App Store JWS signature did not verify')
    return parsed.payload
  }

  /**
   * Verify one transaction and enforce bundle/product/environment.
   *
   * @param token - the transaction JWS.
   * @param policy - expected bundle/product and sandbox policy.
   * @returns the checked transaction.
   */
  verifyTransaction(token: string, policy: TransactionPolicy): VerifiedTransaction {
    return readTransaction(this.verifyJws(token), policy)
  }

  /**
   * Verify one App Store Server Notification V2 envelope.
   *
   * The outer JWS proves Apple sent the notification; the nested transaction
   * info is another JWS and is verified the same way. A notification without
   * transaction info (some renewal-only types) is valid; the caller handles it.
   *
   * @param signedPayload - the notification's compact JWS.
   * @param policy - expected bundle/product and sandbox policy.
   * @returns the notification.
   */
  verifyNotification(signedPayload: string, policy: TransactionPolicy): VerifiedNotification {
    const payload = this.verifyJws(signedPayload)
    const notificationType = typeof payload['notificationType'] === 'string' ? payload['notificationType'] : ''
    if (notificationType === '') throw invalid('the App Store notification has no type')
    const data = asObject(payload['data'])
    const transaction =
      data !== null && typeof data['signedTransactionInfo'] === 'string'
        ? this.verifyTransaction(data['signedTransactionInfo'], policy)
        : null
    const renewal =
      data !== null && typeof data['signedRenewalInfo'] === 'string'
        ? this.verifyJws(data['signedRenewalInfo'])
        : null
    return {
      notificationType,
      subtype: typeof payload['subtype'] === 'string' ? payload['subtype'] : null,
      notificationUUID: typeof payload['notificationUUID'] === 'string' ? payload['notificationUUID'] : null,
      transaction,
      renewal,
      raw: payload,
    }
  }

  /** Verify a chain and return its leaf. */
  #verifyChain(chain: readonly X509Certificate[]): X509Certificate {
    if (chain.length === 0) throw invalid('the App Store JWS carries no certificate chain')
    let anchor = -1
    for (let index = 0; index < chain.length; index += 1) {
      const cert = chain[index]
      if (cert === undefined) continue
      for (const root of this.#roots) {
        if (cert.raw.equals(root.raw) || safeVerify(cert, root.publicKey)) {
          anchor = index
          break
        }
      }
      if (anchor !== -1) break
    }
    if (anchor === -1) throw invalid('the App Store certificate chain is not rooted in Apple')
    // Verify from the anchored certificate down to the leaf. A chain that skips
    // an intermediate fails here, which is the point: the x5c array is supplied
    // by the token and must describe an unbroken path.
    for (let index = anchor; index > 0; index -= 1) {
      const child = chain[index - 1]
      const parent = chain[index]
      if (child === undefined || parent === undefined || !safeVerify(child, parent.publicKey)) {
        throw invalid('the App Store certificate chain is broken')
      }
    }
    const now = this.#now()
    for (const cert of chain) {
      const from = Date.parse(cert.validFrom)
      const to = Date.parse(cert.validTo)
      if (Number.isFinite(from) && now < from - 60_000) throw invalid('an App Store certificate is not valid yet')
      if (Number.isFinite(to) && now > to + 60_000) throw invalid('an App Store certificate has expired')
    }
    const leaf = chain[0]
    if (leaf === undefined) throw invalid('the App Store JWS has no leaf certificate')
    return leaf
  }
}

/** Verify a certificate with a key, turning a thrown error into `false`. */
function safeVerify(cert: X509Certificate, key: Parameters<X509Certificate['verify']>[0]): boolean {
  try {
    return cert.verify(key)
  } catch {
    return false
  }
}

/** Read a chain from the JWS header's `x5c`. */
function certificateChain(value: unknown): X509Certificate[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid('the App Store JWS carries no x5c chain')
  const out: X509Certificate[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') throw invalid('the App Store x5c entry is not a certificate')
    try {
      out.push(new X509Certificate(Buffer.from(entry, 'base64')))
    } catch (error) {
      throw invalid(`the App Store x5c entry is not a certificate: ${(error as Error).message}`)
    }
  }
  return out
}

/**
 * Turn a decoded payload into a checked transaction.
 *
 * @param payload - the decoded JWS payload.
 * @param policy - expected values.
 * @returns the transaction.
 */
export function readTransaction(
  payload: Record<string, unknown>,
  policy: TransactionPolicy,
): VerifiedTransaction {
  const bundleId = stringOf(payload['bundleId'])
  const productId = stringOf(payload['productId'])
  const type = stringOf(payload['type'])
  const environment = stringOf(payload['environment'])
  const transactionId = stringOf(payload['transactionId'])
  const originalTransactionId = stringOf(payload['originalTransactionId'])
  const expiresDate = numberOrNull(payload['expiresDate'])
  const revocationDate = numberOrNull(payload['revocationDate'])
  const appAccountToken =
    typeof payload['appAccountToken'] === 'string' && payload['appAccountToken'] !== ''
      ? payload['appAccountToken'].toLowerCase()
      : null
  if (bundleId === null) throw invalid('the App Store transaction has no bundle id')
  if (productId === null) throw invalid('the App Store transaction has no product id')
  if (type !== 'Auto-Renewable Subscription') {
    throw new AppStoreError('APPSTORE_PRODUCT_MISMATCH', 'the App Store transaction is not an auto-renewable subscription', 409)
  }
  if (environment !== 'Production' && environment !== 'Sandbox') {
    throw invalid('the App Store transaction has an unknown environment')
  }
  if (environment === 'Sandbox' && !policy.allowSandbox) {
    throw invalid('sandbox App Store transactions are not accepted by this relay')
  }
  if (bundleId !== policy.bundleId) {
    throw new AppStoreError('APPSTORE_PRODUCT_MISMATCH', `the transaction is for bundle ${bundleId}`, 409)
  }
  if (productId !== policy.productId) {
    throw new AppStoreError('APPSTORE_PRODUCT_MISMATCH', `the transaction is for product ${productId}`, 409)
  }
  if (transactionId === null || originalTransactionId === null) {
    throw invalid('the App Store transaction has no transaction id')
  }
  if (expiresDate === null) throw invalid('the App Store transaction has no expiry')
  return {
    bundleId,
    productId,
    type,
    environment,
    transactionId,
    originalTransactionId,
    appAccountToken,
    expiresDate,
    revocationDate,
    signedDate: numberOrNull(payload['signedDate']),
    raw: payload,
  }
}

/** A non-empty string, or `null`. */
function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A finite number, or `null`. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** An object, or `null`. */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A 400 for a JWS that did not verify. */
function invalid(message: string): AppStoreError {
  return new AppStoreError('APPSTORE_TOKEN_INVALID', message, 400)
}

/** Re-export the decoder for callers that already have a payload. */
export { base64urlDecode }
