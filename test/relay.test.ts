import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startRelay, type Relay } from '../src/index.js'
import { DEFAULT_ABUSE, type RelayConfig } from '../src/config.js'
import { deriveRoom } from '../src/room.js'

const TOKEN = 'test-tunnel-token'
const ROOM = deriveRoom(TOKEN)

/** The relay under test, torn down after each case. */
let relay: Relay | undefined

afterEach(async () => {
  await relay?.close()
  relay = undefined
})

const config = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
  port: 0,
  host: '127.0.0.1',
  tokens: [TOKEN],
  trustProxy: true,
  maxBodyBytes: 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxClientsPerRoom: 8,
  requestTimeoutMs: 2000,
  tunnelIdleMs: 60_000,
  probePort: 0, // disabled: binding a UDP port per test is noise
  apns: null, // notifications are off unless a case turns them on
  fcm: null, // and so is the Android half
  role: 0,
  accounts: null,
  ...overrides,
})

/**
 * A stand-in for the computer: connects its tunnel and answers whatever it is asked
 * with a fixed reply, so the test is about the relay and not about the plugin.
 */
class FakeMac {
  readonly #socket: WebSocket
  readonly room: string
  readonly requests: Array<Record<string, unknown>> = []
  #handler: (frame: Record<string, unknown>) => void = () => undefined

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
      this.#handler(frame)
    })
  }

  static async connect(
    url: string,
    token: string = TOKEN,
    headers: Record<string, string> = {},
  ): Promise<FakeMac> {
    const socket = new WebSocket(`${url}/tunnel`, {
      headers: { authorization: `Bearer ${token}`, ...headers },
    })
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))))
      socket.once('error', reject)
      socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`upgrade refused with ${response.statusCode}`)),
      )
    })
    return new FakeMac(socket, String(welcome['room']))
  }

  /** Answer every request with a fixed status and body. */
  respondWith(status: number, body: string, headers: Record<string, string> = {}): void {
    this.#handler = (frame) => {
      this.#socket.send(
        JSON.stringify({
          t: 'res',
          id: frame['id'],
          status,
          headers: { 'content-type': 'application/json', ...headers },
          body: Buffer.from(body).toString('base64'),
        }),
      )
    }
  }

  /** Accept every stream and echo whatever arrives on it. */
  echoStreams(): void {
    this.#handler = (frame) => {
      if (frame['t'] === 'ws-open') {
        this.#socket.send(JSON.stringify({ t: 'ws-open-ok', id: frame['id'] }))
        return
      }
      if (frame['t'] === 'ws-msg') {
        const text = Buffer.from(String(frame['data']), 'base64').toString('utf8')
        this.#socket.send(
          JSON.stringify({
            t: 'ws-msg',
            id: frame['id'],
            data: Buffer.from(`echo:${text}`).toString('base64'),
            binary: false,
          }),
        )
      }
    }
  }

  /** Refuse every stream. */
  refuseStreams(): void {
    this.#handler = (frame) => {
      if (frame['t'] === 'ws-open') {
        this.#socket.send(JSON.stringify({ t: 'error', id: frame['id'], message: 'no path' }))
      }
    }
  }

  /** Answer nothing at all. */
  goSilent(): void {
    this.#handler = () => undefined
  }

  /** Send a stream message of the given size, as the computer would. */
  sendStreamMessage(payload: string): void {
    this.#socket.send(
      JSON.stringify({
        t: 'ws-msg',
        id: 'r1',
        data: Buffer.from(payload).toString('base64'),
        binary: false,
      }),
    )
  }

  close(): void {
    this.#socket.close()
  }

  /** Drop the socket without a close handshake, as a dead computer would. */
  kill(): void {
    this.#socket.terminate()
  }
}

