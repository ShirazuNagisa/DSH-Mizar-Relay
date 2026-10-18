/**
 * Where a room's phones can be reached.
 *
 * The relay's half of push, and deliberately the smaller half. It knows which
 * tokens belong to which room, which service each token belongs to, and how to
 * hand a notification to Apple or to Google; it does **not** know what a session
 * is, what an approval is, or when either deserves a notification. That
 * judgement stays on the computer, in the plugin, where the evidence is.
 *
 * ### Why the room comes from the credential
 *
 * A registration is authenticated by the same tunnel credential the computer already
 * presents, and the room is derived from it exactly as the tunnel's is. There is
 * therefore no way to register a token against somebody else's room, and no
 * second enrolment mechanism to get wrong -- which is the whole reason the phone
 * does not talk to this API directly.
 *
 * ### Why the registry is in memory
 *
 * A room's registrations are a cache of what the computer already knows, and the computer
 * re-announces all of them every time its tunnel reconnects. Persisting them
 * here would create a second copy of a fact that has an owner, and a relay that
 * restarted would then serve stale tokens forever with nothing to correct it.
 *
 * @module dsh-mizar-relay/push
 */
import type { ApnsClient, ApnsEnvironment, ApnsNotification, ApnsResult } from './apns.js'
import type { FcmClient, FcmNotification, FcmResult } from './fcm.js'

/** Which push service a device's token belongs to. */
export type PushPlatform = 'ios' | 'android'

/** One device's push endpoint, as its app reported it. */
export interface PushDevice {
  readonly deviceId: string
  readonly token: string
  /** Which service the token belongs to, and therefore which client sends it. */
  readonly platform: PushPlatform
  /**
   * Which APNs the token belongs to, for an iOS device.
   *
   * `null` for Android, which has one service and one environment: FCM is not
   * run twice, so there is nothing for a phone to disagree with the relay
   * about. Kept as a nullable field rather than a second record shape because
   * everything else about a registration is the same on both platforms.
   */
  readonly environment: ApnsEnvironment | null
  /**
   * The activity push token, for an iOS device that has a Live Activity running.
   *
   * `null` when the phone has no activity, and always on Android, which has no
   * Live Activity even if its app sends the field. This is **not** the alert
   * token: ending an activity addresses a token iOS mints per activity, and it
   * is retired with the activity rather than with the install.
   */
  readonly liveActivityToken: string | null
  readonly locale: string
  readonly registeredAt: number
}

/** One notification, as the plugin described it. */
export interface PushRequest {
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly sessionId: string | null
  readonly threadId: string
  readonly collapseId: string
  readonly timeSensitive: boolean
  /**
   * Whether the phone's Live Activity for this notification's session should end.
   *
   * Separate from the alert fan-out, because the two are suppressed for opposite
   * reasons: a phone whose app is on screen is skipped for an alert, and that is
   * exactly where a Live Activity that keeps counting is most visible. Off by
   * default: a relay that ended activities for every notification would dismiss
   * one that is still running.
   */
  readonly endLiveActivity: boolean
  /**
   * Devices the plugin has already decided are looking at the app.
   *
   * Empty means everybody. Skipped rather than refused: the plugin's evidence is
   * that an app reported itself on screen, which says nothing about whether the
   * token is still good, so a device dropped from the registry because of it
   * would have to re-register to be told anything ever again.
   */
  readonly exceptDeviceIds: readonly string[]
}

/** What a notify call did. */
export interface PushOutcome {
  /** How many devices the push service accepted it for. */
  readonly sent: number
  /** How many it refused, or could not be sent to at all. */
  readonly failed: number
  /** How many tokens were retired and forgotten. */
  readonly dropped: number
  /** Whether this relay has push configured at all, for either platform. */
  readonly enabled: boolean
}

/** Longest accepted iOS device token, in characters. APNs tokens are 32 bytes of hex. */
const MAX_IOS_TOKEN_LENGTH = 200

/** Longest accepted FCM registration token, in characters. They run to ~200 today. */
const MAX_ANDROID_TOKEN_LENGTH = 400

