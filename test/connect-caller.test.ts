/**
 * The second relay's local `/account/v1/connect` (port 8443 in production).
 *
 * The phone's account API still goes to the account-gated instance, and that
 * instance answers `/connect` locally: it verifies the session against the
 * origin relay and provisions through its own tunnel registry. The origin's
 * `/me` marks the session's own device `current` when the request carries no
 * `x-mizar-client-id`, which is the identity this handler must name the token
 * slot after. iOS 0.9.9 sends no such header.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'

let relay: Relay | undefined
let upstream: Server | undefined
let dir = ''

/** Session token → the device it was issued to. */
const SESSIONS: Record<string, string> = {
  'session-phone-1': 'phone-1',
  'session-phone-2': 'phone-2',
  'session-mac-1': 'mac-1',
}

const DEVICES = [
  { id: 'phone-1', name: 'iPhone', model: 'iPhone17,1', platform: 'ios' },
  { id: 'phone-2', name: 'iPad', model: 'iPad16,4', platform: 'ios' },
  { id: 'mac-1', name: 'Mac mini', model: 'Mac', platform: 'macos' },
] as const

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-connect-caller-'))
})

afterEach(async () => {
  await relay?.close()
  relay = undefined
  await new Promise<void>((resolve) => {
    if (upstream === undefined) return resolve()
    upstream.close(() => resolve())
  })
  upstream = undefined
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

function config(upstreamURL: string): RelayConfig {
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
      enabled: false,
      dataDir: dir,
      adminPasswordHash: 'unused',
      internalSecret: 'internal-test-secret',
      reportTo: '',
      reportId: 'test-second-relay',
      upstreamURL,
      requireSession: true,
      paidGate: { mode: 'off', allowUnaccounted: false, cacheTtlMs: 60_000 },
      gravatar: { enabled: false, baseURLs: [] },
      appleAudiences: [],
      appleKeysURL: 'https://appleid.apple.com/auth/keys',
      appstore: {
        bundleId: 'me.shirazu.dshmizar',
        productId: 'me.shirazu.dshmizar.paid.monthly',
        allowSandbox: true,
        notificationsEnabled: true,
      },
      publicBaseURL: 'http://127.0.0.1',
      github: null,
      appleWeb: null,
    },
  }
}

/** Boot a fake origin relay that answers `/me` the way the account store does. */
async function bootUpstream(): Promise<string> {
  upstream = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url !== '/account/v1/me') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const sessionDevice = SESSIONS[bearer]
    if (sessionDevice === undefined) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"UNAUTHENTICATED"}')
      return
    }
    // What the store's `me(token, currentDeviceId ?? session.deviceId)` does.
    const header = request.headers['x-mizar-client-id']
    const current = typeof header === 'string' && header !== '' ? header : sessionDevice
    const body = JSON.stringify({
      user: {
        id: 'user-1',
        username: 'shirazu',
        plan: 'paid',
        devices: DEVICES.map((device) => ({ ...device, current: device.id === current })),
      },
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', () => resolve()))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('the fake upstream has no port')
  return `http://127.0.0.1:${address.port}/account/v1`
}

/** Open the desktop tunnel and answer every provision frame. */
async function openTunnel(base: string): Promise<{ socket: WebSocket; provisioned: string[] }> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/tunnel`, {
    headers: {
      authorization: 'Bearer account-test-token',
      'x-mizar-session': 'session-mac-1',
      'x-mizar-client-id': 'mac-1',
    },
  })
  const provisioned: string[] = []
  socket.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as {
      t?: string
      id?: string
      phoneDeviceId?: string
    }
    if (frame.t === 'provision' && typeof frame.id === 'string') {
      if (typeof frame.phoneDeviceId === 'string') provisioned.push(frame.phoneDeviceId)
      socket.send(JSON.stringify({ t: 'provision-result', id: frame.id, token: 'mz_local' }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('message', () => resolve())
    socket.once('error', reject)
  })
  // Presence is set after the tunnel's session is checked upstream.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await fetch(`${base}/account/v1/desktops`, {
      headers: { authorization: 'Bearer session-phone-1' },
    })
    const body = (await listed.json()) as { desktops?: Record<string, unknown>[] }
    if (body.desktops?.[0]?.['online'] === true) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { socket, provisioned }
}

async function connect(
  base: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${base}/account/v1/connect`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ deviceId: 'mac-1' }),
  })
}

describe('the second relay\'s local /connect', () => {
  it('names the token slot after the session device, not one shared "phone"', async () => {
    const upstreamURL = await bootUpstream()
    relay = await startRelay(config(upstreamURL), () => undefined, {})
    const base = `http://127.0.0.1:${relay.port}`
    const { socket, provisioned } = await openTunnel(base)

    // iOS 0.9.9: no x-mizar-client-id. The first phone's session names phone-1.
    const first = await connect(base, 'session-phone-1')
    expect(first.status).toBe(200)
    expect(provisioned.at(-1)).toBe('phone-1')
    expect(((await first.json()) as Record<string, unknown>)['token']).toBe('mz_local')

    // The same account on another phone must not reuse — and revoke — phone-1's slot.
    const second = await connect(base, 'session-phone-2')
    expect(second.status).toBe(200)
    expect(provisioned.at(-1)).toBe('phone-2')

    // An explicit header still wins over the session's device.
    const explicit = await connect(base, 'session-phone-2', { 'x-mizar-client-id': 'phone-1' })
    expect(explicit.status).toBe(200)
    expect(provisioned.at(-1)).toBe('phone-1')

    expect(provisioned).toEqual(['phone-1', 'phone-2', 'phone-1'])
    socket.close()
  })
})
