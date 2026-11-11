/**
 * The account API, over HTTP, against a real relay.
 *
 * These are the facts a phone feels: registration/login, the bearer session, the
 * two-device cap, invite redemption, and the App Store transaction path into
 * `plan=paid`. The unit tests cover the store's arithmetic; this file proves the
 * routes, status codes, and cookie/CSRF plumbing actually line up.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startRelay, type Relay, type RelayDependencies } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import { hashPassword } from '../src/accounts/passwords.js'
import { generateLanCA } from '../src/accounts/lan.js'
import {
  APPSTORE_NOW,
  APPSTORE_TEST_ROOT,
  signNotification,
  signTransaction,
} from './appstore-helpers.js'

let relay: Relay | undefined
let dir = ''
let adminHash = ''
let adminCookie = ''

const NOW = APPSTORE_NOW
const FAST = { N: 1024, r: 8, p: 1 }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-accounts-'))
  adminHash = await hashPassword('admin-password', FAST)
  adminCookie = ''
})

afterEach(async () => {
  await relay?.close()
  relay = undefined
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    tokens: ['account-test-token'],
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
      appleKeysURL: 'https://appleid.apple.com/auth/keys',
      appstore: {
        bundleId: 'me.shirazu.dshmizar',
        productId: 'me.shirazu.dshmizar.paid.monthly',
        allowSandbox: true,
        notificationsEnabled: true,
      },
      publicBaseURL: 'https://accounts.test',
      paidGate: { mode: 'off', allowUnaccounted: false, cacheTtlMs: 60_000 },
    },
    ...overrides,
  }
}

async function boot(
  overrides: Partial<RelayConfig> = {},
  deps: RelayDependencies = {},
): Promise<string> {
  relay = await startRelay(config(overrides), () => undefined, {
    now: () => NOW,
    passwordParams: FAST,
    appstoreRoots: [APPSTORE_TEST_ROOT],
    ...deps,
  })
  return `http://127.0.0.1:${relay.port}`
}

function device(id: string): Record<string, string> {
  return { id, name: `iPhone ${id}`, model: 'iPhone18,1', platform: 'ios', appVersion: '0.10.0' }
}

async function json(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers }
}

async function register(base: string, deviceId = 'device-0001'): Promise<{ token: string; user: Record<string, unknown> }> {
  const reply = await json(base, '/account/v1/register', {
    username: 'shirazu',
    email: 'shirazu@example.com',
    password: 'correct horse battery',
    device: device(deviceId),
  })
  expect(reply.status).toBe(200)
  return { token: String(reply.body['token']), user: reply.body['user'] as Record<string, unknown> }
}

async function adminLogin(base: string): Promise<string> {
  const response = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-password' }),
    redirect: 'manual',
  })
  expect(response.status).toBe(303)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).not.toBeNull()
  return String(cookie).split(';')[0] ?? ''
}

async function csrfFor(base: string, cookie: string, path = '/admin/invites'): Promise<string> {
  const response = await fetch(`${base}${path}`, { headers: { cookie } })
  const html = await response.text()
  const match = /name="_csrf" value="([^"]+)"/.exec(html)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

describe('registration and login', () => {
  it('registers a free account with a generated avatar and a working session', async () => {
    const base = await boot()
    const { token, user } = await register(base)
    expect(token.startsWith('mza_')).toBe(true)
    expect(user['plan']).toBe('free')
    expect((user['avatar'] as Record<string, unknown>)['kind']).toBe('generated')
    const me = await fetch(`${base}/account/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: Record<string, unknown> }
    expect(body.user['username']).toBe('shirazu')
  })


  it('brokers a token from a connected desktop of the same account', async () => {
    const base = await boot()
    const { token } = await register(base) // the phone: device-0001, ios

    // The desktop signs in as a second device of the same account.
    const mac = await json(base, '/account/v1/login', {
      identifier: 'shirazu',
      password: 'correct horse battery',
      device: { id: 'device-0002', name: 'Mac mini', model: 'Mac', platform: 'macos', appVersion: '0.1.0' },
    })
    expect(mac.status).toBe(200)
    const macToken = String(mac.body['token'])

    const socket = new WebSocket(`${base.replace('http', 'ws')}/tunnel`, {
      headers: {
        authorization: 'Bearer account-test-token',
        'x-mizar-session': macToken,
        'x-mizar-client-id': 'device-0002',
      },
    })
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))))
      socket.once('error', reject)
    })
    const room = String(welcome['room'])
    const provisionedFor: string[] = []
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as {
        t?: string
        id?: string
        phoneDeviceId?: string
      }
      if (frame.t === 'provision' && typeof frame.id === 'string') {
        if (typeof frame.phoneDeviceId === 'string') provisionedFor.push(frame.phoneDeviceId)
        socket.send(JSON.stringify({ t: 'provision-result', id: frame.id, token: 'mz_issued_for_phone' }))
      }
    })

    // Presence arrives asynchronously, after the account session is checked.
    const desktops = async (): Promise<Record<string, unknown>[]> => {
      const response = await fetch(`${base}/account/v1/desktops`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { desktops: Record<string, unknown>[] }).desktops
    }
    let listed: Record<string, unknown>[] = []
    for (let attempt = 0; attempt < 100; attempt += 1) {
      listed = await desktops()
      if (listed.some((entry) => entry['online'] === true)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(listed).toHaveLength(1)
    expect(listed[0]?.['deviceId']).toBe('device-0002')
    expect(listed[0]?.['online']).toBe(true)
    expect(listed[0]?.['room']).toBe(room)

    const connect = await json(base, '/account/v1/connect', { deviceId: 'device-0002' }, token)
    expect(connect.status).toBe(200)
    expect(connect.body['token']).toBe('mz_issued_for_phone')
    expect(connect.body['room']).toBe(room)
    // The call carried no x-mizar-client-id (the shape iOS 0.9.9 sends). The
    // session's own device id must name the token slot, not a shared "phone".
    expect(provisionedFor.at(-1)).toBe('device-0001')

    // A desktop peer is a paid capability; this account is still free.
    const peerOnFree = await fetch(`${base}/account/v1/connect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${macToken}`,
        'x-mizar-client-id': 'device-0002',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deviceId: 'device-0002', engine: 'dsh', kind: 'peer' }),
    })
    expect(peerOnFree.status).toBe(402)
    expect(((await peerOnFree.json()) as Record<string, unknown>)['error']).toBe('PAID_REQUIRED')

    // A phone still uses the free path, even when the target is a desktop.
    const phoneConnect = await json(base, '/account/v1/connect', { deviceId: 'device-0002' }, token)
    expect(phoneConnect.status).toBe(200)
    expect(phoneConnect.body['token']).toBe('mz_issued_for_phone')

    // A device that is not on this account is refused.
    const stranger = await json(base, '/account/v1/connect', { deviceId: 'device-9' }, token)
    expect(stranger.status).toBe(404)

    socket.close()
  })


  it('carries no anonymous traffic when requireSession is on', async () => {
    const base = await boot({
      accounts: {
        ...config().accounts!,
        requireSession: true,
      },
    })
    // The tunnel itself refuses a desktop with no session.
    const bare = new WebSocket(`${base.replace('http', 'ws')}/tunnel`, {
      headers: { authorization: 'Bearer account-test-token' },
    })
    const refused = await new Promise<number>((resolve) => {
      bare.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
      bare.once('open', () => resolve(0))
      bare.once('error', () => resolve(-1))
    })
    expect(refused).toBe(401)

    const { token } = await register(base)
    const socket = new WebSocket(`${base.replace('http', 'ws')}/tunnel`, {
      headers: {
        authorization: 'Bearer account-test-token',
        'x-mizar-session': token,
        'x-mizar-client-id': 'device-0001',
      },
    })
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))))
      socket.once('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as { t?: string; id?: string; path?: string }
      if (frame.t === 'req' && typeof frame.id === 'string') {
        socket.send(
          JSON.stringify({
            t: 'res',
            id: frame.id,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ path: frame.path })).toString('base64'),
          }),
        )
      }
    })

    const anonymous = await fetch(`${base}/r/${String(welcome['room'])}/mizar/v1/hello`)
    expect(anonymous.status).toBe(401)

    const signedIn = await fetch(`${base}/r/${String(welcome['room'])}/mizar/v1/hello`, {
      headers: { 'x-mizar-session': token, 'x-mizar-client-id': 'device-0001' },
    })
    expect(signedIn.status).toBe(200)
    expect(((await signedIn.json()) as { path: string }).path).toBe('/mizar/v1/hello')

    socket.close()
  })

  it('refuses a duplicate username or email', async () => {
    const base = await boot()
    await register(base)
    const duplicate = await json(base, '/account/v1/register', {
      username: 'shirazu',
      email: 'other@example.com',
      password: 'correct horse battery',
      device: device('device-0002'),
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body['error']).toBe('USERNAME_TAKEN')
  })

  it('logs in and refuses the wrong password', async () => {
    const base = await boot()
    await register(base)
    const wrong = await json(base, '/account/v1/login', {
      identifier: 'shirazu@example.com',
      password: 'wrong password',
      device: device('device-0002'),
    })
    expect(wrong.status).toBe(401)
    const right = await json(base, '/account/v1/login', {
      identifier: 'shirazu@example.com',
      password: 'correct horse battery',
      device: device('device-0002'),
    })
    expect(right.status).toBe(200)
    expect(String(right.body['token']).startsWith('mza_')).toBe(true)
  })

  it('revokes the oldest device on the third password login', async () => {
    const base = await boot()
    const first = await register(base, 'device-0001')
    const second = await json(base, '/account/v1/login', {
      identifier: 'shirazu',
      password: 'correct horse battery',
      device: device('device-0002'),
    })
    expect(second.status).toBe(200)
    const third = await json(base, '/account/v1/login', {
      identifier: 'shirazu',
      password: 'correct horse battery',
      device: device('device-0003'),
    })
    expect(third.status).toBe(200)
    expect((third.body['notice'] as Record<string, unknown>)['code']).toBe('DEVICE_LIMIT')
    const firstSession = await fetch(`${base}/account/v1/me`, {
      headers: { authorization: `Bearer ${first.token}` },
    })
    expect(firstSession.status).toBe(401)
    const thirdMe = await fetch(`${base}/account/v1/me`, {
      headers: { authorization: `Bearer ${String(third.body['token'])}` },
    })
    expect(thirdMe.status).toBe(200)
  })

  it('logs out, and a logged-out token stops working', async () => {
    const base = await boot()
    const { token } = await register(base)
    const out = await json(base, '/account/v1/logout', {}, token)
    expect(out.status).toBe(200)
    const me = await fetch(`${base}/account/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    expect(me.status).toBe(401)
  })
})

describe('invites and admin', () => {
  it('creates an invite in the admin UI and redeems it twice', async () => {
    const base = await boot()
    const { token, user } = await register(base)
    const cookie = await adminLogin(base)
    const csrf = await csrfFor(base, cookie)
    const created = await fetch(`${base}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ _csrf: csrf, code: 'MZ-TESTCODE', days: '30', maxUses: '2' }),
      redirect: 'manual',
    })
    expect(created.status).toBe(303)

    const first = await json(base, '/account/v1/invite/redeem', { code: 'MZ-TESTCODE' }, token)
    expect(first.status).toBe(200)
    expect((first.body['user'] as Record<string, unknown>)['plan']).toBe('paid')
    const second = await json(base, '/account/v1/invite/redeem', { code: 'MZ-TESTCODE' }, token)
    expect(second.status).toBe(200)
    const paidUntil = (second.body['user'] as Record<string, unknown>)['paidUntil'] as number
    expect(paidUntil).toBeGreaterThan(NOW + 59 * 86_400_000)
    expect(user['plan']).toBe('free')
  })

  it('lists every account that used a once-per-account code, and the total', async () => {
    // The TestFlight code is one per account for a thousand accounts: the
    // admin page is the only place the operator can see who actually used it.
    const base = await boot()
    const cookie = await adminLogin(base)
    const csrf = await csrfFor(base, cookie)
    const created = await fetch(`${base}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({
        _csrf: csrf,
        code: 'TESTFLIGHT-30',
        days: '30',
        maxUses: '1000',
        oncePerAccount: '1',
      }),
      redirect: 'manual',
    })
    expect(created.status).toBe(303)

    const first = await register(base, 'device-0001')
    const redeemed = await json(base, '/account/v1/invite/redeem', { code: 'TESTFLIGHT-30' }, first.token)
    expect(redeemed.status).toBe(200)
    const again = await json(base, '/account/v1/invite/redeem', { code: 'TESTFLIGHT-30' }, first.token)
    expect(again.status).toBe(400)

    // A second account can use the same code.
    const second = await json(base, '/account/v1/register', {
      username: 'second',
      email: 'second@example.com',
      password: 'correct horse battery',
      device: device('device-0002'),
    })
    const other = await json(base, '/account/v1/invite/redeem', { code: 'TESTFLIGHT-30' }, String(second.body['token']))
    expect(other.status).toBe(200)

    const page = await fetch(`${base}/admin/invites/TESTFLIGHT-30`, { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('TESTFLIGHT-30')
    expect(html).toContain('shirazu')
    expect(html).toContain('second')
    // Total uses, not just the rows.
    expect(html).toMatch(/已用\s*2\s*\/\s*1000/)
  })

  it('refuses to mint an invite code too short to guess-resistant', async () => {
    // A code is a bearer capability for paid days, so it is held to the same
    // bar the generated ones are: a four-character code is 20 bits and the
    // redeem endpoint is reachable by any signed-in account.
    const base = await boot()
    await register(base)
    const cookie = await adminLogin(base)
    const csrf = await csrfFor(base, cookie)
    const short = await fetch(`${base}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ _csrf: csrf, code: 'ABCD', days: '30', maxUses: '1' }),
      redirect: 'manual',
    })
    // Rejected before it reaches the store: the admin form answers with a
    // notice rather than minting a guessable code.
    expect(short.status).toBeGreaterThanOrEqual(400)
  })

  it('serves the admin user and traffic pages without leaking secrets', async () => {
    const base = await boot()
    await register(base)
    const cookie = await adminLogin(base)
    const users = await fetch(`${base}/admin/users`, { headers: { cookie } })
    const html = await users.text()
    expect(users.status).toBe(200)
    expect(html).toContain('shirazu')
    expect(html).not.toContain('passwordHash')
    expect(html).not.toContain('correct horse battery')
    const traffic = await fetch(`${base}/admin/traffic`, { headers: { cookie } })
    expect(traffic.status).toBe(200)
  })

  it('refuses the admin login with the wrong password', async () => {
    const base = await boot()
    const response = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong' }),
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('密码不正确')
  })
})

describe('App Store transactions', () => {
  it('marks the account paid from a verified transaction and revokes on refund', async () => {
    const base = await boot()
    const { token, user } = await register(base)
    const id = String(user['id'])
    const signed = signTransaction({ appAccountToken: id, transactionId: 'tx-1' })
    const paid = await json(base, '/account/v1/appstore/transaction', { signedTransaction: signed }, token)
    expect(paid.status).toBe(200)
    expect((paid.body['user'] as Record<string, unknown>)['plan']).toBe('paid')

    const refunded = signTransaction({
      appAccountToken: id,
      transactionId: 'tx-1',
      revocationDate: NOW + 1000,
    })
    const notification = signNotification('REFUND', refunded, { notificationUUID: 'refund-1' })
    const notified = await json(base, '/account/v1/appstore/notifications', { signedPayload: notification })
    expect(notified.status).toBe(200)
    const me = await fetch(`${base}/account/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    const body = (await me.json()) as { user: Record<string, unknown> }
    expect(body.user['plan']).toBe('free')
  })

  it('rejects a transaction bought for another account', async () => {
    const base = await boot()
    const { token } = await register(base)
    const signed = signTransaction({ appAccountToken: '22222222-2222-4222-8222-222222222222' })
    const reply = await json(base, '/account/v1/appstore/transaction', { signedTransaction: signed }, token)
    expect(reply.status).toBe(409)
    expect(reply.body['error']).toBe('APPSTORE_ACCOUNT_MISMATCH')
  })

  it('syncs a batch and takes the latest expiry', async () => {
    const base = await boot()
    const { token, user } = await register(base)
    const id = String(user['id'])
    const older = signTransaction({
      appAccountToken: id,
      transactionId: 'tx-old',
      expiresDate: Date.parse('2026-11-01T00:00:00Z'),
    })
    const newer = signTransaction({
      appAccountToken: id,
      transactionId: 'tx-new',
      expiresDate: Date.parse('2026-12-01T00:00:00Z'),
    })
    const reply = await json(base, '/account/v1/appstore/sync', { signedTransactions: [older, newer] }, token)
    expect(reply.status).toBe(200)
    expect((reply.body['user'] as Record<string, unknown>)['paidUntil']).toBe(Date.parse('2026-12-01T00:00:00Z'))
  })
})


describe('traffic attribution', () => {
  it('records the account hash and shows it in the admin traffic page', async () => {
    const base = await boot()
    const cookie = await adminLogin(base)
    const room = await connectFakeHost(base)
    const hash = 'a'.repeat(64)
    const response = await fetch(`${base}/r/${room}/mizar/v1/hello`, {
      headers: {
        'x-mizar-account': hash,
        'x-mizar-client-id': 'device-0001',
      },
    })
    expect(response.status).toBe(200)
    const page = await fetch(`${base}/admin/traffic`, { headers: { cookie } })
    const html = await page.text()
    expect(html).toContain(`account:${hash}`)

    const dashboard = await fetch(`${base}/admin`, { headers: { cookie } })
    const dashboardHtml = await dashboard.text()
    expect(dashboardHtml).toContain('今日流量')
  })
})

/** Connect a minimal computer that answers every replay with `{}`. */
async function connectFakeHost(base: string): Promise<string> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/tunnel`, {
    headers: { authorization: 'Bearer account-test-token' },
  })
  const welcome = await new Promise<{ room: string }>((resolve, reject) => {
    socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8')) as { room: string }))
    socket.once('error', reject)
  })
  socket.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
    if (frame['t'] === 'ping') {
      socket.send(JSON.stringify({ t: 'pong', id: frame['id'] }))
      return
    }
    if (frame['t'] !== 'req') return
    socket.send(
      JSON.stringify({
        t: 'res',
        id: frame['id'],
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}').toString('base64'),
      }),
    )
  })
  return welcome.room
}


describe('LAN device certificates', () => {
  it('signs a desktop certificate the Rust verifier can check', async () => {
    const ca = generateLanCA()
    const base = await boot({}, { lanCA: ca })
    const { token } = await register(base)
    const mac = await json(base, '/account/v1/login', {
      identifier: 'shirazu',
      password: 'correct horse battery',
      device: {
        id: 'device-0002', name: 'Mac mini', model: 'Mac', platform: 'macos',
        appVersion: '0.1.0',
      },
    })
    expect(mac.status).toBe(200)
    const macToken = String(mac.body['token'])
    const keys = {
      ed25519Public: Buffer.alloc(32, 1).toString('base64'),
      x25519Public: Buffer.alloc(32, 2).toString('base64'),
    }
    const response = await fetch(`${base}/account/v1/lan/certificate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${macToken}`,
        'x-mizar-client-id': 'device-0002',
        'content-type': 'application/json',
      },
      body: JSON.stringify(keys),
    })
    expect(response.status).toBe(200)
    const issued = (await response.json()) as {
      body: Record<string, unknown>
      signature: string
    }
    const me = await fetch(`${base}/account/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const accountId = ((await me.json()) as { user: { id: string } }).user.id
    expect(issued.body['accountId']).toBe(accountId)
    expect(issued.body['deviceId']).toBe('device-0002')
    expect(issued.body['expiresAt']).toBeGreaterThan(NOW)
    const { verify } = await import('node:crypto')
    expect(
      verify(
        null,
        Buffer.from(JSON.stringify(issued.body)),
        ca.publicKey,
        Buffer.from(issued.signature, 'base64'),
      ),
    ).toBe(true)

    // A different device id is not silently signed for this caller.
    const other = await fetch(`${base}/account/v1/lan/certificate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${macToken}`,
        'x-mizar-client-id': 'device-9999',
        'content-type': 'application/json',
      },
      body: JSON.stringify(keys),
    })
    expect(other.status).toBe(404)

    // A phone is not a LAN desktop.
    const phone = await fetch(`${base}/account/v1/lan/certificate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-mizar-client-id': 'device-0001',
        'content-type': 'application/json',
      },
      body: JSON.stringify(keys),
    })
    expect(phone.status).toBe(403)
  })

  it('answers 503 when the relay has no CA', async () => {
    const base = await boot()
    const { token } = await register(base)
    const response = await fetch(`${base}/account/v1/lan/certificate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-mizar-client-id': 'device-0001',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ed25519Public: Buffer.alloc(32, 1).toString('base64'),
        x25519Public: Buffer.alloc(32, 2).toString('base64'),
      }),
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as Record<string, unknown>)['error']).toBe('LAN_NOT_CONFIGURED')
  })
})


