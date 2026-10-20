/**
 * The paid gate, against a real store and a real relay.
 *
 * Two kinds of fact live here. The unit half pins the decisions themselves --
 * which token is refused, with which status, and when a cached answer stops
 * being true. The integration half pins the thing an operator actually cares
 * about: a free account cannot put a byte through the paid relay, and a paying
 * one can.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { PaidGate, isGateExempt } from '../src/accounts/gate.js'
import { hashPassword } from '../src/accounts/passwords.js'
import { AccountStore } from '../src/accounts/store.js'
import type { RelayConfig } from '../src/config.js'
import { startRelay, type Relay } from '../src/index.js'
import { deriveRoom } from '../src/room.js'
import { APPSTORE_NOW, APPSTORE_TEST_ROOT, signTransaction } from './appstore-helpers.js'

const TOKEN = 'paid-gate-tunnel-token'
const ROOM = deriveRoom(TOKEN)
const FAST = { N: 1024, r: 8, p: 1 }

let relay: Relay | undefined
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-gate-'))
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
    tokens: [TOKEN],
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
      adminPasswordHash: '',
      internalSecret: 'internal-test-secret',
      reportTo: '',
      reportId: 'gate-test',
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
      paidGate: { mode: 'enforce', allowUnaccounted: false, cacheTtlMs: 60_000 },
    },
    ...overrides,
  }
}

async function boot(overrides: Partial<RelayConfig> = {}): Promise<string> {
  const base = config(overrides)
  if (base.accounts !== null && base.accounts.adminPasswordHash === '') {
    base.accounts = { ...base.accounts, adminPasswordHash: await hashPassword('admin-password', FAST) }
  }
  relay = await startRelay(base, () => undefined, {
    now: () => APPSTORE_NOW,
    passwordParams: FAST,
    appstoreRoots: [APPSTORE_TEST_ROOT],
  })
  return `http://127.0.0.1:${relay.port}`
}
/** A stand-in for the computer: answers streams by echo, and remembers what it saw. */
class FakeMac {
  readonly room: string
  readonly requests: Array<Record<string, unknown>> = []
  readonly #socket: WebSocket

  private constructor(socket: WebSocket, room: string) {
    this.#socket = socket
    this.room = room
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      if (frame['t'] === 'welcome') return
      if (frame['t'] === 'ping') {
        socket.send(JSON.stringify({ t: 'pong', id: frame['id'] }))
        return
      }
      this.requests.push(frame)
      if (frame['t'] === 'ws-open') {
        socket.send(JSON.stringify({ t: 'ws-open-ok', id: frame['id'] }))
        return
      }
      if (frame['t'] === 'ws-msg') {
        const text = Buffer.from(String(frame['data']), 'base64').toString('utf8')
        socket.send(
          JSON.stringify({
            t: 'ws-msg',
            id: frame['id'],
            data: Buffer.from(`echo:${text}`).toString('base64'),
            binary: false,
          }),
        )
        return
      }
      if (frame['t'] === 'req') {
        socket.send(
          JSON.stringify({
            t: 'res',
            id: frame['id'],
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
          }),
        )
      }
    })
  }

  static async connect(url: string): Promise<FakeMac> {
    const socket = new WebSocket(`${url}/tunnel`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))))
      socket.once('error', reject)
    })
    return new FakeMac(socket, String(welcome['room']))
  }
}

async function register(base: string, username = 'shirazu'): Promise<{ token: string; id: string }> {
  const response = await fetch(`${base}/account/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      password: 'correct horse battery',
      device: { id: `device-${username}`, name: 'iPhone', model: 'iPhone18,1', platform: 'ios', appVersion: '0.10.0' },
    }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { token: string; user: { id: string } }
  return { token: body.token, id: body.user.id }
}

async function makePaid(base: string, token: string, userId: string, transactionId: string): Promise<void> {
  const response = await fetch(`${base}/account/v1/appstore/transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      signedTransaction: signTransaction({ appAccountToken: userId, transactionId }),
    }),
  })
  expect(response.status).toBe(200)
}

/** Try a WebSocket upgrade, and report the status it was refused with. */
async function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  const socket = new WebSocket(url, { headers })
  return new Promise<number>((resolve, reject) => {
    socket.once('open', () => {
      socket.close()
      resolve(101)
    })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('error', (error) => {
      // A refused upgrade surfaces as `unexpected-response`; anything else is a
      // real failure of the test harness.
      if (String(error.message).includes('Unexpected server response')) return
      reject(error)
    })
  })
}

