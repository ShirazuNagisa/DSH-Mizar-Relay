/**
 * Which address a tunnel is counted against.
 *
 * The per-address limit is only as good as the address it reads. Behind the
 * documented nginx deployment every peer is `127.0.0.1`, so this module is what
 * keeps the limit meaning "one computer" rather than "the whole relay" — and
 * what keeps a direct connection from forging its own bucket with a header.
 *
 * @module dsh-mizar-relay/test/client-address
 */
import { describe, expect, it } from 'vitest'
import { addressGroup, clientAddress } from '../src/client-address.js'

const LOOPBACK = '127.0.0.1'
const DIRECT = '198.51.100.10'

describe('clientAddress', () => {
  it('uses the socket address when the peer is not a local proxy', () => {
    expect(clientAddress(DIRECT, {}, true)).toBe(DIRECT)
    expect(clientAddress(DIRECT, { 'x-real-ip': '203.0.113.9' }, true)).toBe(DIRECT)
    expect(clientAddress(DIRECT, { 'x-forwarded-for': '203.0.113.9' }, true)).toBe(DIRECT)
  })

  it('attributes a loopback peer to the address the proxy saw', () => {
    expect(clientAddress(LOOPBACK, { 'x-real-ip': '203.0.113.7' }, true)).toBe('203.0.113.7')
    expect(clientAddress(LOOPBACK, { 'x-forwarded-for': '203.0.113.7' }, true)).toBe(
      '203.0.113.7',
    )
  })

  it('reads the rightmost X-Forwarded-For entry, which is the one the proxy appended', () => {
    // nginx's `$proxy_add_x_forwarded_for` appends the address it saw to
    // whatever the client sent, so a client-supplied prefix must not be able to
    // pick the bucket it is counted in.
    expect(clientAddress(LOOPBACK, { 'x-forwarded-for': '192.0.2.1, 203.0.113.7' }, true)).toBe(
      '203.0.113.7',
    )
    expect(
      clientAddress(LOOPBACK, { 'x-forwarded-for': 'garbage, 203.0.113.7' }, true),
    ).toBe('203.0.113.7')
  })

  it('prefers X-Real-IP, which the proxy overwrites with the address it saw', () => {
    expect(
      clientAddress(
        LOOPBACK,
        { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' },
        true,
      ),
    ).toBe('203.0.113.7')
  })

  it('falls back to the socket address when the proxy header is not an address', () => {
    expect(clientAddress(LOOPBACK, { 'x-real-ip': 'not an ip' }, true)).toBe(LOOPBACK)
    expect(
      clientAddress(
        LOOPBACK,
        { 'x-real-ip': 'not an ip', 'x-forwarded-for': '203.0.113.7' },
        true,
      ),
    ).toBe('203.0.113.7')
  })

  it('treats IPv4-mapped loopback as a local proxy', () => {
    // Node reports an IPv4 peer on a dual-stack listener this way; the same
    // proxy must not fall out of the trust check because of the spelling.
    expect(clientAddress('::ffff:127.0.0.1', { 'x-real-ip': '203.0.113.7' }, true)).toBe(
      '203.0.113.7',
    )
  })

  it('accepts an IPv6 client, with the port spelling some proxies use', () => {
    expect(clientAddress(LOOPBACK, { 'x-real-ip': '2001:db8::7' }, true)).toBe('2001:db8::7')
    expect(clientAddress(LOOPBACK, { 'x-forwarded-for': '[2001:db8::7]:443' }, true)).toBe(
      '2001:db8::7',
    )
  })

  it('counts the proxy itself when proxy trust is off', () => {
    expect(clientAddress(LOOPBACK, { 'x-real-ip': '203.0.113.7' }, false)).toBe(LOOPBACK)
  })

  it('reads an array-valued header joined by the HTTP parser', () => {
    expect(
      clientAddress(LOOPBACK, { 'x-forwarded-for': ['198.51.100.9', '203.0.113.7'] }, true),
    ).toBe('203.0.113.7')
  })

  it('says unknown when the socket has no address', () => {
    expect(clientAddress(undefined, { 'x-real-ip': '203.0.113.7' }, true)).toBe('unknown')
  })
})

describe('addressGroup', () => {
  it('counts an IPv4 peer as itself', () => {
    expect(addressGroup('203.0.113.7')).toBe('203.0.113.7')
    // And an IPv4-mapped spelling folds to the same key as the plain one.
    expect(addressGroup('::ffff:203.0.113.7')).toBe('203.0.113.7')
  })

  it('groups an IPv6 peer to its /64, so privacy-address rotation buys nothing', () => {
    // The whole point: a client rotating through the addresses inside its own
    // delegation must not collect a fresh allowance per rotation.
    const rotated = [
      '2001:db8:1234:5678::1',
      '2001:db8:1234:5678:9abc:def0:1234:5678',
      '2001:0db8:1234:5678:0000:0000:0000:0001',
    ]
    for (const address of rotated) {
      expect(addressGroup(address)).toBe('2001:db8:1234:5678::')
    }
    // A neighbouring /64 is a different subscriber and keeps its own key.
    expect(addressGroup('2001:db8:1234:5679::1')).toBe('2001:db8:1234:5679::')
  })

  it('writes the /64 canonically whatever the input spelling', () => {
    expect(addressGroup('2001:db8:0:0:0:0:0:1')).toBe('2001:db8::')
    expect(addressGroup('2001:DB8::1')).toBe('2001:db8::')
  })

  it('drops a zone id before counting', () => {
    expect(addressGroup('fe80::1%eth0')).toBe('fe80::')
    expect(addressGroup('fe80::1')).toBe('fe80::')
  })

  it('leaves anything unparseable in its own group', () => {
    expect(addressGroup('unknown')).toBe('unknown')
    // A malformed IPv6 is not silently collapsed into a shared bucket.
    expect(addressGroup('2001:db8::1::2')).toBe('2001:db8::1::2')
    expect(addressGroup('gggg::1')).toBe('gggg::1')
  })
})
