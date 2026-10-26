/**
 * Which address a tunnel belongs to.
 *
 * The per-address tunnel limit exists to bound resources, and it used to read
 * `request.socket.remoteAddress` directly. That is right when computers dial the
 * relay themselves and wrong in the deployment this project documents: nginx
 * terminates TLS and forwards to `127.0.0.1:8787`, so every computer arrived as
 * the proxy and the "per address" limit silently became a global one. Four
 * tunnels from four households, and the fifth computer was refused with a 429
 * that named `127.0.0.1` rather than itself.
 *
 * The fix is the one a reverse-proxied service needs: when -- and only when --
 * the TCP peer is a loopback address, attribute the connection to the address
 * the proxy says it saw. A direct connection from a real address is never
 * attributed to a header, so exposing the relay without a proxy cannot be used
 * to forge a fresh bucket per request.
 *
 * @module dsh-mizar-relay/client-address
 */
import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'

/**
 * Resolve the address a tunnel is counted against.
 *
 * @param directAddress - the TCP peer's address, as the socket reports it.
 * @param headers - the upgrade request's headers.
 * @param trustProxy - whether a loopback reverse proxy's headers may name the
 *   client. False reproduces the old, proxy-counting behaviour.
 * @returns the address, or `'unknown'` when the socket has none.
 */
export function clientAddress(
  directAddress: string | undefined,
  headers: IncomingHttpHeaders,
  trustProxy: boolean,
): string {
  const direct = normalize(directAddress ?? 'unknown')
  if (!trustProxy || !isLoopback(direct)) return direct
  return (
    firstAddress(headerValue(headers['x-real-ip'])) ??
    lastAddress(headerValue(headers['x-forwarded-for'])) ??
    direct
  )
}

/** One header as a single string, or `undefined` when it is absent or empty. */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (Array.isArray(value) && value.length > 0) return value.join(',')
  return undefined
}

/**
 * The first valid address in a header.
 *
 * `X-Real-IP` is written by the proxy as a single value, so the first entry is
 * the one that matters; the loop just tolerates a malformed list.
 */
function firstAddress(value: string | undefined): string | null {
  if (value === undefined) return null
  for (const part of value.split(',')) {
    const address = validAddress(part)
    if (address !== null) return address
  }
  return null
}

/**
 * The last valid address in a header.
 *
 * `$proxy_add_x_forwarded_for` appends the address the proxy saw to whatever the
 * client sent, so the rightmost entry is the one the trusted hop vouches for.
 * Reading from the right and skipping invalid entries means a client-supplied
 * prefix cannot choose its bucket.
 */
function lastAddress(value: string | undefined): string | null {
  if (value === undefined) return null
  const parts = value.split(',')
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const address = validAddress(parts[index] ?? '')
    if (address !== null) return address
  }
  return null
}

/** Parse one header entry, or `null` when it is not an IP address. */
function validAddress(value: string): string | null {
  let text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim()
  }
  // `[2001:db8::1]` or `[2001:db8::1]:443`: how some proxies spell an endpoint.
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close === -1) return null
    text = text.slice(1, close)
  }
  const address = normalize(text)
  return isIP(address) === 0 ? null : address
}

/**
 * Put an address in the shape the limit's map should be keyed by.
 *
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:a.b.c.d`, and the
 * same computer must not appear as two addresses depending on which listener it
 * reached.
 */
function normalize(address: string): string {
  const text = address.trim()
  if (text.toLowerCase().startsWith('::ffff:')) {
    const mapped = text.slice(7)
    if (isIP(mapped) === 4) return mapped
  }
  return text
}

/** Whether an address is the loopback a local reverse proxy connects from. */
function isLoopback(address: string): boolean {
  if (address === '::1') return true
  const parts = address.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part))
}

/**
 * The key per-address limits count against: an IPv6 peer is grouped to its /64.
 *
 * A per-address limit is only as good as the identity of "one address". For
 * IPv4 that is the address itself; for IPv6 it is not. A client is *supposed*
 * to rotate through the privacy addresses inside its own /64 (SLAAC does it on
 * schedule), so counting each /128 separately turns "four tunnels per address"
 * into four per rotation, and an address budget into no budget at all. Grouping
 * to the /64 is the standard compromise: it is one subscriber's delegation on
 * any sane ISP, so a rotation buys nothing while a second subscriber is
 * unaffected. Two /64s behind one NAT66 are counted together, which is the
 * same imprecision an IPv4 NAT already has.
 *
 * The same key is used by the tunnel count and the data-plane address budget,
 * so one definition of "one peer" cannot drift between them.
 *
 * @param address - the address as {@link clientAddress} resolved it, or any
 *   textual IP; anything unparseable is its own group.
 * @returns the counting key: an IPv4 address as-is, or an IPv6 /64 written in
 *   RFC 5952 style with the all-zero suffix (`2001:db8:1234:5678::`, or
 *   `2001:db8::` when the prefix itself ends in zeros).
 */
export function addressGroup(address: string): string {
  // A zone id (`fe80::1%eth0`) is interface-local noise for counting purposes.
  const bare = address.split('%')[0] ?? address
  const normalized = normalize(bare)
  if (isIP(normalized) !== 6) return normalized
  const hextets = expandHextets(normalized)
  if (hextets === null) return normalized
  const prefix = hextets
    .slice(0, 4)
    .map((hextet) => (parseInt(hextet, 16) & 0xffff).toString(16))
  // Trailing zero hextets of the prefix merge into the `::` the /64 suffix
  // already makes, so one /64 has one spelling no matter how it was written.
  while (prefix.length > 0 && prefix[prefix.length - 1] === '0') prefix.pop()
  return prefix.length === 0 ? '::' : `${prefix.join(':')}::`
}

/**
 * Expand an IPv6 address to its eight hextets.
 *
 * Handles `::` compression, so every spelling of one address (`2001:db8::1`,
 * `2001:0db8:0000:0000:0000:0000:0000:0001`) expands to the same list and
 * therefore groups to the same /64.
 *
 * @param address - a textual IPv6 address without a zone id.
 * @returns the eight hextets as written (1–4 hex digits each), or `null` when
 *   the text is not a plain hextet address.
 */
function expandHextets(address: string): string[] | null {
  const halves = address.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): string[] | null => {
    if (part === '') return []
    const out: string[] = []
    for (const piece of part.split(':')) {
      // A dotted-quad tail is not a plain hextet; the IPv4-mapped spellings
      // were already folded into IPv4 by `normalize`.
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null
      out.push(piece)
    }
    return out
  }
  const head = parse(halves[0] ?? '')
  if (head === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const tail = parse(halves[1] ?? '')
  if (tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<string>(fill).fill('0'), ...tail]
}
