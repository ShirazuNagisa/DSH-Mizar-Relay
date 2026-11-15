import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import { hashPassword } from '../src/accounts/passwords.js'
import {
  AttemptGuard,
  DesktopDirectory,
  UpdateMonitor,
  compareVersions,
  readDeviceHeaders,
} from '../src/selfhost.js'

/** A PIN long enough to look like what the installer prints. */
const PIN = 'K7QP3M2X'

/** The tunnel credential the fake computer presents. */
const TOKEN = 'test-tunnel-token-123456'

/** Cheap scrypt parameters: these tests care about the comparison, not the cost. */
const CHEAP = { N: 1024, r: 8, p: 1 }

/** The relay under test, torn down after each case. */
let relay: Relay | undefined

/** Sockets held open by a case, closed after it. */
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await relay?.close()
  relay = undefined
})

/** A GitHub answer that says there is a much newer release. */
const githubFetch: typeof fetch = async (input) => {
  if (String(input).includes('api.github.com')) {
    return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}

/** Build a config with no optional services turned on. */
const config = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
  port: 0,
  host: '127.0.0.1',
  tokens: [TOKEN],
  trustProxy: false,
  maxTunnelsPerIp: 4,
  maxRooms: 100,
  maxBodyBytes: 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxClientsPerRoom: 8,
  requestTimeoutMs: 2000,
  tunnelIdleMs: 60_000,
  probePort: 0,
  stunPort: 0,
  apns: null,
  fcm: null,
  role: 0,
  accounts: null,
  ...overrides,
})

/** Start a self-hosted relay with the secrets a case asks for. */
async function start(options: { pin?: string; updateToken?: string } = {}): Promise<Relay> {
  const pinHash = options.pin === undefined ? '' : await hashPassword(options.pin, CHEAP)
  const updateTokenHash =
    options.updateToken === undefined ? '' : await hashPassword(options.updateToken, CHEAP)
  relay = await startRelay(
    config({
      selfHost: {
        pinHash,
        updateTokenHash,
        publicURL: 'https://relay.example.com',
        autoUpdate: false,
        updateScript: '',
        githubRepo: 'ShirazuNagisa/DSH-Mizar-Relay',
        dataDir: '/tmp/dsh-mizar-relay-selfhost-tests',
      },
    }),
    () => undefined,
    { fetchImpl: githubFetch },
  )
  return relay
}

/** Attach a fake computer's tunnel and wait until the relay has it. */
async function attachComputer(
  computer: { name: string; platform: string; deviceId: string },
): Promise<{ room: string; socket: WebSocket }> {
  if (relay === undefined) throw new Error('no relay')
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    'x-mizar-client-id': computer.deviceId,
    'x-mizar-device-name': encodeURIComponent(computer.name),
    'x-mizar-device-platform': computer.platform,
  }
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/tunnel`, { headers })
  sockets.push(socket)
  const room = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the tunnel did not open')), 2000)
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as { t?: string; room?: string }
      if (frame.t === 'welcome' && typeof frame.room === 'string') {
        clearTimeout(timer)
        resolve(frame.room)
      }
    })
    socket.on('error', reject)
  })
  return { room, socket }
}

/** Fetch a base URL under the relay. */
function url(path: string): string {
  if (relay === undefined) throw new Error('no relay')
  return `http://127.0.0.1:${relay.port}${path}`
}