/**
 * An APNs token is hex.
 *
 * Checking is not paranoia: a token with a slash in it would be interpolated
 * straight into the APNs request path.
 */
const IOS_TOKEN = /^[0-9a-fA-F]+$/

/**
 * An FCM registration token is not hex.
 *
 * It is a long opaque string -- `dGh…:APA91b…` -- containing `:` `-` `_` and
 * `.`, and it travels in a JSON body rather than a URL path. Bounded and
 * filtered anyway: nothing about a plausible token needs any other character,
 * and a body field is still a field somebody else chooses.
 */
const ANDROID_TOKEN = /^[A-Za-z0-9_:.\-]+$/

/** Longest accepted device id, in characters. Bounded like a token, and for the same reason. */
const MAX_DEVICE_ID_LENGTH = 200

/** Devices one room may register. Generous for a household, bounded for a script. */
const MAX_DEVICES_PER_ROOM = 16

/**
 * Narrow a registration body.
 *
 * The platform decides what a token has to look like and what else is required:
 * an iOS token is hex and must say which APNs it belongs to, while an Android
 * registration token is neither hex nor environment-specific. `platform` being
 * absent means iOS, because that is what every plugin sent before this field
 * existed -- a relay that insisted on it would stop notifying iPhones on the
 * day it was deployed, and the app that has to send the new field is the one
 * that is hardest to update.
 *
 * @param value - the decoded JSON body.
 * @returns the device, or `null` when it is unusable.
 */
export function readDevice(value: unknown): Omit<PushDevice, 'registeredAt'> | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const deviceId = record['deviceId']
  const token = record['token']
  if (typeof deviceId !== 'string' || deviceId === '' || deviceId.length > MAX_DEVICE_ID_LENGTH) {
    return null
  }
  if (typeof token !== 'string' || token === '') return null

  const platform: PushPlatform = record['platform'] === 'android' ? 'android' : 'ios'
  if (platform === 'android') {
    if (token.length > MAX_ANDROID_TOKEN_LENGTH || !ANDROID_TOKEN.test(token)) return null
    return {
      deviceId,
      token,
      platform,
      // iOS-only, and not defaulted here: a token has exactly one service, and
      // storing an environment an Android device does not have would make the
      // status endpoint say something untrue.
      environment: null,
      // Ignored on Android, where no Live Activity exists: an app that sends the
      // field anyway must not lose its alerts over it, so it is dropped rather
      // than validated or refused.
      liveActivityToken: null,
      locale: typeof record['locale'] === 'string' ? record['locale'].slice(0, 32) : 'en',
    }
  }

  if (token.length > MAX_IOS_TOKEN_LENGTH || !IOS_TOKEN.test(token)) return null
  const liveActivityToken = readLiveActivityToken(record['liveActivityToken'])
  if (liveActivityToken === undefined) return null
  return {
    deviceId,
    token,
    platform,
    // The safe direction for an unknown value: the production host refuses a
    // sandbox token loudly, while the sandbox host silently accepts nothing a
    // real device sent.
    environment: record['environment'] === 'sandbox' ? 'sandbox' : 'production',
    liveActivityToken,
    locale: typeof record['locale'] === 'string' ? record['locale'].slice(0, 32) : 'en',
  }
}

/**
 * Narrow the optional Live Activity token on an iOS registration.
 *
 * Absent or `null` means the phone currently has no activity running, which is
 * also how its app clears a token after it ended the activity itself -- so
 * absence is a value, not a missing field to preserve.
 *
 * The same rules as a device token apply because the token ends up in the same
 * place: `/3/device/<token>` on an APNs request. Apple issues these as hex, and
 * a slash in one would address a different endpoint rather than fail loudly.
 *
 * @param value - the field as it arrived.
 * @returns the token, `null` when absent, or `undefined` when it is present and
 *   unusable -- the one case the registration must be refused over.
 */
function readLiveActivityToken(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > MAX_IOS_TOKEN_LENGTH || !IOS_TOKEN.test(value)) {
    return undefined
  }
  return value
}

/**
 * Narrow a notification body.
 *
 * @param value - the decoded JSON body.
 * @returns the request, or `null` when it is unusable.
 */
