/** Sign in with Apple: JWKS verification and the account linkage rules. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppleIdentityVerifier } from '../src/accounts/apple.js'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import { hashPassword } from '../src/accounts/passwords.js'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const FAST = { N: 1024, r: 8, p: 1 }
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'apple-test-key', alg: 'RS256', use: 'sig' }

let relay: Relay | undefined
let dir = ''
let adminHash = ''
let fetched = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-apple-'))
  adminHash = await hashPassword('admin-password', FAST)
  fetched = 0
})
afterEach(async () => {
  await relay?.close()
  relay = undefined
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function rawNonce(): string {
  return 'nonce-for-tests-0123456789abcdef'
}

function identityToken(overrides: Record<string, unknown> = {}, nonce = rawNonce()): string {
  const header = { alg: 'RS256', kid: 'apple-test-key' }
  const payload = {
    iss: 'https://appleid.apple.com',
    aud: 'me.shirazu.dshmizar',
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000) - 10,
    sub: 'apple-subject-1',
    email: 'shirazu@privaterelay.appleid.com',
    email_verified: 'true',
    nonce: createHash('sha256').update(nonce, 'utf8').digest('hex'),
    ...overrides,
  }
  const encodedHeader = b64url(JSON.stringify(header))
  const encodedPayload = b64url(JSON.stringify(payload))
  const signature = sign('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), privateKey)
  return `${encodedHeader}.${encodedPayload}.${b64url(signature)}`
}

function fakeFetch(): typeof fetch {
  return (async () => {
    fetched += 1
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function verifier(): AppleIdentityVerifier {
  return new AppleIdentityVerifier({
    audiences: ['me.shirazu.dshmizar'],
    keysURL: 'https://appleid.test/auth/keys',
    fetchImpl: fakeFetch(),
    now: () => NOW,
  })
}

describe('Apple identity tokens', () => {
  it('verifies a token and its nonce', async () => {
    const identity = await verifier().verify(identityToken(), rawNonce())
    expect(identity).toMatchObject({
      sub: 'apple-subject-1',
      email: 'shirazu@privaterelay.appleid.com',
      emailVerified: true,
    })
  })

  it('rejects a bad nonce, audience, issuer, expiry, and signature', async () => {
    await expect(verifier().verify(identityToken(), 'wrong')).rejects.toThrow(/nonce/)
    await expect(verifier().verify(identityToken({ aud: 'com.example.other' }))).rejects.toThrow(/audience/)
    await expect(verifier().verify(identityToken({ iss: 'https://evil.example' }))).rejects.toThrow(/issuer/)
    await expect(verifier().verify(identityToken({ exp: Math.floor(NOW / 1000) - 3600 }))).rejects.toThrow(/expired/)
    const parts = identityToken().split('.')
    const tampered = `${parts[0]}.${parts[1]}.${b64url('x'.repeat(256))}`
    await expect(verifier().verify(tampered)).rejects.toThrow(/signature/)
  })

  it('caches the JWKS between sign-ins', async () => {
    const current = verifier()
    await current.verify(identityToken())
    await current.verify(identityToken({ sub: 'apple-subject-2' }))
    expect(fetched).toBe(1)
  })

  it('reports Apple unavailable when the key endpoint answers badly', async () => {
    const current = new AppleIdentityVerifier({
      audiences: ['me.shirazu.dshmizar'],
      keysURL: 'https://appleid.test/auth/keys',
      fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch,
      now: () => NOW,
    })
    await expect(current.verify(identityToken())).rejects.toMatchObject({ code: 'APPLE_UNAVAILABLE' })
  })
})

function config(): RelayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    tokens: ['apple-test-token'],
    trustProxy: true,
    maxTunnelsPerIp: 8,
    maxRooms: 100,
    maxBodyBytes: 1024 * 1024,
    maxMessageBytes: 1024 * 1024,
    maxClientsPerRoom: 8,
    requestTimeoutMs: 2000,
    tunnelIdleMs: 60_000,
    probePort: 0,
    apns: null,
    fcm: null,
    role: 1,
    accounts: {
      enabled: true,
      dataDir: dir,
      adminPasswordHash: adminHash,
      internalSecret: 'internal-test-secret',
      reportTo: '',
      reportId: 'test-account-relay',
      gravatar: { enabled: false, baseURLs: [] },
      appleAudiences: ['me.shirazu.dshmizar'],
      appleKeysURL: 'https://appleid.test/auth/keys',
      appstore: {
        bundleId: 'me.shirazu.dshmizar',
        productId: 'me.shirazu.dshmizar.paid.monthly',
        allowSandbox: true,
        notificationsEnabled: true,
      },
      publicBaseURL: 'https://accounts.test',
    },
  }
}

async function boot(): Promise<string> {
  relay = await startRelay(config(), () => undefined, {
    now: () => NOW,
    passwordParams: FAST,
    fetchImpl: fakeFetch(),
  })
  return `http://127.0.0.1:${relay.port}`
}

async function apple(base: string, deviceId: string, token = identityToken()): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/account/v1/apple`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identityToken: token,
      nonce: rawNonce(),
      device: { id: deviceId, name: deviceId, model: 'iPhone18,1', platform: 'ios', appVersion: '0.10.0' },
    }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('Apple accounts over the API', () => {
  it('creates an Apple account and does not cap its devices', async () => {
    const base = await boot()
    const first = await apple(base, 'device-0001')
    expect(first.status).toBe(200)
    expect((first.body['user'] as Record<string, unknown>)['plan']).toBe('free')
    const second = await apple(base, 'device-0002')
    expect(second.status).toBe(200)
    const third = await apple(base, 'device-0003')
    expect(third.status).toBe(200)
    expect(third.body['notice']).toBeUndefined()
    for (const token of [first, second, third]) {
      const me = await fetch(`${base}/account/v1/me`, {
        headers: { authorization: `Bearer ${String(token.body['token'])}` },
      })
      expect(me.status).toBe(200)
    }
  })

  it('links a verified Apple email to an existing password account', async () => {
    const base = await boot()
    const registered = await fetch(`${base}/account/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'password-user',
        email: 'shirazu@privaterelay.appleid.com',
        password: 'correct horse battery',
        device: { id: 'device-0001', name: 'iPhone', model: 'iPhone18,1', platform: 'ios', appVersion: '0.10.0' },
      }),
    })
    const registeredBody = (await registered.json()) as { user: Record<string, unknown> }
    const linked = await apple(base, 'device-0002')
    expect(linked.status).toBe(200)
    expect((linked.body['user'] as Record<string, unknown>)['id']).toBe(registeredBody.user['id'])
    expect((linked.body['user'] as Record<string, unknown>)['emailVerified']).toBe(true)
  })
})
