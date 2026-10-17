/**
 * APNs, against a fake Apple.
 *
 * The interesting assertions here are not "a request was made". They are the
 * facts that are invisible when they are wrong:
 *
 *   - **The signature verifies as ES256.** A DER-encoded ECDSA signature is a
 *     perfectly well-formed string and produces a JWT that Apple rejects. The
 *     only way to catch that without a real key is to verify what this code
 *     produced with the public half, which is what the first test does.
 *   - **A retired token is reported as retired.** `410 Unregistered` and
 *     `BadDeviceToken` are the difference between a deployment that stops
 *     pushing into a hole and one that does it forever.
 *   - **The environment decides the host.** A token does not say which Apple
 *     minted it, so a relay that picked one host for the deployment answered
 *     `BadDeviceToken` for every phone built the other way -- an answer it then
 *     read as a dead token, deleting the registration of a phone that was
 *     working.
 *
 * @module dsh-mizar-relay/test/apns
 */
import { createServer, type Http2Server } from 'node:http2'
import { createPrivateKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApnsClient,
  apnsOrigin,
  buildLiveActivityEndPayload,
  buildPayload,
  providerToken,
  MAX_PAYLOAD_BYTES,
  type ApnsConfig,
} from '../src/apns.js'
import { deliver, PushRegistry, readDevice, readNotification } from '../src/push.js'

/** A throwaway P-256 key, in the shape Apple hands out. */
function testKey(): { pem: string; privateKey: KeyObject; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    privateKey,
    publicKey,
  }
}

/** One request the fake Apple received. */
interface Seen {
  readonly path: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

/** What a fake Apple saw and answered. */
interface FakeApple {
  readonly origin: string
  readonly seen: Seen[]
  /**
   * Arrivals and answers, in the order they happened.
   *
   * A log rather than a count because the only way to see two requests being in
   * flight at once -- which is what sending a room together means -- is by their
   * arrival landing before the first answer.
   */
  readonly events: string[]
  /** How many separate HTTP/2 connections were opened. */
  sessions(): number
  readonly close: () => Promise<void>
}

/**
 * A fake APNs endpoint.
 *
 * Real HTTP/2 over a real socket rather than a stubbed client, because the
 * framing and the header names are half of what can be wrong -- and because a
 * connection per environment is only observable as a real connection.
 *
 * @param answer - what to reply with, given the request.
 * @param options - `answerDelayMs` holds every reply back, which is what makes
 *   the order of arrivals and answers observable.
 * @returns the origin to point an {@link ApnsClient} at, and what it received.
 */
async function fakeApple(
  answer: (seen: Seen) => { status: number; body?: string },
  options: { readonly answerDelayMs?: number } = {},
): Promise<FakeApple> {
  const seen: Seen[] = []
  const events: string[] = []
  let connections = 0
  const server: Http2Server = createServer()
  server.on('session', () => {
    connections += 1
  })
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      body += chunk
    })
    stream.on('end', () => {
      const record: Seen = {
        path: String(headers[':path'] ?? ''),
        headers: headers as Record<string, string | string[] | undefined>,
        body,
      }
      seen.push(record)
      events.push(`push ${record.path}`)
      const result = answer(record)
      // Held back by a timer whether or not a delay was asked for, so both cases
      // take the same path and a later request can arrive while an earlier one
      // is still unanswered.
      setTimeout(() => {
        events.push(`pop ${record.path}`)
        stream.respond({ ':status': result.status, 'content-type': 'application/json' })
        stream.end(result.body ?? '')
      }, options.answerDelayMs ?? 0)
    })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })

  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    events,
    sessions: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const clients: ApnsClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  vi.useRealTimers()
})

/** A client pointed at a fake Apple, remembered so it is closed after the test. */
function fakeClient(apple: FakeApple, pem: string): ApnsClient {
  const client = new ApnsClient(
    {
      key: pem,
      keyId: 'ABCDE12345',
      teamId: 'TEAM123456',
      topic: 'me.shirazu.dshmizar',
      production: false,
      authority: apple.origin,
    },
    () => {},
  )
  clients.push(client)
  return client
}

/**
 * The `iat` claim of the provider token in an authorization header.
 *
 * @param authorization - the header, as the fake Apple received it.
 * @returns the issue time in seconds, or `null` when there was no token.
 */
function claimedAt(authorization: string | string[] | undefined): number | null {
  const header = typeof authorization === 'string' ? authorization : ''
  const payload = header.replace(/^bearer /, '').split('.')[1]
  if (payload === undefined) return null
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat: number }).iat
}

