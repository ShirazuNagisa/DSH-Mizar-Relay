import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { get as httpGet } from 'node:http'
import type { Socket } from 'node:net'
import WebSocket from 'ws'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import { deriveRoom } from '../src/room.js'

/**
 * Keepalive for bridged phone sockets.
 *
 * A phone that is only waiting for the computer's answer sends nothing, and a
 * proxy that closes idle connections kills the leg mid-request. These cases pin
 * the two halves of the fix: the ping that keeps an idle-hungry proxy fed, and
 * the drop that reclaims a socket only the relay still believes in.
 */

// Generated per run: the relay accepts any well-formed credential, so nothing
// here -- or in this file -- needs a literal.
const TOKEN = randomBytes(24).toString('hex')
const ROOM = deriveRoom(TOKEN)

let relay: Relay | undefined

beforeEach(() => {
  // The keepalive interval is read per startRelay from the environment, so a
  // test can shrink the round instead of waiting thirty real seconds for it.
  process.env['MIZAR_RELAY_PHONE_KEEPALIVE'] = '100'
})

afterEach(async () => {
  delete process.env['MIZAR_RELAY_PHONE_KEEPALIVE']
  await relay?.close()
  relay = undefined
})

const config = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
  port: 0,
  host: '127.0.0.1',
  tokens: [TOKEN],
  trustProxy: true,
  maxTunnelsPerIp: 4,
  maxRooms: 100,
  maxBodyBytes: 1024 * 1024,
  maxMessageBytes: 900 * 1024,
  maxClientsPerRoom: 8,
  requestTimeoutMs: 2_000,
  tunnelIdleMs: 60_000,
  probePort: 0,
  apns: null,
  fcm: null,
  role: 0,
  accounts: null,
  ...overrides,
})

/**
 * A stand-in for the computer: connects its tunnel and accepts every stream, so
 * the relay has a room to bridge a phone into.
 */
async function connectFakeMac(base: string): Promise<{ room: string; socket: WebSocket }> {
  const socket = new WebSocket(`${base}/tunnel`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const room = await new Promise<string>((resolve, reject) => {
    socket.once('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      if (frame['t'] === 'welcome') resolve(String(frame['room']))
      else reject(new Error(`the first frame was ${String(frame['t'])}`))
    })
    socket.once('error', reject)
  })
  socket.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
    if (frame['t'] === 'ws-open') {
      socket.send(JSON.stringify({ t: 'ws-open-ok', id: frame['id'] }))
    }
  })
  return { room, socket }
}

/** Open a phone socket and wait for the bridge to be up. */
async function connectPhone(base: string, room: string): Promise<WebSocket> {
  const phone = new WebSocket(`${base}/r/${room}/mizar/v1/ws`)
  await new Promise<void>((resolve, reject) => {
    phone.once('open', () => resolve())
    phone.once('error', reject)
  })
  return phone
}

describe('phone keepalive', () => {
  it('pings bridged phones, so a proxy that closes idle sockets does not', async () => {
    relay = await startRelay(config({ tunnelIdleMs: 60_000 }), () => undefined)
    const base = `ws://127.0.0.1:${relay.port}`
    const { room } = await connectFakeMac(base)

    const phone = await connectPhone(base, room)
    // The phone never says a word after the upgrade: whatever arrives must come
    // from the relay's own round.
    const pinged = new Promise<void>((resolve, reject) => {
      phone.once('ping', () => resolve())
      setTimeout(() => reject(new Error('the relay never pinged the phone')), 5_000)
    })
    await pinged
    phone.close()
  })

  it('drops a phone that stops answering its keepalive', async () => {
    relay = await startRelay(config({ tunnelIdleMs: 60_000 }), () => undefined)
    const base = `ws://127.0.0.1:${relay.port}`
    const { room } = await connectFakeMac(base)

    // A raw upgrade rather than the ws client: the client answers protocol
    // pings on its own, and a phone that does that is exactly what this case is
    // not about. This one goes silent and never pongs.
    const socket = await new Promise<Socket>((resolve, reject) => {
      const request = httpGet(
        `http://127.0.0.1:${relay.port}/r/${room}/mizar/v1/ws`,
        {
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'sec-websocket-version': '13',
          },
        },
      )
      request.once('upgrade', (_response, raw) => {
        // A paused upgraded socket never dispatches 'close'; the test must
        // read to observe the relay's drop.
        raw.resume()
        resolve(raw)
      })
      request.once('response', (response) =>
        reject(new Error(`upgrade refused with ${response.statusCode}`)),
      )
      request.once('error', reject)
    })

    // Two intervals is the leash and the round is the granularity, so the drop
    // lands inside three. The relay ending the socket -- not this test -- is
    // the point.
    await new Promise<void>((resolve, reject) => {
      socket.once('close', () => resolve())
      setTimeout(() => reject(new Error('the silent phone was never dropped')), 5_000)
    })
  })
})