describe('relay HTTP replay', () => {
  it('carries a request to the computer and its answer back', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, '{"hostId":"abc"}')

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"hostId":"abc"}')
    expect(mac.requests[0]).toMatchObject({
      t: 'req',
      method: 'GET',
      path: '/mizar/v1/hello',
    })
  })

  it('carries a request body through unchanged', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, '{}')

    await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/pair`, {
      method: 'POST',
      body: '{"code":"ABCD-EFGH"}',
      headers: { 'content-type': 'application/json' },
    })

    const sent = mac.requests[0]
    expect(Buffer.from(String(sent?.['body']), 'base64').toString('utf8')).toBe('{"code":"ABCD-EFGH"}')
  })

  it('strips the relay-private identity headers before the computer sees them', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, '{}')
    await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`, {
      headers: {
        'x-mizar-account': 'a'.repeat(64),
        'x-mizar-client-id': 'device-0001',
        'x-visible': 'yes',
      },
    })
    const headers = (mac.requests[0] as { headers: Record<string, string> }).headers
    expect(headers['x-mizar-account']).toBeUndefined()
    expect(headers['x-mizar-client-id']).toBeUndefined()
    expect(headers['x-visible']).toBe('yes')
  })

  it('does not forward hop-by-hop headers', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, '{}')

    await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`, {
      headers: { 'x-mizar-probe': 'kept' },
    })

    const headers = mac.requests[0]?.['headers'] as Record<string, string>
    expect(headers['x-mizar-probe']).toBe('kept')
    // `connection` and `transfer-encoding` describe this hop and would be wrong
    // to replay onto the plugin's listener.
    expect(headers['connection']).toBeUndefined()
    expect(headers['transfer-encoding']).toBeUndefined()
  })

  it('propagates the computer response status, not a relay one', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(429, '{"error":"slow down"}')

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/pair`)
    expect(response.status).toBe(429)
  })

  it('answers 404 for a room that does not exist', async () => {
    relay = await startRelay(config(), () => undefined)
    const response = await fetch(`http://127.0.0.1:${relay.port}/r/NOSUCHROOM/mizar/v1/hello`)
    expect(response.status).toBe(404)
  })

  it('answers the same 404 whether the room is unknown or merely offline', async () => {
    // Distinguishing them would let anyone enumerate which computers are online.
    relay = await startRelay(config(), () => undefined)
    const offline = await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}/mizar/v1/hello`)
    const unknown = await fetch(`http://127.0.0.1:${relay.port}/r/AAAAAAAAAAAA/mizar/v1/hello`)
    expect(offline.status).toBe(unknown.status)
    expect(await offline.text()).toBe(await unknown.text())
  })

  it('reports 502 when the computer goes silent past the timeout', async () => {
    relay = await startRelay(config({ requestTimeoutMs: 100 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.goSilent()

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    expect(response.status).toBe(502)
  })

  it('fails an in-flight request the moment the computer drops', async () => {
    relay = await startRelay(config({ requestTimeoutMs: 30_000 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.goSilent()

    const pending = fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    mac.kill()

    // Must not wait out the 30s timeout: the answer is already known.
    const response = await pending
    expect(response.status).toBe(502)
  })

  it('serves health', async () => {
    relay = await startRelay(config(), () => undefined)
    await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    const body = (await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json()) as {
      ok: boolean
      rooms: number
    }
    expect(body.ok).toBe(true)
    expect(body.rooms).toBe(1)
  })
})

describe('relay tunnel admission', () => {
  it('refuses a tunnel with a bad token', async () => {
    relay = await startRelay(config(), () => undefined)
    await expect(
      FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'wrong-token'),
    ).rejects.toThrow(/401/)
  })

  it('refuses a tunnel with no token at all', async () => {
    relay = await startRelay(config(), () => undefined)
    await expect(FakeMac.connect(`ws://127.0.0.1:${relay.port}`, '')).rejects.toThrow(/401/)
  })

  it('tells the computer which room it serves', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    expect(mac.room).toBe(ROOM)
  })

  it('lets a reconnecting computer take over its own room', async () => {
    relay = await startRelay(config(), () => undefined)
    const first = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    const second = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    second.respondWith(200, '{"from":"second"}')
    first.respondWith(200, '{"from":"first"}')

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}/mizar/v1/hello`)
    expect(await response.text()).toBe('{"from":"second"}')

    // The displaced socket must not take the room down when it closes.
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const again = await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}/mizar/v1/hello`)
    expect(await again.text()).toBe('{"from":"second"}')
  })
})

