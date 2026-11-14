/**
 * A device that names the wrong Apple.
 *
 * Nothing in an APNs token says which of the two Apples minted it, so the app
 * has to say -- and the app answers from its build configuration. A Release
 * build installed from Xcode is optimised (`DEBUG` off) but signed for
 * development, so it reports production while holding a sandbox token. Apple
 * answers `BadDeviceToken`, and the relay used to believe it and delete the
 * registration: the phone went silent while the computer still showed a card
 * on it, which is how a finished session stayed on the Lock Screen.
 *
 * These are unit tests against a stub client rather than the fake Apple in
 * `push-api.test.ts` because the assertion is not "a request was made". It is
 * that the second request names the *other* environment, and that the answer
 * is remembered, so the correction costs one push and not one per push.
 *
 * @module dsh-mizar-relay/test/push-environment
 */
import { describe, expect, it } from 'vitest'
import type {
  ApnsClient,
  ApnsEnvironment,
  ApnsLiveActivityEnd,
  ApnsLiveActivityStart,
  ApnsLiveActivityUpdate,
  ApnsNotification,
  ApnsResult,
  ApnsSilentEnd,
} from '../src/apns.js'
import { deliver, deliverActivity, PushRegistry, type PushRequest } from '../src/push.js'

/** What Apple said, keyed by the environment the request named. */
type Answers = Partial<Record<ApnsEnvironment, ApnsResult>>

/** One send, as the stub saw it. */
interface Send {
  readonly kind: 'alert' | 'silent' | 'start' | 'update' | 'end'
  readonly environment: ApnsEnvironment
}

const DELIVERED: ApnsResult = { delivered: true, unregistered: false, status: 200, reason: null }
const BAD_TOKEN: ApnsResult = {
  delivered: false,
  unregistered: true,
  status: 400,
  reason: 'BadDeviceToken',
}

/**
 * An APNs client that answers from a table instead of from Apple.
 *
 * @param answers - what each environment says; `BAD_TOKEN` when it is absent,
 *   because the case under test is "this Apple does not know the token".
 * @param sends - where to append what was sent.
 * @returns the client, dressed as the real one.
 */
function stubApple(answers: Answers, sends: Send[]): ApnsClient {
  const answer = (environment: ApnsEnvironment): ApnsResult =>
    answers[environment] ?? BAD_TOKEN
  const client = {
    async send(notification: ApnsNotification): Promise<ApnsResult> {
      sends.push({ kind: 'alert', environment: notification.environment })
      return answer(notification.environment)
    },
    async sendSilentActivityEnd(end: ApnsSilentEnd): Promise<ApnsResult> {
      sends.push({ kind: 'silent', environment: end.environment })
      return answer(end.environment)
    },
    async sendLiveActivityStart(start: ApnsLiveActivityStart): Promise<ApnsResult> {
      sends.push({ kind: 'start', environment: start.environment })
      return answer(start.environment)
    },
    async sendLiveActivityUpdate(update: ApnsLiveActivityUpdate): Promise<ApnsResult> {
      sends.push({ kind: 'update', environment: update.environment })
      return answer(update.environment)
    },
    async sendLiveActivityEnd(end: ApnsLiveActivityEnd): Promise<ApnsResult> {
      sends.push({ kind: 'end', environment: end.environment })
      return answer(end.environment)
    },
  }
  return client as unknown as ApnsClient
}

/** A phone that reported an environment, with tokens for all three addresses. */
function registered(registry: PushRegistry, environment: ApnsEnvironment): void {
  registry.register('room-a', {
    deviceId: 'phone-1',
    token: 'aabbccdd',
    platform: 'ios',
    environment,
    liveActivityToken: '11223344',
    liveActivityStartToken: '55667788',
    locale: 'en',
  })
}

/** One turn-end notification, which is what ends a card. */
/** The alert fan-out only: one notification also ends the card, twice. */
function alerts(sends: readonly Send[]): ApnsEnvironment[] {
  return sends.filter((send) => send.kind === 'alert').map((send) => send.environment)
}