describe('the self-hosted health answer', () => {
  it('names the product, the build and the PIN requirement', async () => {
    await start({ pin: PIN })
    const body = (await (await fetch(url('/healthz'))).json()) as Record<string, unknown>
    expect(body['product']).toBe('dsh-mizar-relay')
    expect(typeof body['relayVersion']).toBe('string')
    expect(body['selfHost']).toBe(true)
    expect(body['pinRequired']).toBe(true)
    expect(body['setupPage']).toBe(true)
    expect(body['updateEnabled']).toBe(false)
    expect(body['version']).toBe(1)
  })

  it('serves the setup page at the root and says which version it is', async () => {
    await start({ pin: PIN })
    const response = await fetch(url('/'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('DSH-Mizar')
    expect(html).toContain('relay.example.com')
  })
})

describe('the computer directory', () => {
  it('lists a connected computer, with the name it sent, after the PIN', async () => {
    await start({ pin: PIN })
    const { room } = await attachComputer({
      name: '办公室的 Mac',
      platform: 'macos',
      deviceId: 'dev-1',
    })
    const refused = await fetch(url('/selfhost/v1/desktops'))
    expect(refused.status).toBe(401)

    const wrong = await fetch(url('/selfhost/v1/desktops'), {
      headers: { 'x-mizar-server-pin': 'WRONG123' },
    })
    expect(wrong.status).toBe(403)

    const answer = await fetch(url('/selfhost/v1/desktops'), {
      headers: { 'x-mizar-server-pin': PIN },
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as {
      relay: { version: string; publicURL: string }
      desktops: Array<{ room: string; name: string; platform: string; deviceId: string }>
    }
    expect(body.relay.publicURL).toBe('https://relay.example.com')
    expect(body.desktops).toHaveLength(1)
    expect(body.desktops[0]).toMatchObject({
      room,
      name: '办公室的 Mac',
      platform: 'macos',
      deviceId: 'dev-1',
    })
  })

  it('lists nothing for a relay that never had a computer', async () => {
    await start({ pin: PIN })
    const answer = await fetch(url('/selfhost/v1/desktops'), {
      headers: { 'x-mizar-server-pin': PIN },
    })
    const body = (await answer.json()) as { desktops: unknown[] }
    expect(body.desktops).toEqual([])
  })

  it('leaves the list open when no PIN is configured', async () => {
    await start({})
    const answer = await fetch(url('/selfhost/v1/desktops'))
    expect(answer.status).toBe(200)
  })
})

describe('the update endpoint', () => {
  it('requires the update token before it will even check', async () => {
    await start({ updateToken: 'update-token-value' })
    const refused = await fetch(url('/selfhost/v1/update'))
    expect(refused.status).toBe(401)
    const wrong = await fetch(url('/selfhost/v1/update'), {
      headers: { 'x-mizar-update-token': 'nope' },
    })
    expect(wrong.status).toBe(403)
  })

  it('reports the installed and latest versions', async () => {
    await start({ updateToken: 'update-token-value' })
    const answer = await fetch(url('/selfhost/v1/update'), {
      headers: { 'x-mizar-update-token': 'update-token-value' },
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as Record<string, unknown>
    expect(body['latest']).toBe('9.9.9')
    expect(body['updateAvailable']).toBe(true)
    expect(typeof body['current']).toBe('string')
  })

  it('refuses to start an update when the deployment has no updater script', async () => {
    await start({ updateToken: 'update-token-value' })
    const answer = await fetch(url('/selfhost/v1/update'), {
      method: 'POST',
      headers: { 'x-mizar-update-token': 'update-token-value' },
    })
    expect(answer.status).toBe(409)
    const body = (await answer.json()) as Record<string, unknown>
    expect(body['started']).toBe(false)
  })

  it('is a 404 when the deployment has no update token at all', async () => {
    await start({})
    const answer = await fetch(url('/selfhost/v1/update'))
    expect(answer.status).toBe(404)
  })
})

describe('an official deployment', () => {
  it('answers 404 for the self-hosted paths and keeps the health answer unchanged', async () => {
    relay = await startRelay(config(), () => undefined)
    expect((await fetch(url('/'))).status).toBe(404)
    expect((await fetch(url('/selfhost/v1/desktops'))).status).toBe(404)
    const body = (await (await fetch(url('/healthz'))).json()) as Record<string, unknown>
    expect(body['selfHost']).toBe(false)
    expect(body['pinRequired']).toBe(false)
  })
})

describe('readDeviceHeaders', () => {
  it('decodes a percent-encoded name and keeps known platforms', () => {
    const entry = readDeviceHeaders(
      {
        'x-mizar-client-id': 'dev-9',
        'x-mizar-device-name': encodeURIComponent('办公室的 Mac'),
        'x-mizar-device-platform': 'macos',
      },
      'ROOM12345678',
      1000,
    )
    expect(entry).toMatchObject({
      room: 'ROOM12345678',
      deviceId: 'dev-9',
      name: '办公室的 Mac',
      platform: 'macos',
      onlineSince: 1000,
    })
  })

  it('falls back to a name and an unknown platform', () => {
    const entry = readDeviceHeaders({}, 'ROOM12345678', 1)
    expect(entry.name).toBe('Computer')
    expect(entry.platform).toBe('unknown')
  })

  it('caps a name that is far too long', () => {
    const entry = readDeviceHeaders(
      { 'x-mizar-device-name': 'x'.repeat(500) },
      'ROOM12345678',
      1,
    )
    expect(entry.name.length).toBe(80)
  })
})

describe('DesktopDirectory', () => {
  it('does not let a displaced tunnel remove its successor', () => {
    const directory = new DesktopDirectory()
    const first = directory.register({
      room: 'R1',
      deviceId: 'd',
      name: 'Mac',
      platform: 'macos',
      onlineSince: 1,
    })
    directory.register({ room: 'R1', deviceId: 'd', name: 'Mac', platform: 'macos', onlineSince: 2 })
    directory.unregister('R1', first)
    expect(directory.size).toBe(1)
  })

  it('drops a row whose room is no longer live', () => {
    const directory = new DesktopDirectory()
    directory.register({ room: 'R1', deviceId: 'd', name: 'Mac', platform: 'macos', onlineSince: 1 })
    expect(directory.list(() => false)).toEqual([])
    expect(directory.size).toBe(0)
  })
})

describe('AttemptGuard', () => {
  it('blocks after the limit and forgets the failures once the window passes', () => {
    const guard = new AttemptGuard(2, 1000)
    guard.fail('a', 0)
    guard.fail('a', 1)
    expect(guard.blocked('a', 2)).toBe(true)
    expect(guard.blocked('a', 2000)).toBe(false)
    guard.clear('a')
    expect(guard.blocked('a', 3)).toBe(false)
  })
})

describe('UpdateMonitor', () => {
  it('turns a GitHub failure into data rather than an exception', async () => {
    const monitor = new UpdateMonitor({
      dataDir: '/tmp/dsh-mizar-relay-selfhost-tests',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    })
    const check = await monitor.check(true)
    expect(check.latest).toBeNull()
    expect(check.error).toContain('500')
  })

  it('ignores a tag that is not a version', async () => {
    const monitor = new UpdateMonitor({
      dataDir: '/tmp/dsh-mizar-relay-selfhost-tests',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ tag_name: 'nightly' }), { status: 200 })) as typeof fetch,
    })
    const check = await monitor.check(true)
    expect(check.latest).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('0.5.10', '0.5.9')).toBeGreaterThan(0)
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0)
    expect(compareVersions('0.4.9', '0.5.0')).toBeLessThan(0)
    expect(compareVersions('1.0', '0.9.9')).toBeGreaterThan(0)
  })
})