describe('provider tokens', () => {
  it('signs ES256 the way JWS wants it, not the way Node defaults', () => {
    const key = testKey()
    const token = providerToken(key.privateKey, 'ABCDE12345', 'TEAM123456', 1_700_000_000_000)

    const [header, claims, signature] = token.split('.')
    expect(header).toBeDefined()
    expect(claims).toBeDefined()
    expect(signature).toBeDefined()

    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({
      alg: 'ES256',
      kid: 'ABCDE12345',
    })
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString('utf8'))).toEqual({
      iss: 'TEAM123456',
      iat: 1_700_000_000,
    })

    // The whole point. A DER signature is ~70 bytes and verifies as nothing;
    // the raw `R || S` pair is exactly 64.
    const raw = Buffer.from(signature ?? '', 'base64url')
    expect(raw.length).toBe(64)
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
        raw,
      ),
    ).toBe(true)
  })
})

describe('payloads', () => {
  it('carries the session outside aps so a tap can open it', () => {
    const payload = buildPayload(
      {
        deviceToken: 'aa',
        environment: 'sandbox',
        title: 'Permission needed',
        body: 'Bash · demo',
        threadId: 's1',
        collapseId: 'approval-s1-Bash',
        urgent: true,
        sessionId: 's1',
        kind: 'approval',
      },
      false,
    )
    expect(payload).toMatchObject({
      aps: { alert: { title: 'Permission needed', body: 'Bash · demo' }, 'thread-id': 's1' },
      sessionId: 's1',
      kind: 'approval',
    })
    // Off by default: the level is only honoured with an entitlement this app
    // may not carry, and asking for a capability that was never provisioned is
    // not something a relay should decide for an operator.
    expect((payload['aps'] as Record<string, unknown>)['interruption-level']).toBeUndefined()
  })

  it('asks for time sensitivity only when told to', () => {
    const payload = buildPayload(
      {
        deviceToken: 'aa',
        environment: 'sandbox',
        title: 't',
        body: 'b',
        threadId: 's1',
        collapseId: '',
        urgent: true,
        sessionId: null,
        kind: 'approval',
      },
      true,
    )
    expect((payload['aps'] as Record<string, unknown>)['interruption-level']).toBe('time-sensitive')
  })

  it('builds the Live Activity end payload in Unix seconds, with the final content state', () => {
    // Both stamps are seconds. Milliseconds would land in the year 56000, and
    // iOS discards the end event -- which leaves the activity counting, the
    // exact bug this exists to fix. The content state is required for the same
    // outcome: without it a device accepted the push and kept counting (measured
    // 2026-10-18). `{finished:{}}` is the app's `LiveActivityPhase.finished` in
    // Swift's synthesised Codable.
    expect(buildLiveActivityEndPayload(1_700_000_000_999)).toEqual({
      aps: {
        timestamp: 1_700_000_000,
        event: 'end',
        // One second, not zero: the state has to render for the system to end
        // the activity, and a future date has no equal-date edge.
        'dismissal-date': 1_700_000_001,
        'content-state': { finished: {} },
      },
    })
  })
})

describe('which Apple a token belongs to', () => {
  it('sends each environment to its own host', () => {
    const config: ApnsConfig = {
      key: 'unused',
      keyId: 'K',
      teamId: 'T',
      topic: 'me.shirazu.dshmizar',
      production: false,
    }

    // The two hosts do not accept each other's tokens and nothing inside a token
    // says which one minted it, so this mapping is the only thing between a
    // Debug phone and `BadDeviceToken` for every push it is ever sent.
    expect(apnsOrigin(config, 'sandbox')).toBe('https://api.sandbox.push.apple.com')
    expect(apnsOrigin(config, 'production')).toBe('https://api.push.apple.com')

    // The deployment's declared environment no longer selects anything: a relay
    // that calls itself production still routes a sandbox device to the sandbox
    // host, which is exactly the case that used to delete the registration.
    expect(apnsOrigin({ ...config, production: true }, 'sandbox')).toBe(
      'https://api.sandbox.push.apple.com',
    )

    // And the override wins for both, which is what lets every other test in
    // this file point a client at a local fake.
    expect(apnsOrigin({ ...config, authority: 'http://127.0.0.1:1' }, 'sandbox')).toBe(
      'http://127.0.0.1:1',
    )
    expect(apnsOrigin({ ...config, authority: 'http://127.0.0.1:1' }, 'production')).toBe(
      'http://127.0.0.1:1',
    )
  })
})