export function readNotification(value: unknown): PushRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const title = record['title']
  const body = record['body']
  if (typeof title !== 'string' || title === '') return null
  if (typeof body !== 'string') return null
  const sessionId = record['sessionId']
  return {
    kind: typeof record['kind'] === 'string' ? record['kind'].slice(0, 32) : 'unknown',
    title: title.slice(0, 200),
    body: body.slice(0, 400),
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId.slice(0, 200) : null,
    threadId: typeof record['threadId'] === 'string' ? record['threadId'].slice(0, 200) : 'mizar',
    collapseId: typeof record['collapseId'] === 'string' ? record['collapseId'].slice(0, 64) : '',
    timeSensitive: record['timeSensitive'] === true,
    endLiveActivity: record['endLiveActivity'] === true,
    exceptDeviceIds: readExceptDeviceIds(record['exceptDeviceIds']),
  }
}

/**
 * Narrow the list of devices a notification must not go to.
 *
 * Anything that is not an array of strings is treated as absent rather than as
 * an error, because this is a suppression hint: a plugin that mangles it should
 * produce a notification somebody did not need, never a notification nobody
 * gets. Each id is capped at the length a real one can have and the list at the
 * number of devices a room may hold, so a hostile or simply broken body cannot
 * make the relay walk something proportional to its size -- the sixty-kilobyte
 * body cap alone still allows thousands of entries.
 *
 * @param value - the field as it arrived.
 * @returns the ids to skip, deduplicated, or an empty list.
 */
function readExceptDeviceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue
    ids.add(entry.slice(0, MAX_DEVICE_ID_LENGTH))
    if (ids.size >= MAX_DEVICES_PER_ROOM) break
  }
  return [...ids]
}

/** Every room's registered devices. */
export class PushRegistry {
  readonly #rooms = new Map<string, Map<string, PushDevice>>()

  /**
   * Record one device.
   * @param room - the room the credential derives.
   * @param device - the device and its token.
   * @returns whether it was stored, or `false` when the room is full.
   */
  register(room: string, device: Omit<PushDevice, 'registeredAt'>): boolean {
    let devices = this.#rooms.get(room)
    if (devices === undefined) {
      devices = new Map()
      this.#rooms.set(room, devices)
    }
    if (!devices.has(device.deviceId) && devices.size >= MAX_DEVICES_PER_ROOM) return false
    devices.set(device.deviceId, { ...device, registeredAt: Date.now() })
    return true
  }

  /**
   * Forget one device.
   * @param room - the room.
   * @param deviceId - the device.
   * @returns whether it was there.
   */
  unregister(room: string, deviceId: string): boolean {
    const devices = this.#rooms.get(room)
    if (devices === undefined) return false
    const removed = devices.delete(deviceId)
    if (devices.size === 0) this.#rooms.delete(room)
    return removed
  }

  /**
   * Forget every device holding one token.
   *
   * Used when a push service retires a token: leaving it registered means every
   * future notification pays a round trip to be told the same thing again.
   *
   * @param room - the room.
   * @param token - the retired token.
   * @returns how many records were dropped.
   */
  forgetToken(room: string, token: string): number {
    const devices = this.#rooms.get(room)
    if (devices === undefined) return 0
    let dropped = 0
    for (const [deviceId, device] of [...devices]) {
      if (device.token !== token) continue
      devices.delete(deviceId)
      dropped += 1
    }
    if (devices.size === 0) this.#rooms.delete(room)
    return dropped
  }

  /**
   * Forget one device's Live Activity token, and nothing else.
   *
   * Apple answers `Unregistered` for an activity token routinely -- every
   * activity that ends mints a token that is then retired -- so this is not a
   * dead phone and must never be treated as one. The device and its alert token
   * stay; only the token that cannot work again is dropped.
   *
   * The token is matched before it is cleared, because an end push can still be
   * in flight when the app registers the next activity's token. A late answer
   * about the old token must not clear the new one, or the first slow `410` would
   * make the relay forget an activity that is still running.
   *
   * @param room - the room.
   * @param deviceId - the device the end push was sent to.
   * @param token - the activity token Apple retired.
   * @returns whether it was still that device's current token.
   */
  clearLiveActivityToken(room: string, deviceId: string, token: string): boolean {
    const devices = this.#rooms.get(room)
    const device = devices?.get(deviceId)
    if (devices === undefined || device === undefined) return false
    if (device.liveActivityToken !== token) return false
    devices.set(deviceId, { ...device, liveActivityToken: null })
    return true
  }

