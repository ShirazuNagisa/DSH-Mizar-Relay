/**
 * The mail policy's arithmetic, without a relay in the way.
 *
 * These cover the parts that are easy to get subtly wrong: a code that can be
 * replayed, a warning that counts twice, a fourth anomaly that does not ban, an
 * unban that leaves the warnings behind.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Enforcement } from '../src/accounts/enforcement.js'
import { hashToken, AccountStore } from '../src/accounts/store.js'
import { VerificationCodes } from '../src/accounts/verification.js'
import type { MailClient } from '../src/mail/client.js'
import { renderMail } from '../src/mail/templates.js'
import { TencentMailTransport } from '../src/mail/tencent.js'

const FAST = { N: 1024, r: 8, p: 1 }
const DEVICE = { id: 'test-device-01', name: 'Test', model: 'iPhone', platform: 'ios', appVersion: '0.9.5' }

let dir = ''
let store: AccountStore | undefined
let now = 1_790_000_000_000

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-mail-'))
  now = 1_790_000_000_000
  store = await AccountStore.open({
    dataDir: dir,
    now: () => now,
    passwordParams: FAST,
    gravatar: { enabled: false, baseURLs: [] },
    apple: { audiences: ['me.shirazu.dshmizar'], keysURL: '' },
    appstore: { bundleId: 'me.shirazu.dshmizar', productId: 'p', allowSandbox: true },
  })
})

afterEach(async () => {
  await store?.close()
  store = undefined
  await rm(dir, { recursive: true, force: true })
})

async function account(): Promise<{ userId: string; hash: string; email: string; token: string }> {
  const auth = await store.register({
    username: 'policy-user',
    email: 'policy@example.com',
    password: 'password123',
    device: DEVICE,
    emailVerified: true,
  })
  return { userId: auth.user.id, hash: hashToken(auth.token), email: auth.user.email ?? '', token: auth.token }
}

describe('verification codes', () => {
  it('issues a six-digit code, accepts it once, and refuses the replay', async () => {
    const codes = await VerificationCodes.open({ dataDir: dir, secret: 'secret', now: () => now })
    const issued = await codes.issue('a@example.com', 'register')
    expect(issued.code).toMatch(/^\d{6}$/)
    await codes.verify('a@example.com', 'register', issued.code)
    await expect(codes.verify('a@example.com', 'register', issued.code)).rejects.toMatchObject({
      code: 'VERIFICATION_EXPIRED',
    })
  })

  it('refuses a wrong code and stops after five attempts', async () => {
    const codes = await VerificationCodes.open({ dataDir: dir, secret: 'secret', now: () => now })
    await codes.issue('b@example.com', 'register')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(codes.verify('b@example.com', 'register', '000000')).rejects.toMatchObject({
        code: 'VERIFICATION_INVALID',
      })
    }
    await expect(codes.verify('b@example.com', 'register', '000000')).rejects.toMatchObject({
      code: 'VERIFICATION_INVALID',
    })
    await expect(codes.verify('b@example.com', 'register', '000000')).rejects.toMatchObject({
      code: 'VERIFICATION_ATTEMPTS',
    })
  })

  it('holds the resend cooldown', async () => {
    const codes = await VerificationCodes.open({ dataDir: dir, secret: 'secret', now: () => now })
    await codes.issue('c@example.com', 'register')
    await expect(codes.issue('c@example.com', 'register')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    now += 61_000
    const again = await codes.issue('c@example.com', 'register')
    expect(again.code).toMatch(/^\d{6}$/)
  })

  it('does not accept a registration code for a reset', async () => {
    const codes = await VerificationCodes.open({ dataDir: dir, secret: 'secret', now: () => now })
    const issued = await codes.issue('d@example.com', 'register')
    await expect(codes.verify('d@example.com', 'reset', issued.code)).rejects.toMatchObject({
      code: 'VERIFICATION_EXPIRED',
    })
  })
})

describe('traffic policy', () => {
  it('warns three times and bans on the fourth day', async () => {
    const { userId, hash } = await account()
    const sent: Array<{ kind: string; to: string; data: Record<string, string> }> = []
    const mail = {
      send: async (message: { kind: string; to: string; data: Record<string, string> }) => {
        sent.push(message)
      },
      sendWarning: async (to: string, data: { day: string; bytes: string; count: number }) => {
        sent.push({ kind: 'warning', to, data: { ...data, count: String(data.count) } })
      },
      sendBanned: async (to: string) => {
        sent.push({ kind: 'banned', to, data: {} })
      },
    } as unknown as MailClient
    const policy = new Enforcement({ store, mail, contact: 'help@example.com', now: () => now })

    for (let day = 1; day <= 3; day += 1) {
      policy.observe({ identity: `account:${hash}`, day: `2026-10-0${day}`, bytes: 600 * 1024 * 1024, reason: 'quota' })
      await policy.settle()
      now += 86_400_000
    }
    const warned = store.findUser(userId)
    expect(warned?.warnings).toHaveLength(3)
    expect(warned?.disabled).toBe(false)
    expect(sent.filter((mail) => mail.kind === 'warning')).toHaveLength(3)

    policy.observe({ identity: `account:${hash}`, day: '2026-10-04', bytes: 600 * 1024 * 1024, reason: 'quota' })
    await policy.settle()
    const banned = store.findUser(userId)
    expect(banned?.disabled).toBe(true)
    expect(banned?.ban?.by).toBe('auto')
    expect(sent.filter((mail) => mail.kind === 'banned')).toHaveLength(1)
  })

  it('counts one decision per day and clears warnings on unban', async () => {
    const { userId, hash } = await account()
    const policy = new Enforcement({ store, mail: null, contact: 'help@example.com', now: () => now })
    policy.observe({ identity: `account:${hash}`, day: '2026-10-01', bytes: 1, reason: 'volume' })
    policy.observe({ identity: `account:${hash}`, day: '2026-10-01', bytes: 1, reason: 'volume' })
    await policy.settle()
    expect(store.findUser(userId)?.warnings).toHaveLength(1)

    await store.setDisabled(userId, true, { reason: 'admin', bytes: 0, by: 'admin' })
    await store.setDisabled(userId, false)
    const restored = store.findUser(userId)
    expect(restored?.disabled).toBe(false)
    expect(restored?.warnings).toHaveLength(0)
    expect(restored?.ban).toBeNull()
  })

  it('does not warn a session that no longer exists', async () => {
    const policy = new Enforcement({ store, mail: null, contact: 'help@example.com', now: () => now })
    policy.observe({ identity: 'account:' + 'f'.repeat(64), day: '2026-10-01', bytes: 1, reason: 'volume' })
    await policy.settle()
    expect(store.allUsers().every((user) => user.warnings.length === 0)).toBe(true)
  })

  it('says so in the log for an identity with no account, instead of dropping it silently', async () => {
    // A free relay's callers are `guest:`/`anon:` headers, and its reports land
    // here with those identities attached. There is nothing to warn and nothing
    // to ban, but the operator still needs to see the abuse -- silence turned
    // anonymous runaway traffic into a non-event.
    const lines: string[] = []
    const policy = new Enforcement({
      store,
      mail: null,
      contact: 'help@example.com',
      now: () => now,
      log: (message) => lines.push(message),
    })
    policy.observe({ identity: 'guest:rotating-header', day: '2026-10-01', bytes: 600 * 1024 * 1024, reason: 'quota' })
    policy.observe({ identity: 'anon:' + 'a'.repeat(16), day: '2026-10-01', bytes: 600 * 1024 * 1024, reason: 'volume' })
    await policy.settle()
    expect(lines.filter((line) => line.includes('carries no account'))).toHaveLength(2)
    // And the silence of the policy itself: no warnings, no bans, no mail.
    expect(store.allUsers().every((user) => user.warnings.length === 0)).toBe(true)
    expect(store.allUsers().every((user) => !user.disabled)).toBe(true)
  })
})

describe('device roster', () => {
  it('does not leave two identical devices after a sign-out and a re-login', async () => {
    const first = await account()
    // Signing out revokes the device record; signing back in under a new
    // install id (a reinstall that lost its defaults) must not leave it behind.
    await store.logout(first.token)
    const again = await store.login({
      identifier: 'policy@example.com',
      password: 'password123',
      device: { ...DEVICE, id: 'test-device-02' },
    })
    expect(again.user.id).toBe(first.userId)
    expect(again.user.devices).toHaveLength(1)
    expect(again.user.devices[0]?.id).toBe('test-device-02')
    expect(again.user.devices[0]?.revokedAt).toBeUndefined()
  })

  it('keeps two live devices that happen to share a name apart', async () => {
    await account()
    await store.login({
      identifier: 'policy@example.com',
      password: 'password123',
      device: { ...DEVICE, id: 'test-device-02' },
    })
    // Both are live with the same name and model: two phones, not one.
    const listed = store.allUsers()[0]
    expect(listed?.devices.length).toBe(2)
  })
})

describe('tencent mail transport', () => {
  it('signs the request and sends a template id', async () => {
    let captured: { headers: Record<string, string>; body: string } | null = null
    const transport = new TencentMailTransport({
      secretId: 'AKIDtest',
      secretKey: 'secret',
      region: 'ap-hongkong',
      from: 'DSH-Mizar <noreply@example.com>',
      replyTo: 'help@example.com',
      fetchImpl: (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        captured = { headers: init.headers, body: init.body }
        return new Response(JSON.stringify({ Response: { MessageId: 'id-1', RequestId: 'r-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    const mail = renderMail(
      { kind: 'verification', to: 'a@example.com', data: { code: '123456', minutes: '10' } },
      { verification: 1, warning: 2, banned: 3 },
    )
    const result = await transport.send(mail)
    expect(result.id).toBe('id-1')
    expect(captured?.headers['X-TC-Region']).toBe('ap-hongkong')
    expect(captured?.headers.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDtest\//)
    expect(JSON.parse(captured?.body ?? '{}').Template.TemplateID).toBe(1)
  })
})