describe('delivery', () => {
  it('sends one framed request per device, addressed to the token', async () => {
    const apple = await fakeApple(() => ({ status: 200 }))
    const key = testKey()
    const client = new ApnsClient(
      {
        key: key.pem,
        keyId: 'ABCDE12345',
        teamId: 'TEAM123456',
        topic: 'me.shirazu.dshmizar',
        production: false,
        authority: apple.origin,
      },
      () => {},
    )
    clients.push(client)

    const result = await client.send({
      deviceToken: 'deadbeef',
      environment: 'sandbox',
      title: 'Task complete',
      body: 'demo',
      threadId: 's1',
      collapseId: 'turn-s1',
      urgent: false,
      sessionId: 's1',
      kind: 'turn-complete',
    })

    expect(result).toEqual({ delivered: true, unregistered: false, status: 200, reason: null })
    expect(apple.seen).toHaveLength(1)
    const request = apple.seen[0]
    expect(request?.path).toBe('/3/device/deadbeef')
    expect(request?.headers['apns-topic']).toBe('me.shirazu.dshmizar')
    expect(request?.headers['apns-push-type']).toBe('alert')
    expect(request?.headers['apns-collapse-id']).toBe('turn-s1')
    // 5 for a completion: the device may batch it. An approval is 10, below.
    expect(String(request?.headers['apns-priority'])).toBe('5')
    expect(request?.headers['authorization']).toMatch(/^bearer ey/)
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      aps: { alert: { title: 'Task complete' } },
      sessionId: 's1',
    })

    await apple.close()
  })

  it('asks for immediate delivery when an agent is blocked', async () => {
    const apple = await fakeApple(() => ({ status: 200 }))
    const key = testKey()
    const registry = new PushRegistry()
    registry.register('room-a', {
      deviceId: 'phone',
      token: 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'zh-Hans',
    })
    const client = new ApnsClient(
      {
        key: key.pem,
        keyId: 'K',
        teamId: 'T',
        topic: 'me.shirazu.dshmizar',
        production: false,
        authority: apple.origin,
      },
      () => {},
    )
    clients.push(client)

    const outcome = await deliver(
      { registry, apns: client, fcm: null, log: () => {} },
      'room-a',
      {
        kind: 'approval',
        title: '需要你的许可',
        body: 'Bash · demo',
        sessionId: 's1',
        threadId: 's1',
        collapseId: 'approval-s1',
        timeSensitive: false,
        exceptDeviceIds: [],
      },
    )

    expect(outcome).toMatchObject({ sent: 1, failed: 0, dropped: 0, enabled: true })
    expect(String(apple.seen[0]?.headers['apns-priority'])).toBe('10')
    await apple.close()
  })

  it('sends to the room together, so one slow phone holds up nothing', async () => {
    // Every reply is held back for a moment, which is what makes the order of
    // arrivals and answers visible: a device-by-device loop cannot have two
    // requests in Apple's hands at once.
    const apple = await fakeApple(() => ({ status: 200 }), { answerDelayMs: 50 })
    const key = testKey()
    const registry = new PushRegistry()
    registry.register('room-a', {
      deviceId: 'phone-1',
      token: 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
    })
    registry.register('room-a', {
      deviceId: 'phone-2',
      token: 'bb',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
    })
    const client = fakeClient(apple, key.pem)

    const outcome = await deliver({ registry, apns: client, fcm: null, log: () => {} }, 'room-a', {
      kind: 'turn-complete',
      title: 'Task complete',
      body: 'demo',
      sessionId: 's1',
      threadId: 's1',
      collapseId: '',
      timeSensitive: false,
      exceptDeviceIds: [],
    })

    expect(outcome).toMatchObject({ sent: 2, failed: 0, dropped: 0, enabled: true })
    // The second phone's request reached Apple before the first was answered.
    // Sent one at a time, a room of sixteen devices where one is unreachable
    // takes sixteen request timeouts to work through -- longer than the plugin's
    // ten-second client timeout, so the Mac reports a failure for notifications
    // that did go out.
    expect(apple.events.indexOf('push /3/device/bb')).toBeLessThan(
      apple.events.indexOf('pop /3/device/aa'),
    )
    await apple.close()
  })

  it('carries each device\'s own environment, and keeps a session for each', async () => {
    const apple = await fakeApple(() => ({ status: 200 }))
    const key = testKey()
    const registry = new PushRegistry()
    // One room, two phones that disagree: the Debug build on the desk talks to
    // the sandbox while the TestFlight build in a pocket talks to production.
    registry.register('room-a', {
      deviceId: 'desk-debug-build',
      token: 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
    })
    registry.register('room-a', {
      deviceId: 'pocket-testflight-build',
      token: 'bb',
      environment: 'production',
      locale: 'en',
    })
    const client = fakeClient(apple, key.pem)

    const outcome = await deliver({ registry, apns: client, fcm: null, log: () => {} }, 'room-a', {
      kind: 'turn-complete',
      title: 'Task complete',
      body: 'demo',
      sessionId: 's1',
      threadId: 's1',
      collapseId: '',
      timeSensitive: false,
      exceptDeviceIds: [],
    })

    expect(outcome).toMatchObject({ sent: 2, failed: 0, dropped: 0, enabled: true })
    expect(apple.seen.map((request) => request.path).sort()).toEqual([
      '/3/device/aa',
      '/3/device/bb',
    ])
    // Both environments resolve to this fake because the authority override
    // applies to both, so where the split shows up here is as a connection each.
    // A client that reused one session for the pair could only ever have reached
    // one host, which is the defect: the phones are on different Apples and the
    // client has to be willing to talk to both. The hosts themselves are pinned
    // by the `apnsOrigin` test above, which is the only place they are visible
    // without a real Apple to connect to.
    expect(apple.sessions()).toBe(2)
    await apple.close()
  })

  it('forgets a token Apple says is retired', async () => {
    const apple = await fakeApple(() => ({
      status: 410,
      body: JSON.stringify({ reason: 'Unregistered' }),
    }))
    const key = testKey()
    const registry = new PushRegistry()
    registry.register('room-a', {
      deviceId: 'phone',
      token: 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
    })
    const client = new ApnsClient(
      { key: key.pem, keyId: 'K', teamId: 'T', topic: 'b', production: false, authority: apple.origin },
      () => {},
    )
    clients.push(client)

    const outcome = await deliver(
      { registry, apns: client, fcm: null, log: () => {} },
      'room-a',
      {
        kind: 'turn-complete',
        title: 'Task complete',
        body: 'demo',
        sessionId: 's1',
        threadId: 's1',
        collapseId: '',
        timeSensitive: false,
        exceptDeviceIds: [],
      },
    )

    expect(outcome).toMatchObject({ sent: 0, dropped: 1 })
    // And gone, so the next notification does not pay for the same answer.
    expect(registry.devices('room-a')).toHaveLength(0)
    await apple.close()
  })

  it('treats BadDeviceToken as retired too', async () => {
    const apple = await fakeApple(() => ({
      status: 400,
      body: JSON.stringify({ reason: 'BadDeviceToken' }),
    }))
    const key = testKey()
    const client = new ApnsClient(
      { key: key.pem, keyId: 'K', teamId: 'T', topic: 'b', production: true, authority: apple.origin },
      () => {},
    )
    clients.push(client)

    const result = await client.send({
      deviceToken: 'aa',
      environment: 'sandbox',
      title: 't',
      body: 'b',
      threadId: 't',
      collapseId: '',
      urgent: true,
      sessionId: null,
      kind: 'approval',
    })
    // Retired, and the reason now means what it says: each token's own
    // environment is honoured per notification, so this is a genuinely dead
    // token, or one for another topic -- not the host mismatch this relay used
    // to create for itself and then delete the registration over.
    expect(result.unregistered).toBe(true)
    await apple.close()
  })

  it('reports a transient refusal without retiring anything', async () => {
    const apple = await fakeApple(() => ({ status: 503, body: JSON.stringify({ reason: 'ServiceUnavailable' }) }))
    const key = testKey()
    const client = new ApnsClient(
      { key: key.pem, keyId: 'K', teamId: 'T', topic: 'b', production: true, authority: apple.origin },
      () => {},
    )
    clients.push(client)

    const result = await client.send({
      deviceToken: 'aa',
      environment: 'production',
      title: 't',
      body: 'b',
      threadId: 't',
      collapseId: '',
      urgent: false,
      sessionId: null,
      kind: 'approval',
    })
    expect(result).toMatchObject({ delivered: false, unregistered: false, status: 503 })
    expect(result.reason).toBe('ServiceUnavailable')
    // Asked once. Only a provider token Apple refuses earns a second attempt --
    // a busy Apple is a busy Apple, and retrying it would double the load at
    // exactly the moment it can least take it.
    expect(apple.seen).toHaveLength(1)
    await apple.close()
  })

  it('refuses an oversized payload without asking Apple', async () => {
    const apple = await fakeApple(() => ({ status: 200 }))
    const key = testKey()
    const client = new ApnsClient(
      { key: key.pem, keyId: 'K', teamId: 'T', topic: 'b', production: true, authority: apple.origin },
      () => {},
    )
    clients.push(client)

    const result = await client.send({
      deviceToken: 'aa',
      environment: 'production',
      title: 't',
      body: 'x'.repeat(MAX_PAYLOAD_BYTES + 100),
      threadId: 't',
      collapseId: '',
      urgent: false,
      sessionId: null,
      kind: 'approval',
    })
    expect(result).toMatchObject({ delivered: false, status: 413 })
    expect(apple.seen).toHaveLength(0)
    await apple.close()
  })

  it('says so, once, when no key is configured', async () => {
    const registry = new PushRegistry()
    registry.register('room-a', {
      deviceId: 'phone',
      token: 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
    })
    const lines: string[] = []
    const outcome = await deliver({ registry, apns: null, fcm: null, log: (line) => lines.push(line) }, 'room-a', {
      kind: 'turn-complete',
      title: 't',
      body: 'b',
      sessionId: null,
      threadId: 't',
      collapseId: '',
      timeSensitive: false,
      exceptDeviceIds: [],
    })
    expect(outcome.enabled).toBe(false)
    expect(outcome.sent).toBe(0)
    expect(lines).toHaveLength(1)
  })
})

