import { createSocket } from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { createBindingRequest, freePort, waitForReply } from './fixtures/udp.js'
import {
  encodeBindingSuccess,
  isBindingRequest,
  startStunServer,
  STUN_ATTR_XOR_MAPPED_ADDRESS,
  STUN_BINDING_SUCCESS,
  STUN_HEADER_BYTES,
  STUN_MAGIC_COOKIE,
} from '../src/stun.js'
import { UdpGuard } from '../src/udp-guard.js'

/**
 * Read XOR-MAPPED-ADDRESS back the way a client does.
 * @param response - a Binding Success Response.
 * @returns the address and port, or `null` when the attribute is absent.
 */
function decodeXorMappedAddress(response: Buffer): { address: string; port: number } | null {
  let offset = STUN_HEADER_BYTES
  const end = response.length
  while (offset + 4 <= end) {
    const type = response.readUInt16BE(offset)
    const length = response.readUInt16BE(offset + 2)
    const value = offset + 4
    if (type === STUN_ATTR_XOR_MAPPED_ADDRESS && length === 8) {
      const port = response.readUInt16BE(value + 2) ^ (STUN_MAGIC_COOKIE >>> 16)
      const bytes = [0, 1, 2, 3].map(
        (index) =>
          response[value + 4 + index]! ^ ((STUN_MAGIC_COOKIE >>> (24 - index * 8)) & 0xff),
      )
      return { address: bytes.join('.'), port }
    }
    // Attributes are four-byte aligned.
    offset = value + Math.ceil(length / 4) * 4
  }
  return null
}

