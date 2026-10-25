import { createSocket, type Socket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { STUN_BINDING_REQUEST, STUN_HEADER_BYTES, STUN_MAGIC_COOKIE } from '../../src/stun.js'

/**
 * A Binding Request, the way a client puts one on the wire.
 *
 * Hand-built rather than produced by the server's own encoder: a test that
 * builds its request with the code under test can agree with itself and still
 * be wrong about the protocol.
 *
 * @returns a 20-byte request with a fresh transaction id.
 */
export function createBindingRequest(): Buffer {
  const request = Buffer.alloc(STUN_HEADER_BYTES)
  request.writeUInt16BE(STUN_BINDING_REQUEST, 0)
  request.writeUInt16BE(0, 2) // no attributes
  request.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  randomBytes(12).copy(request, 8)
  return request
}

/**
 * A UDP port that is free right now.
 *
 * Bind-and-release: there is a window between the release and the caller's
 * bind, which on a loopback test with an ephemeral range is small enough to
 * live with — and the alternative (a fixed port) collides with whatever else
 * the machine is running.
 *
 * @returns the port number.
 */
export async function freePort(): Promise<number> {
  const socket = createSocket('udp4')
  await new Promise<void>((resolve) => socket.bind(0, resolve))
  const port = socket.address().port
  await new Promise<void>((resolve) => socket.close(resolve))
  return port
}

/**
 * Send one datagram and wait for one back.
 *
 * @param socket - a bound client socket.
 * @param payload - what to send.
 * @param host - where to send it.
 * @param port - the port to send it to.
 * @param timeoutMs - how long to wait; the timeout is the assertion in the
 *   "stays silent" test, so it is short enough to keep the suite quick.
 * @returns the reply, or `null` when nothing arrived.
 */
export function waitForReply(
  socket: Socket,
  payload: Buffer,
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(value)
    }
    const onMessage = (data: Buffer): void => finish(data)
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    socket.on('message', onMessage)
    socket.send(payload, port, host)
  })
}
