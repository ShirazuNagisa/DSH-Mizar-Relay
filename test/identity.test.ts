/** Relay identity headers: extraction, fallback, and stripping. */
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_HEADER,
  CLIENT_ID_HEADER,
  identityFor,
  readRelayIdentity,
  withoutPrivateHeaders,
} from '../src/accounts/identity.js'

const hash = 'a'.repeat(64)

describe('relay identity', () => {
  it('prefers the account hash over the installation id', () => {
    const identity = identityFor(
      { [ACCOUNT_HEADER]: hash, [CLIENT_ID_HEADER]: 'device-0001' },
      { room: 'ROOM', peer: '127.0.0.1', userAgent: 'test' },
    )
    expect(identity).toEqual({ kind: 'account', hash, key: `account:${hash}` })
  })

  it('falls back to the installation id, then to a stable anon hash', () => {
    const guest = identityFor(
      { [CLIENT_ID_HEADER]: 'device-0001' },
      { room: 'ROOM', peer: '127.0.0.1', userAgent: 'test' },
    )
    expect(guest).toMatchObject({ kind: 'guest', clientId: 'device-0001' })
    const anon = identityFor(
      {},
      { room: 'ROOM', peer: '127.0.0.1', userAgent: 'test' },
    )
    expect(anon).toMatchObject({ kind: 'anon' })
    expect(anon.key).toMatch(/^anon:[0-9a-f]{16}$/)
    expect(
      identityFor({}, { room: 'ROOM', peer: '127.0.0.1', userAgent: 'test' }).key,
    ).toBe(anon.key)
    expect(
      identityFor({}, { room: 'ROOM', peer: '127.0.0.2', userAgent: 'test' }).key,
    ).not.toBe(anon.key)
  })

  it('rejects malformed headers instead of trusting them', () => {
    expect(readRelayIdentity({ [ACCOUNT_HEADER]: 'too-short' })).toEqual({
      accountHash: null,
      clientId: null,
    })
    expect(readRelayIdentity({ [CLIENT_ID_HEADER]: 'bad id' })).toEqual({
      accountHash: null,
      clientId: null,
    })
  })

  it('strips only the private headers', () => {
    expect(
      withoutPrivateHeaders({
        [ACCOUNT_HEADER]: hash,
        [CLIENT_ID_HEADER]: 'device-0001',
        'content-type': 'application/json',
        'x-mizar-evil': 'kept',
      }),
    ).toEqual({ 'content-type': 'application/json', 'x-mizar-evil': 'kept' })
  })
})