const notification: PushRequest = {
  kind: 'turn_end',
  title: 'Turn finished',
  body: 'demo is done',
  sessionId: 'session-1',
  threadId: 'session-1',
  collapseId: '',
  timeSensitive: false,
  endLiveActivity: true,
  exceptDeviceIds: [],
}

/** One card to publish. */
const activity = {
  phase: 'start' as const,
  rows: [{ sessionId: 'dsh:a', title: 'demo', runningSince: 1_700_000_000_000 }],
  approvals: [],
  exceptDeviceIds: [],
}

describe('a device that named the wrong Apple', () => {
  it('is asked again on the other one, and corrected', async () => {
    const registry = new PushRegistry()
    registered(registry, 'production')
    const sends: Send[] = []
    const logs: string[] = []
    const apns = stubApple({ sandbox: DELIVERED }, sends)

    const outcome = await deliver(
      { registry, apns, fcm: null, log: (line) => logs.push(line) },
      'room-a',
      notification,
    )

    expect(outcome).toMatchObject({ sent: 1, failed: 0, dropped: 0 })
    expect(alerts(sends)).toEqual(['production', 'sandbox'])
    // The registration survives: a token refused by one Apple is not a dead
    // phone, and deleting it used to be the end of every notification.
    expect(registry.devices('room-a')).toHaveLength(1)
    expect(registry.devices('room-a')[0]?.environment).toBe('sandbox')
    expect(logs.join('\n')).toMatch(/is sandbox, not production/)
  })

  it('does not ask twice once the answer is known', async () => {
    const registry = new PushRegistry()
    registered(registry, 'production')
    const sends: Send[] = []
    const apns = stubApple({ sandbox: DELIVERED }, sends)
    const log = (): void => {}

    await deliver({ registry, apns, fcm: null, log }, 'room-a', notification)
    sends.length = 0
    await deliver({ registry, apns, fcm: null, log }, 'room-a', notification)

    expect(alerts(sends)).toEqual(['sandbox'])
  })

  it('is asked again for a card update, and the card is drawn', async () => {
    const registry = new PushRegistry()
    registered(registry, 'production')
    const sends: Send[] = []
    const apns = stubApple({ sandbox: DELIVERED }, sends)

    const outcome = await deliverActivity(
      { registry, apns, log: (line) => void line },
      'room-a',
      activity,
    )

    expect(outcome).toMatchObject({ sent: 1, failed: 0, dropped: 0 })
    expect(sends).toEqual([
      { kind: 'update', environment: 'production' },
      { kind: 'update', environment: 'sandbox' },
    ])
    expect(registry.devices('room-a')[0]?.environment).toBe('sandbox')
  })

  it('is asked again for the end of a card, which is what takes it down', async () => {
    const registry = new PushRegistry()
    registered(registry, 'production')
    const sends: Send[] = []
    const logs: string[] = []
    const apns = stubApple({ sandbox: DELIVERED }, sends)

    await deliver(
      { registry, apns, fcm: null, log: (line) => logs.push(line) },
      'room-a',
      notification,
    )

    // The wake and the activity end are separate addresses, and both are the
    // sandbox's: a card whose environment is wrong is a card nothing can end.
    expect(sends.filter((send) => send.kind === 'silent').map((send) => send.environment)).toEqual([
      'production',
      'sandbox',
    ])
    expect(sends.filter((send) => send.kind === 'end').map((send) => send.environment)).toEqual([
      'production',
      'sandbox',
    ])
    expect(logs.join('\n')).toMatch(/ended live activity/)
  })

  it('is still believed dead when neither Apple knows the token', async () => {
    const registry = new PushRegistry()
    registered(registry, 'production')
    const sends: Send[] = []
    const apns = stubApple({}, sends)

    const outcome = await deliver(
      { registry, apns, fcm: null, log: (line) => void line },
      'room-a',
      notification,
    )

    expect(alerts(sends)).toEqual(['production', 'sandbox'])
    expect(outcome.dropped).toBe(1)
    expect(registry.devices('room-a')).toHaveLength(0)
  })
})