describe('ending a Live Activity', () => {
  /** One registered iPhone with both its alert and its activity token. */
  function registeredPhone(
    registry: PushRegistry,
    overrides: { deviceId?: string; token?: string; liveActivityToken?: string | null } = {},
  ): void {
    registry.register('room-a', {
      deviceId: overrides.deviceId ?? 'phone',
      token: overrides.token ?? 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken:
        overrides.liveActivityToken === undefined ? 'feedface' : overrides.liveActivityToken,
    })
  }

  /** A notification whose alert leg should be unaffected by the end leg. */
  const request = {
    kind: 'turn-complete',
    title: '任务完成',
    body: 'demo',
    sessionId: 's1',
    threadId: 's1',
    collapseId: '',
    timeSensitive: false,
    exceptDeviceIds: [] as string[],
    endLiveActivity: true,
  }

  it('addresses the activity token with the liveactivity headers and payload', async () => {
    const apple = await fakeApple(() => ({ status: 200 }))
    const key = testKey()
    const client = fakeClient(apple, key.pem)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)

    const result = await client.sendLiveActivityEnd({ token: 'abc123', environment: 'sandbox' })

    expect(result).toEqual({ delivered: true, unregistered: false, status: 200, reason: null })
    expect(apple.seen).toHaveLength(1)
    const sent = apple.seen[0]
    expect(sent?.path).toBe('/3/device/abc123')
    // The activity's own topic. Addressing the plain app topic earns
    // `DeviceTokenNotForTopic`, which is not a retired token and so would be
    // retried forever.
    expect(sent?.headers['apns-topic']).toBe('me.shirazu.dshmizar.push-type.liveactivity')
    expect(sent?.headers['apns-push-type']).toBe('liveactivity')
    // Activity pushes are accepted at priority 10 only, and an end event is
    // never worth holding: the activity has already stopped.
    expect(String(sent?.headers['apns-priority'])).toBe('10')
    expect(String(sent?.headers['apns-expiration'])).toBe('0')
    expect(sent?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({
      aps: {
        timestamp: 1_700_000_000,
        event: 'end',
        'dismissal-date': 1_700_000_001,
        'content-state': { finished: {} },
      },
    })

    await apple.close()
  })

  it('ends every iPhone activity, including the one the app is showing', async () => {
    const apple = await fakeApple(() => ({ status: 200 }))
    const key = testKey()
    const registry = new PushRegistry()
    registeredPhone(registry, { deviceId: 'on-screen', token: 'aa', liveActivityToken: '11' })
    registeredPhone(registry, { deviceId: 'in-pocket', token: 'bb', liveActivityToken: '22' })
    const client = fakeClient(apple, key.pem)

    const outcome = await deliver(
      { registry, apns: client, fcm: null, log: () => {} },
      'room-a',
      // The app on screen is why the *alert* is skipped. The activity still has
      // to end: an app on screen is exactly where a counting timer is visible.
      { ...request, exceptDeviceIds: ['on-screen'] },
    )

    expect(outcome).toMatchObject({ sent: 1, failed: 0, dropped: 0, enabled: true })
    const alerts = apple.seen.filter((sent) => sent.headers['apns-push-type'] === 'alert')
    const ends = apple.seen.filter((sent) => sent.headers['apns-push-type'] === 'liveactivity')
    expect(alerts.map((sent) => sent.path)).toEqual(['/3/device/bb'])
    expect(ends.map((sent) => sent.path).sort()).toEqual(['/3/device/11', '/3/device/22'])

    await apple.close()
  })

  it('sends no end push when endLiveActivity is not set', async () => {
    const apple = await fakeApple(() => ({ status: 200 }))
    const key = testKey()
    const registry = new PushRegistry()
    registeredPhone(registry)
    const client = fakeClient(apple, key.pem)

    await deliver(
      { registry, apns: client, fcm: null, log: () => {} },
      'room-a',
      { ...request, endLiveActivity: false },
    )

    expect(apple.seen).toHaveLength(1)
    expect(apple.seen[0]?.headers['apns-push-type']).toBe('alert')
    await apple.close()
  })

  it('clears only the activity token Apple says is retired', async () => {
    const apple = await fakeApple((sent) =>
      sent.headers['apns-push-type'] === 'liveactivity'
        ? { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }
        : { status: 200 },
    )
    const key = testKey()
    const registry = new PushRegistry()
    registeredPhone(registry)
    const client = fakeClient(apple, key.pem)

    const outcome = await deliver(
      { registry, apns: client, fcm: null, log: () => {} },
      'room-a',
      request,
    )

    // The alert leg is untouched by what happened to the activity leg.
    expect(outcome).toMatchObject({ sent: 1, failed: 0, dropped: 0, enabled: true })
    const [device] = registry.devices('room-a')
    expect(device?.liveActivityToken).toBeNull()
    // Never the phone: its alert token still works, and dropping the record
    // would silence a phone that is perfectly reachable.
    expect(device?.token).toBe('aa')
    expect(registry.devices('room-a')).toHaveLength(1)

    await apple.close()
  })

  it('keeps a failed end push out of the alert tallies, and keeps the token', async () => {
    const apple = await fakeApple((sent) =>
      sent.headers['apns-push-type'] === 'liveactivity'
        ? { status: 503, body: JSON.stringify({ reason: 'ServiceUnavailable' }) }
        : { status: 200 },
    )
    const key = testKey()
    const registry = new PushRegistry()
    registeredPhone(registry)
    const client = fakeClient(apple, key.pem)

    const outcome = await deliver(
      { registry, apns: client, fcm: null, log: () => {} },
      'room-a',
      request,
    )

    expect(outcome).toMatchObject({ sent: 1, failed: 0, dropped: 0, enabled: true })
    // A busy Apple is not a retired token: keep it and try again next time.
    expect(registry.devices('room-a')[0]?.liveActivityToken).toBe('feedface')
    await apple.close()
  })

  it('never ends an activity on Android, where the activity field is ignored', async () => {
    // Android has no Live Activity and no APNs key in this test: if the field
    // leaked through, the end leg would try to push. `readDevice` is where the
    // field is dropped, so this asserts it never reaches a device.
    const device = readDevice({
      deviceId: 'droid',
      token: 'droid-token',
      platform: 'android',
      liveActivityToken: 'feedface',
    })
    expect(device).toMatchObject({ platform: 'android', liveActivityToken: null })
    expect(readDevice({
      deviceId: 'droid',
      token: 'droid-token',
      platform: 'android',
      // Not even valid hex: the field is ignored on Android, not validated.
      liveActivityToken: 'not/hex',
    })).toMatchObject({ platform: 'android', liveActivityToken: null })
  })
})