describe('relay WebSocket bridging', () => {
  it('bridges a phone socket through to the computer', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.echoStreams()

    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/ws`)
    await new Promise<void>((resolve, reject) => {
      phone.once('open', () => resolve())
      phone.once('error', reject)
    })

    // The listener goes on before the send. Registering it afterwards is a race
    // the loopback round trip wins, and the test hangs rather than failing.
    const reply = new Promise<string>((resolve) => {
      phone.once('message', (data: Buffer) => resolve(data.toString('utf8')))
    })
    phone.send('hello from the phone')
    expect(await reply).toBe('echo:hello from the phone')
    phone.close()
  })

  it('bridges the direct path\'s signalling channel on a path of its own', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.echoStreams()

    // The direct path negotiates its candidates over its own WebSocket, and it
    // needs no route of its own: the room bridge forwards whatever path the
    // phone asks for, so `/mizar-net/signal` reaches the host's endpoint the
    // same way `/mizar/v1/ws` does. This test exists to hold that property --
    // a future path allow-list would break the direct path silently.
    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar-net/signal`)
    await new Promise<void>((resolve, reject) => {
      phone.once('open', () => resolve())
      phone.once('error', reject)
    })

    const reply = new Promise<string>((resolve) => {
      phone.once('message', (data: Buffer) => resolve(data.toString('utf8')))
    })
    const signal = JSON.stringify({ t: 'hello', candidates: [{ kind: 'host', address: '10.0.0.2', port: 5000 }] })
    phone.send(signal)
    expect(await reply).toBe(`echo:${signal}`)

    // And the host was asked for that path, not for a rewritten one: the plugin
    // routes on it.
    expect(
      mac.requests.some((frame) => frame['t'] === 'ws-open' && frame['path'] === '/mizar-net/signal'),
    ).toBe(true)
    phone.close()
  })

  it('carries a 400 KiB attachment-sized frame in both directions', async () => {
    relay = await startRelay(config({ maxMessageBytes: 1024 * 1024 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.echoStreams()
    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/ws`)
    await new Promise<void>((resolve, reject) => {
      phone.once('open', () => resolve())
      phone.once('error', reject)
    })
    const payload = 'x'.repeat(400 * 1024)
    const reply = new Promise<string>((resolve) => {
      phone.once('message', (data: Buffer) => resolve(data.toString('utf8')))
    })
    phone.send(payload)
    const echoed = await reply
    expect(echoed.length).toBe(payload.length + 'echo:'.length)
    phone.close()
  })

  it('refuses the upgrade with 502 when the computer will not accept the stream', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.refuseStreams()

    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/ws`)
    const status = await new Promise<number>((resolve, reject) => {
      phone.once('open', () => reject(new Error('the upgrade should not have succeeded')))
      phone.once('unexpected-response', (_request, response) => resolve(response.statusCode))
      phone.once('error', () => undefined)
    })
    // The computer's refusal is visible as an HTTP status, not as a socket that opened
    // and immediately died -- the two are indistinguishable in a client's logs.
    expect(status).toBe(502)
  })

  it('refuses a phone socket for a room with no computer', async () => {
    relay = await startRelay(config(), () => undefined)
    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/NOSUCHROOM/mizar/v1/ws`)
    const status = await new Promise<number>((resolve, reject) => {
      phone.once('open', () => reject(new Error('the upgrade should not have succeeded')))
      phone.once('unexpected-response', (_request, response) => resolve(response.statusCode))
      phone.once('error', () => undefined)
    })
    expect(status).toBe(404)
  })

  it('holds a room to its concurrent phone limit, and frees the slot', async () => {
    // `maxClientsPerRoom` is a documented knob and the only bound on how many
    // sockets one room can hold; nothing else in the relay counts them.
    relay = await startRelay(config({ maxClientsPerRoom: 1 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.echoStreams()
    const url = `ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/ws`

    const first = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      first.once('open', () => resolve())
      first.once('error', reject)
    })

    const second = new WebSocket(url)
    const refused = await new Promise<number>((resolve, reject) => {
      second.once('open', () => reject(new Error('the second socket should not have been accepted')))
      second.once('unexpected-response', (_request, response) => resolve(response.statusCode))
      second.once('error', () => undefined)
    })
    expect(refused).toBe(429)

    // The slot is a resource, not a permanent ban: closing the first phone must
    // let the next one in, or a relay would slowly refuse everybody.
    await new Promise<void>((resolve) => {
      first.once('close', () => resolve())
      first.close()
    })
    const third = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      third.once('open', () => resolve())
      third.once('error', reject)
    })
    third.close()
  })
})

describe('relay limits on what comes back', () => {
  it('refuses to carry a response body past the body cap', async () => {
    // The cap used to apply to the phone's request only, so a computer -- and in open
    // registration anybody may be one -- could make the relay allocate and write
    // an answer of any size.
    relay = await startRelay(config({ maxBodyBytes: 1024 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, 'x'.repeat(4096))

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    expect(response.status).toBe(502)
    // Still serving: the cap refuses one answer, it does not unroute the room.
    mac.respondWith(200, '{"hostId":"abc"}')
    const after = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    expect(after.status).toBe(200)
  })

  it('shuts down even while a phone is waiting for the computer to answer', async () => {
    // A deferred upgrade leaves a raw socket parked with no answer. Draining
    // waits for it, so shutdown used to stall for the whole request timeout --
    // thirty seconds by default -- on every restart.
    const local = await startRelay(config({ requestTimeoutMs: 30_000 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${local.port}`)
    mac.goSilent()

    const phone = new WebSocket(`ws://127.0.0.1:${local.port}/r/${mac.room}/mizar/v1/ws`)
    phone.on('error', () => undefined)
    // Long enough for the upgrade to have reached the relay and been parked.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const outcome = await Promise.race([
      local.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 1000)),
    ])
    expect(outcome).toBe('closed')
    phone.terminate()
  })
})