/** The store behind one relay, for the unit half. */
async function openStore(now: () => number = () => APPSTORE_NOW): Promise<AccountStore> {
  return AccountStore.open({
    dataDir: dir,
    now,
    passwordParams: FAST,
    gravatar: { enabled: false, baseURLs: [] },
    apple: { audiences: ['me.shirazu.dshmizar'], keysURL: 'https://appleid.test/auth/keys' },
    appstore: {
      bundleId: 'me.shirazu.dshmizar',
      productId: 'me.shirazu.dshmizar.paid.monthly',
      allowSandbox: true,
    },
    appstoreRoots: [APPSTORE_TEST_ROOT],
  })
}

describe('PaidGate decisions', () => {
  it('exempts only the pre-pairing handshake', () => {
    expect(isGateExempt('/mizar/v1/pair')).toBe(true)
    expect(isGateExempt('/mizar/v1/pair?x=1')).toBe(true)
    expect(isGateExempt('/mizar/v1/pair/')).toBe(true)
    expect(isGateExempt('/mizar/v1/hello')).toBe(true)
    expect(isGateExempt('/mizar/v1/ws')).toBe(false)
    expect(isGateExempt('/mizar/v1/sessions')).toBe(false)
  })

  it('refuses a phone with no session, and lets one through when unaccounted is allowed', async () => {
    const store = await openStore()
    const strict = new PaidGate({ store, mode: 'enforce', allowUnaccounted: false, cacheTtlMs: 60_000 })
    const decision = strict.authorize({})
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.status).toBe(401)
      expect(decision.code).toBe('UNAUTHENTICATED')
    }

    const lenient = new PaidGate({ store, mode: 'enforce', allowUnaccounted: true, cacheTtlMs: 60_000 })
    expect(lenient.authorize({}).allowed).toBe(true)
  })

  it('refuses a free account and allows a paid one', async () => {
    const store = await openStore()
    const { token, user } = await store.register({
      username: 'shirazu',
      email: 'shirazu@example.com',
      password: 'correct horse battery',
      device: { id: 'device-0001', name: 'iPhone', model: 'iPhone18,1', platform: 'ios', appVersion: '0.10.0' },
    })
    const gate = new PaidGate({ store, mode: 'enforce', allowUnaccounted: false, cacheTtlMs: 60_000 })

    const free = gate.authorize({ 'x-mizar-session': token })
    expect(free.allowed).toBe(false)
    if (!free.allowed) {
      expect(free.status).toBe(402)
      expect(free.code).toBe('PAID_REQUIRED')
    }

    await store.setGrant(user.id, 30)
    const paid = gate.authorize({ 'x-mizar-session': token })
    expect(paid.allowed).toBe(true)
    if (paid.allowed) {
      expect(paid.userId).toBe(user.id)
      expect(paid.cached).toBe(false)
    }

    // Second call is served from the cache; the third after a downgrade is not.
    const cached = gate.authorize({ 'x-mizar-session': token })
    expect(cached.allowed && cached.cached).toBe(true)
    await store.setGrant(user.id, null)
    const downgraded = gate.authorize({ 'x-mizar-session': token })
    expect(downgraded.allowed).toBe(false)
  })

  it('refuses a revoked session', async () => {
    const store = await openStore()
    const { token, user } = await store.register({
      username: 'shirazu',
      email: 'shirazu@example.com',
      password: 'correct horse battery',
      device: { id: 'device-0001', name: 'iPhone', model: 'iPhone18,1', platform: 'ios', appVersion: '0.10.0' },
    })
    await store.setGrant(user.id, 30)
    const gate = new PaidGate({ store, mode: 'enforce', allowUnaccounted: false, cacheTtlMs: 60_000 })
    expect(gate.authorize({ 'x-mizar-session': token }).allowed).toBe(true)

    await store.logout(token)
    const revoked = gate.authorize({ 'x-mizar-session': token })
    expect(revoked.allowed).toBe(false)
    if (!revoked.allowed) expect(revoked.code).toBe('SESSION_REVOKED')
  })

  it('refuses a token it never issued without touching the store twice', async () => {
    const store = await openStore()
    const gate = new PaidGate({ store, mode: 'enforce', allowUnaccounted: false, cacheTtlMs: 60_000 })
    const decision = gate.authorize({ 'x-mizar-session': 'mza_not-a-real-token-at-all' })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.code).toBe('UNAUTHENTICATED')
    // A malformed header never reaches the store as a token.
    expect(gate.authorize({ 'x-mizar-session': 'short' }).allowed).toBe(false)
  })

  it('counts refusals without blocking in observe mode', async () => {
    const store = await openStore()
    await store.register({
      username: 'shirazu',
      email: 'shirazu@example.com',
      password: 'correct horse battery',
      device: { id: 'device-0001', name: 'iPhone', model: 'iPhone18,1', platform: 'ios', appVersion: '0.10.0' },
    })
    const gate = new PaidGate({ store, mode: 'observe', allowUnaccounted: false, cacheTtlMs: 60_000 })
    const decision = gate.authorize({ 'x-mizar-session': 'mza_someone-elses-token' })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.observed?.code).toBe('UNAUTHENTICATED')
    expect(gate.stats.observed).toBe(1)
    expect(gate.stats.refused).toBe(0)
  })
})