describe('a provider token Apple will not accept', () => {
  /** One notification, as the client takes it. */
  const notification = {
    deviceToken: 'aa',
    environment: 'sandbox' as const,
    title: 'Task complete',
    body: 'demo',
    threadId: 's1',
    collapseId: '',
    urgent: false,
    sessionId: 's1',
    kind: 'turn-complete',
  }

  it('mints a fresh one and asks once more', async () => {
    // The clock moves between the two attempts, which is what makes the second
    // token's issue time differ from the first. Without that this could only
    // assert "two requests", and a retry that re-sent the same rejected token
    // would pass -- a signed JWS is not otherwise comparable, because ES256
    // signatures are randomised.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    let attempt = 0
    const apple = await fakeApple(() => {
      attempt += 1
      if (attempt === 1) {
        vi.setSystemTime(1_700_000_001_000)
        return { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) }
      }
      return { status: 200 }
    })
    const key = testKey()
    const client = fakeClient(apple, key.pem)

    const result = await client.send(notification)

    // Apple's second answer is the one reported, and by then it is a delivery.
    expect(result).toMatchObject({ delivered: true, unregistered: false, status: 200 })
    expect(apple.seen).toHaveLength(2)
    expect(apple.seen.map((request) => claimedAt(request.headers['authorization']))).toEqual([
      1_700_000_000, 1_700_000_001,
    ])

    // And the token that worked is the cached one, so the retry costs a round
    // trip once rather than a signature per notification from then on.
    await client.send(notification)
    expect(claimedAt(apple.seen[2]?.headers['authorization'])).toBe(1_700_000_001)
    await apple.close()
  })

  it('reports what Apple said after one retry, rather than looping', async () => {
    const apple = await fakeApple(() => ({
      status: 403,
      body: JSON.stringify({ reason: 'InvalidProviderToken' }),
    }))
    const key = testKey()
    const client = fakeClient(apple, key.pem)

    const result = await client.send(notification)

    expect(result).toMatchObject({ delivered: false, unregistered: false, status: 403 })
    expect(result.reason).toBe('InvalidProviderToken')
    // Two requests and no more. A key Apple will not accept is a configuration
    // problem, and asking again with it cannot produce a different answer --
    // while a loop would be a request storm against an endpoint that rate-limits
    // by the token, turning a misconfiguration into an outage.
    expect(apple.seen).toHaveLength(2)
    await apple.close()
  })
})