describe('open registration', () => {
  const openConfig = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
    ...config(),
    tokens: [],
    ...overrides,
  })

  it('accepts a credential it has never seen and gives it a room', async () => {
    // The whole point: a relay issues no credentials, so a plugin that has never
    // spoken to it before can still register. Without this every user needs a
    // token an operator handed out, which is the configuration being removed.
    relay = await startRelay(openConfig(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'a'.repeat(43))
    expect(mac.room).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
  })

  it('gives different credentials different rooms', async () => {
    relay = await startRelay(openConfig(), () => undefined)
    const one = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'a'.repeat(43))
    const two = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'b'.repeat(43))
    expect(one.room).not.toBe(two.room)
  })

  it('derives the same room from the same credential, so a reconnect keeps it', async () => {
    relay = await startRelay(openConfig(), () => undefined)
    const first = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'c'.repeat(43))
    const second = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'c'.repeat(43))
    expect(second.room).toBe(first.room)
  })

  it('refuses a credential too short to be one', async () => {
    relay = await startRelay(openConfig(), () => undefined)
    await expect(FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'short')).rejects.toThrow(/401/)
  })

  it('still routes a phone request through a self-registered room', async () => {
    relay = await startRelay(openConfig(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'd'.repeat(43))
    mac.respondWith(200, '{"self":"registered"}')
    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    expect(await response.text()).toBe('{"self":"registered"}')
  })
})