describe('paid desktop peers', () => {
  it('provisions a peer after an invite makes the account paid', async () => {
    const base = await boot()
    const { token } = await register(base)
    const mac = await json(base, '/account/v1/login', {
      identifier: 'shirazu',
      password: 'correct horse battery',
      device: {
        id: 'device-0002', name: 'Mac mini', model: 'Mac', platform: 'macos',
        appVersion: '0.1.0',
      },
    })
    expect(mac.status).toBe(200)
    const macToken = String(mac.body['token'])

    // An admin invite is the supported way to grant paid days in this fixture.
    const cookie = await adminLogin(base)
    const csrf = await csrfFor(base, cookie)
    const invite = await fetch(`${base}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ _csrf: csrf, code: 'MZ-PAIDPEER', days: '30', maxUses: '1' }),
      redirect: 'manual',
    })
    expect(invite.status).toBe(303)
    const redeem = await json(base, '/account/v1/invite/redeem', { code: 'MZ-PAIDPEER' }, token)
    expect(redeem.status).toBe(200)
    expect((redeem.body['user'] as Record<string, unknown>)['plan']).toBe('paid')

    const socket = new WebSocket(`${base.replace('http', 'ws')}/tunnel`, {
      headers: {
        authorization: 'Bearer account-test-token',
        'x-mizar-session': macToken,
        'x-mizar-client-id': 'device-0002',
      },
    })
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))))
      socket.once('error', reject)
    })
    const room = String(welcome['room'])
    let provision: Record<string, unknown> | null = null
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as { t?: string; id?: string; peer?: boolean }
      if (frame.t === 'provision' && typeof frame.id === 'string') {
        provision = frame as Record<string, unknown>
        socket.send(JSON.stringify({ t: 'provision-result', id: frame.id, token: 'mz_paid_peer' }))
      }
    })
    // Wait until presence lists the desktop.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await fetch(`${base}/account/v1/desktops`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const body = (await listed.json()) as { desktops?: Record<string, unknown>[] }
      if (body.desktops?.[0]?.['online'] === true) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const connect = await fetch(`${base}/account/v1/connect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${macToken}`,
        'x-mizar-client-id': 'device-0002',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deviceId: 'device-0002', engine: 'dsh', kind: 'peer' }),
    })
    expect(connect.status).toBe(200)
    const answer = (await connect.json()) as Record<string, unknown>
    expect(answer['room']).toBe(room)
    expect(answer['token']).toBe('mz_paid_peer')
    expect(provision).not.toBeNull()
    expect((provision as unknown as Record<string, unknown>)['peer']).toBe(true)
    socket.close()
  })
})