describe('the registry', () => {
  it('keeps rooms apart', () => {
    const registry = new PushRegistry()
    registry.register('a', { deviceId: 'p1', token: 'aa', platform: 'ios', environment: 'sandbox', locale: 'en' })
    registry.register('b', { deviceId: 'p2', token: 'bb', platform: 'ios', environment: 'sandbox', locale: 'en' })
    expect(registry.devices('a')).toHaveLength(1)
    expect(registry.devices('b')).toHaveLength(1)
    expect(registry.roomCount).toBe(2)
    expect(registry.deviceCount).toBe(2)
  })

  it('replaces a re-registered device rather than accumulating it', () => {
    const registry = new PushRegistry()
    const device = { deviceId: 'p1', token: 'aa', platform: 'ios' as const, environment: 'sandbox' as const, locale: 'en' }
    registry.register('a', device)
    registry.register('a', { ...device, token: 'bb' })
    expect(registry.devices('a')).toHaveLength(1)
    expect(registry.devices('a')[0]?.token).toBe('bb')
  })

  it('bounds how many devices one room may have', () => {
    const registry = new PushRegistry()
    for (let index = 0; index < 16; index += 1) {
      expect(
        registry.register('a', {
          deviceId: `p${index}`,
          token: 'aa',
          platform: 'ios',
          environment: 'sandbox',
          locale: 'en',
        }),
      ).toBe(true)
    }
    expect(
      registry.register('a', { deviceId: 'p99', token: 'aa', platform: 'ios', environment: 'sandbox', locale: 'en' }),
    ).toBe(false)
    // Re-registering an existing device is not a new one.
    expect(
      registry.register('a', { deviceId: 'p0', token: 'bb', platform: 'ios', environment: 'sandbox', locale: 'en' }),
    ).toBe(true)
  })

  it('forgets every record holding a retired token', () => {
    const registry = new PushRegistry()
    registry.register('a', { deviceId: 'p1', token: 'aa', platform: 'ios', environment: 'sandbox', locale: 'en' })
    registry.register('a', { deviceId: 'p2', token: 'aa', platform: 'ios', environment: 'sandbox', locale: 'en' })
    registry.register('a', { deviceId: 'p3', token: 'bb', platform: 'ios', environment: 'sandbox', locale: 'en' })
    expect(registry.forgetToken('a', 'aa')).toBe(2)
    expect(registry.devices('a').map((device) => device.deviceId)).toEqual(['p3'])
  })

  it('clears one device\'s activity token, and only while it is still the current one', () => {
    const registry = new PushRegistry()
    registry.register('a', {
      deviceId: 'p1',
      token: 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: '11',
    })
    registry.register('a', {
      deviceId: 'p2',
      token: 'bb',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: '22',
    })

    // An answer about a token the phone has already replaced must not clear the
    // replacement: a slow 410 for activity `11` can be in flight when the app
    // registers the next activity's token, and clearing on that would end the
    // *new* activity the first time anybody got a late answer.
    expect(registry.clearLiveActivityToken('a', 'p1', 'stale')).toBe(false)
    expect(registry.devices('a')[0]?.liveActivityToken).toBe('11')

    expect(registry.clearLiveActivityToken('a', 'p1', '11')).toBe(true)
    expect(registry.devices('a').find((device) => device.deviceId === 'p1')).toMatchObject({
      token: 'aa',
      liveActivityToken: null,
    })
    // And nothing else changed.
    expect(registry.devices('a').find((device) => device.deviceId === 'p2')?.liveActivityToken).toBe('22')
    expect(registry.deviceCount).toBe(2)
  })
})