describe('abuse limits', () => {
  it('refuses more tunnels from one address than allowed', async () => {
    // An open relay without this is a memory exhaustion primitive: a script
    // registers rooms until the process dies.
    relay = await startRelay(
      { ...config(), tokens: [], maxTunnelsPerIp: 2 },
      () => undefined,
    )
    await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'e'.repeat(43))
    await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'f'.repeat(43))
    await expect(
      FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'g'.repeat(43)),
    ).rejects.toThrow(/429/)
  })

  it('counts tunnels per real client address behind a local proxy', async () => {
    // nginx forwards the upgrade to loopback and always presents itself as
    // 127.0.0.1. The limit is a resource guard on the computer, so it has to
    // count the address the proxy vouches for -- otherwise four households fill
    // the relay and the fifth computer is refused with a 429 naming the proxy.
    relay = await startRelay(
      { ...config(), tokens: [], maxTunnelsPerIp: 1 },
      () => undefined,
    )
    const url = `ws://127.0.0.1:${relay.port}`
    await FakeMac.connect(url, 'a'.repeat(43), { 'x-real-ip': '203.0.113.7' })
    await expect(
      FakeMac.connect(url, 'b'.repeat(43), { 'x-real-ip': '203.0.113.7' }),
    ).rejects.toThrow(/429/)
    // A different computer behind the same proxy has its own allowance.
    const other = await FakeMac.connect(url, 'c'.repeat(43), { 'x-real-ip': '198.51.100.9' })
    expect(other.room).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
    // And the proxy's own loopback address is no longer a shared bucket.
    expect(other.room).toBe(deriveRoom('c'.repeat(43)))
  })

  it('frees the slot when a tunnel goes away', async () => {
    relay = await startRelay(
      { ...config(), tokens: [], maxTunnelsPerIp: 1 },
      () => undefined,
    )
    const first = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'h'.repeat(43))
    first.kill()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const second = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'i'.repeat(43))
    expect(second.room).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
  })

  it('counts an IPv6 computer by its /64, not by each privacy address', async () => {
    // A client is supposed to rotate through the addresses inside its own
    // delegation; counting each /128 turns a per-address limit into a per-
    // rotation one. The same /64 must share a bucket, and a neighbouring /64
    // must not.
    relay = await startRelay(
      { ...config(), tokens: [], maxTunnelsPerIp: 1 },
      () => undefined,
    )
    const url = `ws://127.0.0.1:${relay.port}`
    await FakeMac.connect(url, 'a'.repeat(43), { 'x-real-ip': '2001:db8:1:2::10' })
    await expect(
      FakeMac.connect(url, 'b'.repeat(43), { 'x-real-ip': '2001:db8:1:2:9abc:def0:1234:5678' }),
    ).rejects.toThrow(/429/)
    const other = await FakeMac.connect(url, 'c'.repeat(43), { 'x-real-ip': '2001:db8:1:3::10' })
    expect(other.room).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
  })

  it('bounds one address however often the phone rotates its claimed identity', async () => {
    // The abuse this exists for: on a free relay the identity is
    // `x-mizar-client-id`, a header the phone chooses. Minting a new one per
    // request used to mint a fresh allowance per request. The address budget
    // is keyed by the source address and cannot be rotated away -- while a
    // *different* address keeps its own allowance, and the per-identity meter
    // is out of the picture here (disabled) so this test cannot pass by it.
    relay = await startRelay(
      {
        ...config(),
        tokens: [],
        maxTunnelsPerIp: 8,
        abuse: {
          ...DEFAULT_ABUSE,
          requestsPerMinute: 0,
          bytesPerDay: 0,
          requestsPerMinutePerIp: 0,
          bytesPerDayPerIp: 1000,
          trafficAlertBytesPerDay: 0,
          trafficAlertGrowthFactor: 0,
        },
      },
      () => undefined,
    )
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'd'.repeat(43))
    // Each round trip carries a 600-byte answer: two fit in the 1000-byte
    // address budget, the third is over it.
    mac.respondWith(200, 'x'.repeat(600))
    const url = `http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`
    const from = (clientId: string, ip: string): Promise<Response> =>
      fetch(url, { headers: { 'x-mizar-client-id': clientId, 'x-real-ip': ip } })

    expect((await from('device-0001', '203.0.113.7')).status).toBe(200)
    expect((await from('device-0002', '203.0.113.7')).status).toBe(200)
    // The identity is now brand new; the address has spent its day.
    const refused = await from('device-0003', '203.0.113.7')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-mizar-quota')).toBe('budget')
    // And a different address is unaffected by its neighbour's spending.
    expect((await from('device-0004', '203.0.113.8')).status).toBe(200)

    // The meter is visible to a monitor without reading logs.
    const body = (await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json()) as {
      quota: { ip: { refusedBudget: number } }
    }
    expect(body.quota.ip.refusedBudget).toBeGreaterThan(0)
  })
})

describe('the frame size guard', () => {
  it('refuses to forward a frame the phone would reject', async () => {
    // The last hop before the phone, and the only place that knows the phone's
    // limit. iOS refuses anything over one mebibyte and closes the socket, so an
    // oversized frame does not deliver an answer -- it kills the connection.
    // `maxMessageBytes` is checked in the phone's direction here; the plugin
    // guards its own output too, but a plugin older than the relay is a normal
    // state during an upgrade.
    const lines: string[] = []
    relay = await startRelay(config({ maxMessageBytes: 64 }), (m) => lines.push(m))
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)

    mac.echoStreams()

    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/ws`)
    await new Promise<void>((resolve, reject) => {
      phone.once('open', () => resolve())
      phone.once('error', reject)
    })

    // The computer sends something far too big for the phone leg.
    mac.sendStreamMessage('x'.repeat(4096))
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(lines.some((line) => line.includes('refusing a'))).toBe(true)

    // And the phone is still connected, which is the point: refusing must cost
    // the message, not the socket.
    expect(phone.readyState).toBe(WebSocket.OPEN)
    phone.close()
  })
})