describe('the paid relay over HTTP', () => {
  it('refuses a free account before the computer is asked anything', async () => {
    const base = await boot()
    const mac = await FakeMac.connect(base)
    expect(mac.room).toBe(ROOM)
    const { token } = await register(base)

    const response = await fetch(`${base}/r/${ROOM}/mizar/v1/sessions`, {
      headers: { 'x-mizar-session': token },
    })
    expect(response.status).toBe(402)
    expect(response.headers.get('x-mizar-gate')).toBe('PAID_REQUIRED')
    expect(mac.requests).toHaveLength(0)
  })

  it('refuses a request with no session at all', async () => {
    const base = await boot()
    await FakeMac.connect(base)
    const response = await fetch(`${base}/r/${ROOM}/mizar/v1/sessions`)
    expect(response.status).toBe(401)
    expect(response.headers.get('x-mizar-gate')).toBe('UNAUTHENTICATED')
  })

  it('carries a paid account, and never forwards the session token', async () => {
    const base = await boot()
    const mac = await FakeMac.connect(base)
    const { token, id } = await register(base)
    await makePaid(base, token, id, 'tx-gate-1')

    const response = await fetch(`${base}/r/${ROOM}/mizar/v1/sessions`, {
      headers: { 'x-mizar-session': token, 'x-mizar-account': 'a'.repeat(64) },
    })
    expect(response.status).toBe(200)
    expect(mac.requests).toHaveLength(1)
    const frame = mac.requests[0] as { headers: Record<string, string> }
    expect(frame.headers['x-mizar-session']).toBeUndefined()
    expect(frame.headers['x-mizar-account']).toBeUndefined()
    expect(frame.headers['x-mizar-client-id']).toBeUndefined()
  })

  it('lets the pre-pairing handshake through for an account that is not paying', async () => {
    const base = await boot()
    const mac = await FakeMac.connect(base)
    const { token } = await register(base)

    for (const path of ['hello', 'pair']) {
      const response = await fetch(`${base}/r/${ROOM}/mizar/v1/${path}`, {
        headers: { 'x-mizar-session': token },
      })
      expect(response.status).toBe(200)
    }
    expect(mac.requests).toHaveLength(2)
  })

  it('refuses the session socket for a free account, and carries a paid one', async () => {
    const base = await boot()
    await FakeMac.connect(base)
    const { token, id } = await register(base)

    const refused = await upgradeStatus(`ws://127.0.0.1:${new URL(base).port}/r/${ROOM}/mizar/v1/ws`, {
      'x-mizar-session': token,
    })
    expect(refused).toBe(402)

    await makePaid(base, token, id, 'tx-gate-2')
    const accepted = await upgradeStatus(`ws://127.0.0.1:${new URL(base).port}/r/${ROOM}/mizar/v1/ws`, {
      'x-mizar-session': token,
    })
    expect(accepted).toBe(101)
  })

  it('lets a free account through in observe mode and reports the gate as observing', async () => {
    const base = await boot({
      accounts: {
        ...(config().accounts as NonNullable<RelayConfig['accounts']>),
        paidGate: { mode: 'observe', allowUnaccounted: false, cacheTtlMs: 60_000 },
      },
    })
    await FakeMac.connect(base)
    const { token } = await register(base)

    const response = await fetch(`${base}/r/${ROOM}/mizar/v1/sessions`, {
      headers: { 'x-mizar-session': token },
    })
    expect(response.status).toBe(200)

    const health = await fetch(`${base}/healthz`)
    const body = (await health.json()) as Record<string, unknown>
    expect(body['paidGate']).toBe('observe')
  })

  it('reports the gate as enforcing on a relay that enforces', async () => {
    const base = await boot()
    const health = await fetch(`${base}/healthz`)
    const body = (await health.json()) as Record<string, unknown>
    expect(body['paidGate']).toBe('enforce')
  })

  it('refuses to start a gate that has no store to check against', async () => {
    const broken = config()
    broken.accounts = { ...(broken.accounts as NonNullable<RelayConfig['accounts']>), enabled: false }
    await expect(startRelay(broken, () => undefined)).rejects.toThrow(/no account store/)
  })
})