describe('request validation', () => {
  it('refuses a token that would escape the APNs path', () => {
    // Interpolated straight into `/3/device/<token>`, so a slash is a request
    // for a different endpoint rather than a malformed token.
    expect(
      readDevice({ deviceId: 'p', token: '../../admin', environment: 'sandbox' }),
    ).toBeNull()
    expect(readDevice({ deviceId: 'p', token: 'deadBEEF', environment: 'sandbox' })).toMatchObject({
      token: 'deadBEEF',
      environment: 'sandbox',
    })
  })

  it('defaults an unknown environment to production', () => {
    // The safe direction: the production host refuses a sandbox token loudly,
    // while the sandbox host silently accepts nothing a real device sent.
    expect(readDevice({ deviceId: 'p', token: 'aa', environment: 'nonsense' })?.environment).toBe(
      'production',
    )
  })

  it('reads an activity token only for iOS, and only when it is hex', () => {
    // Absent means "the phone has no activity running", which is how a phone
    // clears its token after ending one itself.
    expect(readDevice({ deviceId: 'p', token: 'aa', environment: 'sandbox' })?.liveActivityToken).toBeNull()
    expect(
      readDevice({ deviceId: 'p', token: 'aa', environment: 'sandbox', liveActivityToken: 'deadBEEF' }),
    ).toMatchObject({ liveActivityToken: 'deadBEEF' })
    // Same rule as a device token: it is interpolated into an APNs URL path, so
    // a slash is a request for a different endpoint, and a 400 is honest.
    expect(
      readDevice({ deviceId: 'p', token: 'aa', environment: 'sandbox', liveActivityToken: 'has/a/slash' }),
    ).toBeNull()
    expect(
      readDevice({ deviceId: 'p', token: 'aa', environment: 'sandbox', liveActivityToken: 'a'.repeat(201) }),
    ).toBeNull()
    expect(
      readDevice({ deviceId: 'p', token: 'aa', environment: 'sandbox', liveActivityToken: 7 }),
    ).toBeNull()
  })

  it('reads endLiveActivity as a strict true, defaulting to false', () => {
    expect(readNotification({ title: 't', body: 'b' })?.endLiveActivity).toBe(false)
    expect(readNotification({ title: 't', body: 'b', endLiveActivity: true })?.endLiveActivity).toBe(true)
    // Only `true` triggers an end push; a truthy-looking string is not a
    // decision worth acting on.
    expect(readNotification({ title: 't', body: 'b', endLiveActivity: 'true' })?.endLiveActivity).toBe(false)
  })

  it('requires a title and truncates the rest', () => {
    expect(readNotification({ title: '', body: 'b' })).toBeNull()
    expect(readNotification({ body: 'b' })).toBeNull()
    const long = readNotification({ title: 'x'.repeat(500), body: 'b', kind: 'approval' })
    expect(long?.title).toHaveLength(200)
    expect(long?.kind).toBe('approval')
  })

  it('ignores an exclusion list it cannot read', () => {
    // A suppression hint is never worth a 400. Getting it wrong has to produce a
    // notification somebody did not need, never a notification nobody gets.
    expect(readNotification({ title: 't', body: 'b' })?.exceptDeviceIds).toEqual([])
    expect(
      readNotification({ title: 't', body: 'b', exceptDeviceIds: 'phone-1' })?.exceptDeviceIds,
    ).toEqual([])
    expect(
      readNotification({ title: 't', body: 'b', exceptDeviceIds: ['phone-1', 7, { a: 1 }] })
        ?.exceptDeviceIds,
    ).toEqual(['phone-1'])
    // Bounded twice over: an id is capped at the length a real one has, and the
    // list at the number of devices a room may hold -- the body cap alone would
    // still allow sixty thousand entries to walk.
    const long = readNotification({
      title: 't',
      body: 'b',
      exceptDeviceIds: Array.from({ length: 40 }, (_unused, index) => `p${index}`),
    })
    expect(long?.exceptDeviceIds).toHaveLength(16)
    expect(
      readNotification({ title: 't', body: 'b', exceptDeviceIds: ['x'.repeat(500)] })
        ?.exceptDeviceIds[0],
    ).toHaveLength(200)
  })
})
