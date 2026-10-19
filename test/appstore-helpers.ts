/** Shared App Store JWS fixtures for the relay tests. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate, createPrivateKey, sign } from 'node:crypto'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'appstore')
const leafPem = readFileSync(join(FIXTURES, 'leaf.pem'), 'utf8')
const leafKey = createPrivateKey(readFileSync(join(FIXTURES, 'leaf.key'), 'utf8'))
const leafDer = new X509Certificate(leafPem).raw.toString('base64')
const intermediateDer = new X509Certificate(
  readFileSync(join(FIXTURES, 'intermediate.pem'), 'utf8'),
).raw.toString('base64')
const rootDer = new X509Certificate(readFileSync(join(FIXTURES, 'root.pem'), 'utf8')).raw.toString(
  'base64',
)

export const APPSTORE_TEST_ROOT = rootDer
export const APPSTORE_NOW = Date.parse('2026-10-19T12:00:00Z')
export const APPSTORE_BUNDLE = 'me.shirazu.dshmizar'
export const APPSTORE_PRODUCT = 'me.shirazu.dshmizar.paid.monthly'

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

/** Sign one transaction with the test leaf. */
export function signTransaction(overrides: Record<string, unknown> = {}): string {
  const payload = {
    bundleId: APPSTORE_BUNDLE,
    productId: APPSTORE_PRODUCT,
    type: 'Auto-Renewable Subscription',
    environment: 'Production',
    transactionId: '2000000000000001',
    originalTransactionId: '2000000000000000',
    appAccountToken: '11111111-1111-4111-8111-111111111111',
    expiresDate: Date.parse('2026-11-19T00:00:00Z'),
    signedDate: APPSTORE_NOW,
    ...overrides,
  }
  const header = { alg: 'ES256', x5c: [leafDer, intermediateDer] }
  const encodedHeader = b64url(JSON.stringify(header))
  const encodedPayload = b64url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: leafKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${b64url(signature)}`
}

/** Build an App Store Server Notification V2 envelope. */
export function signNotification(
  type: string,
  transaction: string,
  options: { readonly notificationUUID?: string; readonly autoRenewStatus?: number } = {},
): string {
  const data: Record<string, unknown> = {
    signedTransactionInfo: transaction,
    ...(options.autoRenewStatus === undefined
      ? {}
      : { signedRenewalInfo: signRenewal({ autoRenewStatus: options.autoRenewStatus }) }),
  }
  const payload = {
    notificationType: type,
    notificationUUID: options.notificationUUID ?? 'notification-1',
    data,
    version: '2.0',
    signedDate: APPSTORE_NOW,
  }
  const header = { alg: 'ES256', x5c: [leafDer, intermediateDer] }
  const encodedHeader = b64url(JSON.stringify(header))
  const encodedPayload = b64url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = sign('sha256', Buffer.from(signingInput), { key: leafKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64url(signature)}`
}

/** Sign a renewal-info JWS. */
export function signRenewal(payload: Record<string, unknown>): string {
  const header = { alg: 'ES256', x5c: [leafDer, intermediateDer] }
  const encodedHeader = b64url(JSON.stringify(header))
  const encodedPayload = b64url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = sign('sha256', Buffer.from(signingInput), { key: leafKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64url(signature)}`
}
