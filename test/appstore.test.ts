/**
 * App Store JWS verification and entitlement arithmetic.
 *
 * The chain in these tests is a local root/intermediate/leaf; the verifier is
 * injected with that root, so the test proves the code verifies a real x5c chain
 * rather than trusting the leaf. Production roots are embedded constants and are
 * covered by a fingerprint assertion below.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate, createPrivateKey, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AppStoreVerifier, AppStoreError, readTransaction } from '../src/accounts/appstore/verify.js'
import {
  applyNotification,
  applyTransaction,
  effectivePaidUntil,
  publicAppStore,
} from '../src/accounts/appstore/entitlements.js'
import { APPLE_ROOT_CA_BASE64 } from '../src/accounts/appstore/roots.js'
import type { UserRecord } from '../src/accounts/types.js'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'appstore')
const leafPem = readFileSync(join(FIXTURES, 'leaf.pem'), 'utf8')
const leafKey = createPrivateKey(readFileSync(join(FIXTURES, 'leaf.key'), 'utf8'))
const leafDer = new X509Certificate(leafPem).raw.toString('base64')
const intermediateDer = new X509Certificate(readFileSync(join(FIXTURES, 'intermediate.pem'), 'utf8')).raw.toString('base64')
const rootDer = new X509Certificate(readFileSync(join(FIXTURES, 'root.pem'), 'utf8')).raw.toString('base64')
const NOW = Date.parse('2026-10-19T12:00:00Z')

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

/** Sign a JWS with the test leaf. */
function jws(payload: Record<string, unknown>, options: { tamper?: string } = {}): string {
  const header = { alg: 'ES256', x5c: [leafDer, intermediateDer] }
  const encodedHeader = b64url(JSON.stringify(header))
  const body = JSON.stringify(payload)
  const encodedPayload = b64url(options.tamper ?? body)
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: leafKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${b64url(signature)}`
}

const policy = {
  bundleId: 'me.shirazu.dshmizar',
  productId: 'me.shirazu.dshmizar.paid.monthly',
  allowSandbox: true,
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundleId: policy.bundleId,
    productId: policy.productId,
    type: 'Auto-Renewable Subscription',
    environment: 'Production',
    transactionId: '2000000000000001',
    originalTransactionId: '2000000000000000',
    appAccountToken: '11111111-1111-4111-8111-111111111111',
    expiresDate: Date.parse('2026-11-19T00:00:00Z'),
    signedDate: NOW,
    ...overrides,
  }
}

function verifier(): AppStoreVerifier {
  return new AppStoreVerifier({ roots: [rootDer], now: () => NOW })
}

function user(): UserRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'test',
    usernameKey: 'test',
    email: 'test@example.com',
    emailKey: 'test@example.com',
    emailVerified: true,
    passwordHash: null,
    appleSub: null,
    avatar: { kind: 'generated', colors: ['#000000', '#111111', '#222222'], initials: 'T' },
    disabled: false,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    devices: [],
    entitlements: { grantedPaidUntil: null, appStore: null },
  }
}

describe('the production Apple roots', () => {
  it('embed both Apple roots', () => {
    expect(APPLE_ROOT_CA_BASE64).toHaveLength(2)
    const subjects = APPLE_ROOT_CA_BASE64.map(
      (base64) => new X509Certificate(Buffer.from(base64, 'base64')).subject,
    )
    expect(subjects.some((subject) => subject.includes('Apple Root CA - G2'))).toBe(true)
    expect(subjects.some((subject) => subject.includes('Apple Root CA - G3'))).toBe(true)
  })
})

describe('App Store JWS verification', () => {
  it('accepts a transaction signed through the test chain', () => {
    const verified = verifier().verifyTransaction(jws(transaction()), policy)
    expect(verified.transactionId).toBe('2000000000000001')
    expect(verified.appAccountToken).toBe('11111111-1111-4111-8111-111111111111')
    expect(verified.expiresDate).toBe(Date.parse('2026-11-19T00:00:00Z'))
  })

  it('rejects a payload changed after signing', () => {
    expect(() => verifier().verifyTransaction(jws(transaction(), { tamper: JSON.stringify(transaction({ productId: 'x' })) }), policy)).toThrow(AppStoreError)
  })

  it('rejects a chain rooted outside the pinned roots', () => {
    const other = new AppStoreVerifier({ roots: [APPLE_ROOT_CA_BASE64[0] ?? ''], now: () => NOW })
    expect(() => other.verifyTransaction(jws(transaction()), policy)).toThrow(/rooted/)
  })

  it('rejects the wrong bundle, product, type, and environment', () => {
    for (const overrides of [
      { bundleId: 'com.example.other' },
      { productId: 'com.example.other.monthly' },
      { type: 'Non-Consumable' },
      { environment: 'Unknown' },
      { environment: 'Sandbox' },
    ]) {
      const current = overrides.environment === 'Sandbox'
        ? new AppStoreVerifier({ roots: [rootDer], now: () => NOW })
        : verifier()
      const policyForCase = overrides.environment === 'Sandbox' ? { ...policy, allowSandbox: false } : policy
      expect(() => current.verifyTransaction(jws(transaction(overrides)), policyForCase)).toThrow(AppStoreError)
    }
  })

  it('refuses a certificate chain that skips the intermediate', () => {
    const header = { alg: 'ES256', x5c: [leafDer] }
    const encodedHeader = b64url(JSON.stringify(header))
    const body = b64url(JSON.stringify(transaction()))
    const signingInput = `${encodedHeader}.${body}`
    const signature = sign('sha256', Buffer.from(signingInput), { key: leafKey, dsaEncoding: 'ieee-p1363' })
    expect(() => verifier().verifyTransaction(`${signingInput}.${b64url(signature)}`, policy)).toThrow(AppStoreError)
  })

  it('checks the transaction clock fields through readTransaction', () => {
    const verified = verifier().verifyTransaction(jws(transaction()), policy)
    expect(readTransaction(verified.raw, policy)).toMatchObject({ environment: 'Production' })
  })
})

describe('entitlement arithmetic', () => {
  it('extends to the transaction expiry and ignores a later old transaction', () => {
    const record = user()
    const newer = verifier().verifyTransaction(jws(transaction()), policy)
    expect(applyTransaction(record, newer, NOW)).toBe(true)
    expect(effectivePaidUntil(record)).toBe(newer.expiresDate)
    const older = verifier().verifyTransaction(jws(transaction({ transactionId: '2000000000000002', expiresDate: Date.parse('2026-10-01T00:00:00Z') })), policy)
    applyTransaction(record, older, NOW)
    expect(effectivePaidUntil(record)).toBe(newer.expiresDate)
  })

  it('revokes only the latest period', () => {
    const record = user()
    const newer = verifier().verifyTransaction(jws(transaction()), policy)
    applyTransaction(record, newer, NOW)
    const refund = verifier().verifyTransaction(
      jws(transaction({ revocationDate: NOW + 1000, expiresDate: Date.parse('2026-10-01T00:00:00Z') })),
      policy,
    )
    applyTransaction(record, refund, NOW + 2000)
    expect(effectivePaidUntil(record)).toBe(newer.expiresDate)
    const latestRefund = verifier().verifyTransaction(
      jws(transaction({ revocationDate: NOW + 3000 })),
      policy,
    )
    applyTransaction(record, latestRefund, NOW + 4000)
    expect(effectivePaidUntil(record)).toBeNull()
    expect(record.entitlements.appStore?.revokedAt).toBe(NOW + 4000)
  })

  it('keeps an invite grant when the App Store subscription is refunded', () => {
    const record = user()
    record.entitlements.grantedPaidUntil = Date.parse('2027-01-01T00:00:00Z')
    const refund = verifier().verifyTransaction(jws(transaction({ revocationDate: NOW + 1000 })), policy)
    applyTransaction(record, refund, NOW + 2000)
    expect(effectivePaidUntil(record)).toBe(Date.parse('2027-01-01T00:00:00Z'))
  })

  it('handles a DID_RENEW notification and a REFUND notification', () => {
    const record = user()
    const renewal = verifier().verifyTransaction(
      jws(transaction({ transactionId: '2000000000000003', expiresDate: Date.parse('2026-12-19T00:00:00Z') })),
      policy,
    )
    const changed = applyNotification(
      record,
      {
        notificationType: 'DID_RENEW',
        subtype: null,
        notificationUUID: 'n1',
        transaction: renewal,
        renewal: { autoRenewStatus: 1 },
        raw: {},
      },
      NOW,
    )
    expect(changed).toBe(true)
    expect(record.entitlements.appStore?.autoRenew).toBe(true)

    const refund = verifier().verifyTransaction(
      jws(transaction({ transactionId: '2000000000000003', revocationDate: NOW + 10, expiresDate: Date.parse('2026-12-19T00:00:00Z') })),
      policy,
    )
    applyNotification(
      record,
      {
        notificationType: 'REFUND',
        subtype: null,
        notificationUUID: 'n2',
        transaction: refund,
        renewal: null,
        raw: {},
      },
      NOW + 20,
    )
    expect(record.entitlements.appStore?.paidUntil).toBeNull()
    expect(publicAppStore(record.entitlements.appStore)?.environment).toBe('Production')
  })
})