  /** Whether a room has any devices registered. */
  has(room: string): boolean {
    return this.#rooms.has(room)
  }

  /**
   * Every device registered for a room.
   * @param room - the room.
   * @returns the devices.
   */
  devices(room: string): PushDevice[] {
    return [...(this.#rooms.get(room)?.values() ?? [])]
  }

  /** How many rooms have at least one device. */
  get roomCount(): number {
    return this.#rooms.size
  }

  /** Total registered devices, for the health endpoint. */
  get deviceCount(): number {
    let total = 0
    for (const devices of this.#rooms.values()) total += devices.size
    return total
  }
}

/**
 * Deliver one notification to every device in a room.
 *
 * The room's devices are sent to together rather than in sequence. Sequencing
 * looked free -- one `ClientHttp2Session` multiplexes the requests anyway -- but
 * a device Apple cannot reach costs a full request timeout, and a session Apple
 * closed without telling anybody, a wiped phone or a stalled network all produce
 * exactly that: the first such device pushed the plugin's own ten-second client
 * timeout past its limit while the rest were still being sent, so the computer logged
 * a failed notification for one that had in fact gone out. Sending together
 * bounds the wall clock at one request. The fan-out is bounded by
 * {@link MAX_DEVICES_PER_ROOM}, which is what makes `Promise.all` safe here, and
 * the per-device accounting is unchanged: each send reports its own outcome and
 * the tallies are summed.
 *
 * Two services share that fan-out. A room holds iPhones and Androids at once,
 * and a relay configured for only one of them must still deliver to the other:
 * a device whose platform has no client is counted as failed and reported once,
 * rather than being allowed to fail the whole notification -- an operator who
 * has not set up FCM yet would otherwise stop reaching their iPhone the moment
 * an Android phone was paired.
 *
 * A request that says the session ended adds a third, smaller fan-out beside
 * those two: one Live Activity end push per iPhone that has an activity token.
 * It is not filtered by `exceptDeviceIds` and it does not contribute to the
 * alert tallies -- see {@link deliverLiveActivityEnds}.
 *
 * @param options - the registry, the clients and the log.
 * @param room - the room to notify.
 * @param request - what to say.
 * @returns what happened.
 */
export async function deliver(
  options: {
    readonly registry: PushRegistry
    readonly apns: ApnsClient | null
    readonly fcm: FcmClient | null
    readonly log: (message: string) => void
  },
  room: string,
  request: PushRequest,
): Promise<PushOutcome> {
  const enabled = options.apns !== null || options.fcm !== null
  const devices = options.registry.devices(room)
  if (devices.length === 0) return { sent: 0, failed: 0, dropped: 0, enabled }

  const excluded = new Set(request.exceptDeviceIds)
  // Each task adds its own result the moment its send settles, and nothing
  // awaits between reading a counter and writing it -- so the tallies need no
  // more coordination than that, and they are the same three numbers the
  // sequential loop kept.
  const tally = { sent: 0, failed: 0, dropped: 0 }
  /** Devices left behind because their platform has no client. Reported once each. */
  const unrouted = new Map<PushPlatform, number>()

  /** Deliver the alert to every device the plugin did not exclude. */
  async function deliverAlerts(): Promise<void> {
    await Promise.all(
      devices
        .filter((device) => !excluded.has(device.deviceId))
        .map(async (device): Promise<void> => {
          // An approval or a question is blocking a turn, and the operator waking
          // up to it late is the same as not being told.
          const urgent =
            request.kind === 'approval' || request.kind === 'question' || request.timeSensitive

          let result: ApnsResult | FcmResult
          if (device.platform === 'android') {
            if (options.fcm === null) {
              unrouted.set('android', (unrouted.get('android') ?? 0) + 1)
              tally.failed += 1
              return
            }
            const notification: FcmNotification = {
              deviceToken: device.token,
              title: request.title,
              body: request.body,
              collapseId: request.collapseId,
              urgent,
              sessionId: request.sessionId,
              kind: request.kind,
            }
            result = await options.fcm.send(notification)
          } else {
            if (options.apns === null) {
              unrouted.set('ios', (unrouted.get('ios') ?? 0) + 1)
              tally.failed += 1
              return
            }
            const notification: ApnsNotification = {
              deviceToken: device.token,
              // Each device's own environment, because one room holds phones that
              // disagree about which Apple minted their token.
              environment: device.environment ?? 'production',
              title: request.title,
              body: request.body,
              threadId: request.threadId,
              collapseId: request.collapseId,
              urgent,
              sessionId: request.sessionId,
              kind: request.kind,
            }
            result = await options.apns.send(notification)
          }

          if (result.delivered) {
            tally.sent += 1
            return
          }
          if (result.unregistered) {
            tally.dropped += options.registry.forgetToken(room, device.token)
            options.log(
              `push: retired ${device.platform} token for ${device.deviceId} in room ${room} (${result.status} ${result.reason ?? ''})`.trim(),
            )
            return
          }
          tally.failed += 1
          options.log(
            `push: ${device.deviceId} in room ${room} refused (${result.status} ${result.reason ?? 'no reason'})`,
          )
        }),
    )
  }

  /**
   * End the Live Activity on every iPhone that has one.
   *
   * Deliberately **not** filtered by `exceptDeviceIds`. That list means "the
   * app is on screen, so an alert would be noise" -- and the phone in the
   * operator's hand is exactly where a countdown that keeps running is most
   * visible, so an end event there is the least optional of all. Android is not
   * in this fan-out: it has no Live Activity, and its registration drops the
   * field.
   *
   * A failure here is logged and otherwise forgotten. The tallies describe the
   * alert, and an activity token Apple has retired is not a reason for the computer's
   * notification to be reported as failed after the alert went out.
   */
  async function deliverLiveActivityEnds(): Promise<void> {
    const apnsClient = options.apns
    if (!request.endLiveActivity || apnsClient === null) return
    await Promise.all(
      devices.map(async (device): Promise<void> => {
        const token = device.liveActivityToken
        if (device.platform !== 'ios' || typeof token !== 'string' || token === '') return
        const result = await apnsClient.sendLiveActivityEnd({
          token,
          environment: device.environment ?? 'production',
        })
        if (result.delivered) {
          options.log(`push: ended live activity for ${device.deviceId} in room ${room}`)
          return
        }
        if (result.unregistered) {
          // Only that activity token: the alert token is a different token, and
          // Apple retiring an activity is not a dead phone. Matching on the token
          // as well keeps a late answer about an old activity from clearing the
          // next one's.
          options.registry.clearLiveActivityToken(room, device.deviceId, token)
          options.log(
            `push: retired live-activity token for ${device.deviceId} in room ${room} (${result.status} ${result.reason ?? ''})`.trim(),
          )
          return
        }
        options.log(
          `push: live-activity end for ${device.deviceId} in room ${room} failed (${result.status} ${result.reason ?? 'no reason'})`,
        )
      }),
    )
  }

  // Both fan-outs run together. An activity token Apple cannot reach costs one
  // request timeout, exactly like a device token can, and sequencing the ends
  // after the alerts would hand the plugin a slow request for work that was
  // already done -- the timeout the parallel fan-out exists to avoid.
  await Promise.all([deliverAlerts(), deliverLiveActivityEnds()])

  // Once per platform per notification, not once per device: a relay that has
  // no FCM credentials and sixteen Android phones must produce one line an
  // operator can act on, not sixteen.
  for (const [platform, count] of unrouted) {
    options.log(
      `push: ${count} ${platform} device(s) in room ${room} and no ${platform === 'android' ? 'FCM service account' : 'APNs key'} configured — nothing was sent to them`,
    )
  }

  return { ...tally, enabled }
}