const servers: { close: () => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('stun framing', () => {
  it('accepts a well-formed binding request', () => {
    expect(isBindingRequest(createBindingRequest())).toBe(true)
  })

  it('refuses anything that is not one', () => {
    const valid = createBindingRequest()
    // Shorter than a header.
    expect(isBindingRequest(valid.subarray(0, 12))).toBe(false)

    const wrongType = Buffer.from(valid)
    wrongType.writeUInt16BE(0x0101, 0)
    expect(isBindingRequest(wrongType)).toBe(false)

    const wrongCookie = Buffer.from(valid)
    wrongCookie.writeUInt32BE(0xdeadbeef, 4)
    expect(isBindingRequest(wrongCookie)).toBe(false)

    // A length that does not describe the datagram: the classic way a malformed
    // message would otherwise earn a reply.
    const wrongLength = Buffer.from(valid)
    wrongLength.writeUInt16BE(8, 2)
    expect(isBindingRequest(wrongLength)).toBe(false)

    // Attributes are four-byte aligned, so a length of 5 cannot be real.
    const misaligned = Buffer.concat([valid, Buffer.alloc(4)])
    misaligned.writeUInt16BE(5, 2)
    expect(isBindingRequest(misaligned)).toBe(false)
  })
})

describe('binding success response', () => {
  it('echoes the transaction id and reports the source back', () => {
    const request = createBindingRequest()
    const response = encodeBindingSuccess(request, { address: '203.0.113.7', port: 51820 })

    expect(response).not.toBeNull()
    expect(response!.readUInt16BE(0)).toBe(STUN_BINDING_SUCCESS)
    expect(response!.readUInt16BE(2)).toBe(12)
    expect(response!.readUInt32BE(4)).toBe(STUN_MAGIC_COOKIE)
    // Bytes 8..19 are the transaction id, and they must come back untouched:
    // that echo is the only correlation a stateless server has.
    expect(response!.subarray(8, 20).equals(request.subarray(8, 20))).toBe(true)

    expect(decodeXorMappedAddress(response!)).toEqual({ address: '203.0.113.7', port: 51820 })
  })

  it('does not put the address on the wire in the clear', () => {
    const response = encodeBindingSuccess(createBindingRequest(), {
      address: '203.0.113.7',
      port: 51820,
    })!
    expect(response.includes(Buffer.from([203, 0, 113, 7]))).toBe(false)
  })

  it('refuses a source that is not a plain IPv4 address', () => {
    expect(encodeBindingSuccess(createBindingRequest(), { address: '::1', port: 1 })).toBeNull()
    expect(encodeBindingSuccess(createBindingRequest(), { address: '1.2.3', port: 1 })).toBeNull()
    expect(encodeBindingSuccess(createBindingRequest(), { address: '1.2.3.999', port: 1 })).toBeNull()
  })
})

describe('stun server', () => {
  it('answers a real datagram with the sender address', async () => {
    const port = await freePort()
    const server = startStunServer({ port, limits: { repliesPerSecond: 50, repliesPerSecondPerSource: 50 }, log: () => undefined })
    expect(server).not.toBeNull()
    servers.push(server!)

    const client = createSocket('udp4')
    await new Promise<void>((resolve) => client.bind(0, resolve))
    servers.push({ close: () => client.close() })
    const clientPort = client.address().port

    const request = createBindingRequest()
    const reply = await waitForReply(client, request, '127.0.0.1', port)

    expect(reply).not.toBeNull()
    expect(isBindingRequest(reply!)).toBe(false) // it is a response, not a request
    expect(reply!.readUInt16BE(0)).toBe(STUN_BINDING_SUCCESS)
    // Whatever port STUN reports is the port the client is actually bound to —
    // that is the whole service, and on loopback it is checkable.
    expect(decodeXorMappedAddress(reply!)?.port).toBe(clientPort)
  })

  it('stays silent for a datagram that is not a binding request', async () => {
    const port = await freePort()
    const server = startStunServer({ port, limits: { repliesPerSecond: 50, repliesPerSecondPerSource: 50 }, log: () => undefined })
    servers.push(server!)

    const client = createSocket('udp4')
    await new Promise<void>((resolve) => client.bind(0, resolve))
    servers.push({ close: () => client.close() })

    // Silence is the property that keeps this from being a reflector, so it is
    // asserted rather than assumed.
    const reply = await waitForReply(client, Buffer.from('hello there'), '127.0.0.1', port, 400)
    expect(reply).toBeNull()
  })

  it('is disabled by a zero port', () => {
    expect(startStunServer({ port: 0, limits: { repliesPerSecond: 1, repliesPerSecondPerSource: 1 }, log: () => undefined })).toBeNull()
  })
})

describe('udp guard', () => {
  it('caps one source without touching another', () => {
    let now = 0
    const guard = new UdpGuard({ repliesPerSecond: 100, repliesPerSecondPerSource: 2 }, () => now)
    expect(guard.allow('198.51.100.1')).toBe(true)
    expect(guard.allow('198.51.100.1')).toBe(true)
    expect(guard.allow('198.51.100.1')).toBe(false)
    // A different source has its own allowance: one noisy peer must not spend
    // anybody else's.
    expect(guard.allow('198.51.100.2')).toBe(true)
  })

  it('refills by wall clock', () => {
    let now = 0
    const guard = new UdpGuard({ repliesPerSecond: 100, repliesPerSecondPerSource: 1 }, () => now)
    expect(guard.allow('198.51.100.1')).toBe(true)
    expect(guard.allow('198.51.100.1')).toBe(false)
    now = 1000
    expect(guard.allow('198.51.100.1')).toBe(true)
  })

  it('sheds a flood at the global cap however it is spread', () => {
    const guard = new UdpGuard({ repliesPerSecond: 3, repliesPerSecondPerSource: 10 }, () => 0)
    expect(guard.allow('198.51.100.1')).toBe(true)
    expect(guard.allow('198.51.100.2')).toBe(true)
    expect(guard.allow('198.51.100.3')).toBe(true)
    // Every source is still under its own cap; the socket-wide budget is what
    // stops a distributed spoof.
    expect(guard.allow('198.51.100.4')).toBe(false)
  })
})
