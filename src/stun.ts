import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { UdpGuard, type UdpGuardLimits } from './udp-guard.js'

/**
 * STUN, as much of RFC 5389 as a peer needs to learn its own address.
 *
 * The relay has always had a UDP responder that tells a caller where it appears
 * from — it answers with JSON, which was right while the only consumer was this
 * project's own diagnostic script. The direct path changed the consumer: the
 * iOS kernel and the desktop engine both speak RFC 5389, because that is what
 * STUN clients are, and a private JSON dialect would mean teaching two
 * implementations a protocol nobody else speaks.
 *
 * So this is the same idea in the standard's clothes. A Binding Request in, a
 * Binding Success Response out, one attribute: XOR-MAPPED-ADDRESS. Nothing else
 * is implemented, on purpose:
 *
 * - no authentication, because the question "what is my address" has no secret
 *   in it and an unauthenticated answer is the whole point of STUN;
 * - no TURN, because the fallback for this project is the WebSocket relay on
 *   443, which works from networks that block UDP entirely;
 * - no IPv6, because both ends of the direct path are IPv4 today and a second
 *   family would be a second socket and a second set of firewall rules to keep
 *   honest.
 *
 * The XOR is not obfuscation. It exists so that a middlebox which rewrites
 * addresses in transit cannot silently corrupt the answer: the client XORs with
 * the same constant and gets either the truth or a value that fails to make
 * sense, rather than a plausible wrong address that would send a punch into
 * someone else's NAT binding.
 */

/** The constant every STUN message carries after its length, and the XOR key. */
export const STUN_MAGIC_COOKIE = 0x2112a442

/** Binding Request: class `request`, method `binding`. */
export const STUN_BINDING_REQUEST = 0x0001

/** Binding Success Response: class `success response`, method `binding`. */
export const STUN_BINDING_SUCCESS = 0x0101

/** XOR-MAPPED-ADDRESS. */
export const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020

/** Type, length, cookie, transaction id. */
export const STUN_HEADER_BYTES = 20

/** One IPv4 address attribute: four bytes of header, eight of value. */
const XOR_MAPPED_ADDRESS_BYTES = 12

/**
 * Whether a datagram is a well-formed Binding Request.
 *
 * Strict on purpose, and strictness here is a security property rather than
 * tidiness: an unthrottled answer to anything that merely resembles a request
 * is what a reflector is made of, so a malformed message has to be rejected
 * before it earns a reply.
 *
 * @param data - the datagram.
 * @returns whether it may be answered.
 */
export function isBindingRequest(data: Buffer): boolean {
  if (data.length < STUN_HEADER_BYTES) return false
  if (data.readUInt16BE(0) !== STUN_BINDING_REQUEST) return false
  if (data.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return false
  const length = data.readUInt16BE(2)
  // RFC 5389 §6: the length counts everything after the header, and attributes
  // are four-byte aligned, so a length that is not a multiple of four cannot
  // describe a real message.
  if (length % 4 !== 0) return false
  // Trailing bytes the header does not account for mean the datagram is not one
  // message. Concatenated or padded requests are not something a client sends.
  return data.length === STUN_HEADER_BYTES + length
}

/**
 * Build the answer: what this source looks like from here.
 *
 * @param request - a datagram that passed {@link isBindingRequest}.
 * @param source - the address the datagram arrived from, and the port to report.
 * @returns the response, or `null` when the source address is not IPv4.
 */
export function encodeBindingSuccess(
  request: Buffer,
  source: { readonly address: string; readonly port: number },
): Buffer | null {
  const addressBytes = parseDottedQuad(source.address)
  if (addressBytes === null) return null

  const response = Buffer.alloc(STUN_HEADER_BYTES + XOR_MAPPED_ADDRESS_BYTES)
  response.writeUInt16BE(STUN_BINDING_SUCCESS, 0)
  response.writeUInt16BE(XOR_MAPPED_ADDRESS_BYTES, 2)
  response.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  // The transaction id comes back untouched: it is how the client knows this
  // answer belongs to its question, and echoing it is the entire correlation
  // mechanism — there is no session and no state.
  request.copy(response, 8, 8, STUN_HEADER_BYTES)

  const attribute = STUN_HEADER_BYTES
  response.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, attribute)
  response.writeUInt16BE(8, attribute + 2)
  response[attribute + 4] = 0x00 // reserved, must be zero
  response[attribute + 5] = 0x01 // family: IPv4
  response.writeUInt16BE(source.port ^ (STUN_MAGIC_COOKIE >>> 16), attribute + 6)
  for (let index = 0; index < 4; index += 1) {
    const cookieByte = (STUN_MAGIC_COOKIE >>> (24 - index * 8)) & 0xff
    response[attribute + 8 + index] = addressBytes[index]! ^ cookieByte
  }
  return response
}

/**
 * Start the STUN responder.
 *
 * One socket, bound for the life of the relay: STUN is stateless, so there is
 * nothing to expire and nothing to shard — every datagram is answered from the
 * message itself.
 *
 * @param options - where to bind, the reply limits, and where to log.
 * @returns the socket, or `null` when the port is disabled.
 */
export function startStunServer(options: {
  readonly port: number
  readonly limits: UdpGuardLimits
  readonly log: (message: string) => void
}): UdpSocket | null {
  if (options.port <= 0) return null
  const socket = createSocket('udp4')
  const guard = new UdpGuard(options.limits)

  socket.on('message', (data: Buffer, from) => {
    if (!isBindingRequest(data)) return
    const reply = encodeBindingSuccess(data, from)
    if (reply === null) return
    // Charged after the message proved answerable and before anything is sent,
    // so a forged flood costs the guard one comparison rather than a reply.
    if (!guard.allow(from.address)) return
    socket.send(reply, from.port, from.address)
  })
  socket.on('error', (error) => options.log(`relay: stun socket error: ${error.message}`))
  socket.bind(options.port, '0.0.0.0', () => options.log(`relay: stun on udp/${options.port}`))
  return socket
}

/**
 * `a.b.c.d` as four bytes.
 * @param address - the text form.
 * @returns the bytes, or `null` when it is not a plain IPv4 address.
 */
function parseDottedQuad(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    // `Number('')` is 0 and `Number(' 1')` is 1, neither of which should pass.
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}
