/**
 * Talking to Apple.
 *
 * APNs is HTTP/2 with a JSON body and a JWT for a password, which is little
 * enough that it needs no dependency: `node:http2` and `node:crypto` are both
 * built in, and the one thing that is easy to get wrong is the signature.
 *
 * **ES256 is not "sign these bytes".** JWS wants the raw 64-byte `R || S` pair,
 * and Node's default for an ECDSA key is the DER `SEQUENCE` those two numbers
 * are wrapped in. Signing without `dsaEncoding: 'ieee-p1363'` produces a token
 * that looks entirely correct and that Apple rejects with `InvalidProviderToken`
 * -- which says nothing about the encoding. That one option is the difference
 * between this file working and this file being a mystery.
 *
 * The other thing worth knowing: a device token is not a durable fact. Apple
 * answers `410 Unregistered` for one that has been retired, and a sender that
 * ignores that keeps pushing into a hole for the life of the deployment.
 *
 * **A token also belongs to one of two Apples.** The sandbox and production
 * hosts do not accept each other's tokens, and nothing in the token says which
 * one minted it, so the environment travels with each notification and decides
 * the host per send. A relay that picked one host for the whole deployment
 * answered `BadDeviceToken` for every phone built the other way -- which is
 * indistinguishable from a dead token, so the registration was deleted and the
 * phone went quiet with the computer still reporting it registered.
 *
 * **A Live Activity has a third kind of token.** iOS mints one per activity,
 * separate from the phone's alert token and retired when the activity ends, and
 * ending the activity is a push to that token under a different topic and push
 * type. It is the only push this file sends that is not an alert; see
 * {@link ApnsClient.sendLiveActivityEnd}.
 *
 * @module dsh-mizar-relay/apns
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

/** Which APNs a token belongs to. The two do not accept each other's tokens. */
export type ApnsEnvironment = 'sandbox' | 'production'

/** What APNs needs to know about this deployment. */
export interface ApnsConfig {
  /** The `.p8` signing key, PEM, exactly as Apple issued it. */
  readonly key: string
  /** The key's ten-character id, from the Apple developer portal. */
  readonly keyId: string
  /** The ten-character team id. */
  readonly teamId: string
  /** The app's bundle id, which is also the APNs topic. */
  readonly topic: string
  /**
   * The environment this deployment mostly serves.
   *
   * No longer selects the host. It used to, and that was the defect: a Debug
   * phone whose token belongs to the sandbox answered `BadDeviceToken` for every
   * push against a relay configured for production, and the relay read that
   * answer -- correctly, once the environment is honoured -- as a dead token and
   * deleted the registration. Each device's own environment now picks the host,
   * and this field is kept because the config file and `MIZAR_APNS_ENV` still
   * carry it and a schema change would break deployments for no gain.
   */
  readonly production: boolean
  /**
   * Override the APNs origin.
   *
   * Exists so a test can point this at a local HTTP/2 server and exercise the
   * real signing and framing. Unset in every deployment. It applies to both
   * environments, so a test sees one host rather than two -- the per-environment
   * hosts are asserted against {@link apnsOrigin} instead.
   */
  readonly authority?: string
  /**
   * Ask iOS to break through Focus for urgent notifications.
   *
   * Off by default because it is not free: the level is only honoured when the
   * app carries the time-sensitive-notifications entitlement, and an app that
   * asks for a capability it was not provisioned for is not something a relay
   * should decide on an operator's behalf.
   */
  readonly timeSensitive?: boolean
}

/** One notification to deliver. */
export interface ApnsNotification {
  readonly deviceToken: string
  /**
   * Which APNs the token was issued for.
   *
   * Per notification rather than per deployment because one room holds phones
   * that disagree: a Debug build on the desk talks to the sandbox while the
   * TestFlight build in a pocket talks to production, and both are paired to the
   * same computer.
   */
  readonly environment: ApnsEnvironment
  readonly title: string
  readonly body: string
  /** What the phone groups notifications under. */
  readonly threadId: string
  /** Replaces an earlier notification with the same id. */
  readonly collapseId: string
  /** Higher priority requests are delivered immediately rather than batched. */
  readonly urgent: boolean
  /** The session a tap should open, echoed in the payload. */
  readonly sessionId: string | null
  /** What the notification is about, echoed in the payload. */
  readonly kind: string
}

/** What Apple said. */
export interface ApnsResult {
  readonly delivered: boolean
  /**
   * Whether Apple says this token is dead and should be forgotten.
   *
   * `BadDeviceToken` is included: the environment a token belongs to travels
   * with the notification and picks the host, so this answer means the token is
   * dead or is for another topic -- and retrying it forever is a way to turn a
   * dead registration into a permanent stream of failed requests.
   */
  readonly unregistered: boolean
  readonly status: number
  readonly reason: string | null
}

/** One Live Activity end push, addressed by the activity's own push token. */
export interface ApnsLiveActivityEnd {
  /**
   * The *activity* push token, not the phone's alert token.
   *
   * iOS issues one per Live Activity when it starts and the relay cannot derive
   * it: it is a different token from the device token, sometimes on a different
   * Apple, and it dies with the activity. It therefore travels with the
   * notification the same way the device token does.
   */
  readonly token: string
  /** Which APNs minted the activity token. */
  readonly environment: ApnsEnvironment
}

/**
 * One row of a Live Activity, as the plugin described it.
 *
 * The plugin's own vocabulary rather than the widget's: it knows a session and
 * when the work began, and the wire shape -- ids, elapsed times, the Swift
 * reference epoch -- is this file's business.
 */
export interface ApnsActivityRow {
  /** The session this row is about. */
  readonly sessionId: string
  /** What the row says. Empty when the host has no name for the session. */
  readonly title: string
  /** When the work this row counts began, in epoch milliseconds. */
  readonly runningSince: number
}

/** A Live Activity to start on a phone that has none. */
export interface ApnsLiveActivityStart {
  /**
   * The *push-to-start* token, which is not the activity token and does not
   * belong to any activity: iOS issues it per install so a card can be asked
   * for before one exists.
   */
  readonly token: string
  /** Which APNs minted that token. */
  readonly environment: ApnsEnvironment
  /** The rows to draw, oldest first. */
  readonly rows: readonly ApnsActivityRow[]
  /** The banner that accompanies the start. */
  readonly alert: { readonly title: string; readonly body: string }
}

/** A Live Activity that is up and has something new to say. */
export interface ApnsLiveActivityUpdate {
  /** The *activity* token of the card that is up. */
  readonly token: string
  readonly environment: ApnsEnvironment
  readonly rows: readonly ApnsActivityRow[]
}

/** How long a signed JWT is reused before it is minted again. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000

/** How long one APNs request may take. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The reasons Apple gives when the provider token it received is not acceptable.
 *
 * `ExpiredProviderToken` is the token having aged out; `InvalidProviderToken`
 * covers everything else about it, including a signature Apple will not accept.
 * The signature itself is pinned by a test, so by the time one of these arrives
 * the cached token -- not the code that minted it -- is what is worth doubting.
 */
const STALE_TOKEN_REASONS: ReadonlySet<string> = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken',
])

/** The origin each environment lives at, in the form `connect` takes. */
const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

/**
 * The APNs host for one environment.
 *
 * Exported because the host choice is otherwise invisible to a test: every test
 * points the client at a local fake through {@link ApnsConfig.authority}, which
 * applies to both environments and collapses the two hosts into one.
 *
 * @param config - the deployment's APNs facts, for the override.
 * @param environment - which APNs the token belongs to.
 * @returns the origin to connect to.
 */
export function apnsOrigin(config: ApnsConfig, environment: ApnsEnvironment): string {
  return config.authority ?? APNS_HOSTS[environment]
}

/** APNs rejects a payload larger than this. */
export const MAX_PAYLOAD_BYTES = 4096

/**
 * Build the JWS signing input for one APNs token.
 *
 * @param keyId - the key id, which goes in the header.
 * @param teamId - the team id, which is the issuer.
 * @param now - the issue time, in epoch milliseconds.
 * @returns the base64url `header.claims` prefix, and the raw bytes to sign.
 */
export function signingInput(keyId: string, teamId: string, now: number): {
  readonly input: string
  readonly claims: { readonly iss: string; readonly iat: number }
} {
  const claims = { iss: teamId, iat: Math.floor(now / 1000) }
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return { input: `${header}.${payload}`, claims }
}

/**
 * Sign an APNs provider token.
 *
 * @param key - the parsed `.p8` key.
 * @param keyId - the key id.
 * @param teamId - the team id.
 * @param now - the issue time, in epoch milliseconds.
 * @returns the compact JWS.
 */
export function providerToken(key: KeyObject, keyId: string, teamId: string, now: number): string {
  const { input } = signingInput(keyId, teamId, now)
  const signature = sign('sha256', Buffer.from(input), {
    key,
    // See the module comment: without this the signature is DER and Apple
    // answers `InvalidProviderToken`.
    dsaEncoding: 'ieee-p1363',
  })
  return `${input}.${signature.toString('base64url')}`
}

/** Narrow a raw notification before it is sent. */
export function buildPayload(
  notification: ApnsNotification,
  timeSensitive: boolean,
): Record<string, unknown> {
  return {
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      'thread-id': notification.threadId,
      ...(timeSensitive ? { 'interruption-level': 'time-sensitive' } : {}),
    },
    // Carried outside `aps` so the app can open the right conversation from a
    // tap without asking the relay anything.
    sessionId: notification.sessionId,
    kind: notification.kind,
  }
}

/**
 * The final state an ended activity shows while it is being dismissed.
 *
 * `content-state` is not optional on an end event. Apple's payload contract says
 * the system needs it "to ensure the system can decode the JSON payload and
 * update or end the Live Activity": a real device accepted the end push without
 * one (APNs answered 200) and went on counting, which is the failure that was
 * measured on 2026-10-18 and the reason this constant exists.
 *
 * The shape is the app's `DSHMizarActivityAttributes.ContentState`, which is the
 * `LiveActivityPhase` enum: Swift's synthesised `Codable` writes `.finished` as
 * `{"finished":{}}` (pinned by the app's `LiveActivityPushToken`/`LiveActivity`
 * test suites, and by the `builds the Live Activity end payload` test here).
 * There are no dates in it, so no encoding strategy can disagree about it.
 */
const FINISHED_CONTENT_STATE = { rows: [] as const } as const

/**
 * Build the payload that ends one Live Activity.
 *
 * Apple's `end` event dismisses the activity from the Lock Screen and the
 * Dynamic Island, and `dismissal-date` is when it may disappear for good. Both
 * stamps are Unix **seconds**: that is what the Live Activity push contract
 * defines, and milliseconds would put the date tens of thousands of years out
 * while the event itself silently did nothing -- leaving the activity counting,
 * which is the bug this exists to fix.
 *
 * The content state is `{"rows":[]}`, and that is a shape rather than a
 * decoration: it used to be `{"finished":{}}`, mirroring an enum the app no
 * longer uses. Measured 2026-10-26: three end pushes were delivered to the same
 * card over twelve minutes (APNs answered 200 each time, so every required key
 * was present and well formed), the card kept counting, and the token was never
 * retired -- a state the phone cannot decode is accepted and dropped.
 *
 * The dismissal date is one second after the timestamp rather than equal to it:
 * a state on the card has to render for the system to end it, and a date in the
 * future is unambiguous where an equal one is an edge nothing documents. One
 * second is also short enough that the card is gone before anybody looks twice.
 *
 * @param now - the current time, in epoch milliseconds.
 * @returns the payload object, ready to serialize.
 */
export function buildLiveActivityEndPayload(now: number): Record<string, unknown> {
  const timestamp = Math.floor(now / 1000)
  return {
    aps: {
      timestamp,
      event: 'end',
      'dismissal-date': timestamp + 1,
      'content-state': FINISHED_CONTENT_STATE,
    },
  }
}

/**
 * The instant Swift's `Date` counts from, in Unix seconds.
 *
 * `JSONEncoder`'s default for a `Date` is seconds since 2001-01-01, and the
 * system decodes a Live Activity's `content-state` with that default. A payload
 * that sent Unix seconds instead would put every clock 31 years into the future,
 * which the widget would draw as a count-up from a date that has not happened.
 */
const SWIFT_REFERENCE_EPOCH = 978_307_200

/**
 * Encode rows as the app's `LiveActivityState` reads them.
 *
 * `rows` is a property of that type, which is what Apple's contract for a Live
 * Activity `content-state` asks for: the keys are the state's properties. This
 * used to nest them under a case name (`{"running":{"rows":[…]}}`), which the
 * device accepted and then could not place -- see ``buildLiveActivityEndPayload``
 * for the measurement. `elapsed` is filled in as well as `countingSince` even
 * though the widget ticks from the latter: it is a required field of the row
 * type, and a payload missing it is a card that fails to decode and draws
 * nothing.
 *
 * @param rows - the rows, oldest first.
 * @param now - the current time, in epoch milliseconds.
 * @returns the decoded shape of the app's content state.
 */
export function buildLiveActivityContentState(
  rows: readonly ApnsActivityRow[],
  now: number,
): Record<string, unknown> {
  return {
    rows: rows.map((row) => ({
      id: row.sessionId,
      // The title is what the card says; the instruction is deliberately not
      // carried, because it lives in the conversation log and a second copy of
      // it on a push payload is a copy Apple and the operator's network see.
      prompt: '',
      title: row.title,
      elapsed: Math.max(0, (now - row.runningSince) / 1000),
      countingSince: row.runningSince / 1000 - SWIFT_REFERENCE_EPOCH,
    })),
  }
}

/**
 * Build the payload that starts one Live Activity.
 *
 * `event: "start"` is what makes the system create the activity rather than look
 * for one, so the payload carries the whole of what the widget draws: this is
 * the one push this app sends with no code of the app running to fill anything
 * in afterwards. `attributes-type` has to name the app's attributes type
 * exactly, and `attributes` is `{}` because that type has no properties.
 *
 * The name is the unqualified Swift type, which is how
 * `ActivityConfiguration(for:)` names it in the widget. The type lives in the
 * `MizarKit` module, so if a device ever answers `BadAttributesType` the thing to
 * try is `MizarKit.DSHMizarActivityAttributes` -- one string, in this function,
 * and nothing else in the payload changes.
 *
 * @param start - the token, its Apple, the rows and the banner.
 * @param now - the current time, in epoch milliseconds.
 * @returns the payload object, ready to serialize.
 */
export function buildLiveActivityStartPayload(
  start: ApnsLiveActivityStart,
  now: number,
): Record<string, unknown> {
  return {
    aps: {
      timestamp: Math.floor(now / 1000),
      event: 'start',
      'attributes-type': 'DSHMizarActivityAttributes',
      attributes: {},
      'content-state': buildLiveActivityContentState(start.rows, now),
      alert: { title: start.alert.title, body: start.alert.body },
    },
  }
}

/**
 * Build the payload that brings an existing activity up to date.
 *
 * No `attributes-type` and no `alert`: the activity is up, and an update is a
 * change of the card rather than a new thing to announce.
 *
 * @param update - the activity token, its Apple and the rows.
 * @param now - the current time, in epoch milliseconds.
 * @returns the payload object, ready to serialize.
 */
export function buildLiveActivityUpdatePayload(
  update: ApnsLiveActivityUpdate,
  now: number,
): Record<string, unknown> {
  return {
    aps: {
      timestamp: Math.floor(now / 1000),
      event: 'update',
      'content-state': buildLiveActivityContentState(update.rows, now),
    },
  }
}

/**
 * An APNs client.
 *
 * One HTTP/2 session per environment, reused. A connection per notification
 * would make every push pay a TLS handshake to another continent, which for a
 * notification is most of the latency a person notices -- and one session shared
 * between the two environments is not possible, because they are different
 * hosts.
 */
export class ApnsClient {
  readonly #config: ApnsConfig
  readonly #log: (message: string) => void
  readonly #key: KeyObject
  #token: { value: string; mintedAt: number } | null = null
  /** One open session per environment. */
  readonly #sessions = new Map<ApnsEnvironment, ClientHttp2Session>()

  /**
   * @param config - the deployment's APNs facts.
   * @param log - where to report.
   */
  constructor(config: ApnsConfig, log: (message: string) => void) {
    this.#config = config
    this.#log = log
    this.#key = createPrivateKey(config.key)
  }

  /**
   * The current provider token, minted if it is missing or stale.
   *
   * @param freshToken - whether to ignore the cached token and mint a new one.
   * @returns the compact JWS.
   */
  #currentToken(freshToken = false): string {
    const now = Date.now()
    if (!freshToken && this.#token !== null && now - this.#token.mintedAt < TOKEN_LIFETIME_MS) {
      return this.#token.value
    }
    const value = providerToken(this.#key, this.#config.keyId, this.#config.teamId, now)
    this.#token = { value, mintedAt: now }
    return value
  }

  /**
   * Open the session for one environment, or reuse the open one.
   *
   * @param environment - which APNs host to talk to.
   * @returns the session.
   */
  #connect(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.#sessions.get(environment)
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing
    const session = connect(apnsOrigin(this.#config, environment))
    // The handlers capture the session they belong to and clear the slot only
    // while it is still the one in use. A late event from a session that has
    // already been replaced used to null the field unconditionally, which
    // orphaned the healthy replacement: the next send opened a third connection
    // and nothing held a reference to close the second.
    const discard = (): void => {
      if (this.#sessions.get(environment) === session) this.#sessions.delete(environment)
    }
    session.on('error', (error) => {
      this.#log(`apns: session error: ${error.message}`)
      discard()
    })
    session.on('close', discard)
    // Apple closes an idle session eventually; letting the process exit while a
    // notification is in flight is worse than keeping one socket open.
    session.unref()
    this.#sessions.set(environment, session)
    return session
  }

  /**
   * Deliver one notification.
   *
   * Never throws. A push is an announcement about state that is already durable,
   * so a failure here must not be able to fail whatever caused it.
   *
   * @param notification - what to send.
   * @returns what Apple said.
   */
  async send(notification: ApnsNotification): Promise<ApnsResult> {
    const payload = JSON.stringify(
      buildPayload(notification, this.#config.timeSensitive === true),
    )
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      // Apple answers `PayloadTooLarge`. Saying so here saves a round trip and
      // names the real problem.
      return { delivered: false, unregistered: false, status: 413, reason: 'PayloadTooLarge' }
    }

    return await this.#deliver(notification, payload, (freshToken) =>
      this.#alertHeaders(notification, payload, freshToken),
    )
  }

  /**
   * End one Live Activity.
   *
   * A sibling of {@link send} rather than a flag on it, because nearly every
   * header differs: the topic carries the `.push-type.liveactivity` suffix, the
   * push type is `liveactivity`, and priority and expiration are fixed by the
   * activity contract. Folding that into the alert path would mean conditionals
   * around the one place where a wrong header fails silently.
   *
   * Never throws, for the same reason {@link send} does not: ending the activity
   * announces state that is already durable, and a failed announcement must not
   * fail the alert fan-out happening beside it.
   *
   * @param end - the activity token and the Apple it belongs to.
   * @returns what Apple said; `unregistered` means this activity token is dead,
   *   and says nothing about the device's alert token.
   */
  async sendLiveActivityEnd(end: ApnsLiveActivityEnd): Promise<ApnsResult> {
    // Built once per call, so both timestamps in one payload agree even if the
    // clock ticks between them.
    const payload = JSON.stringify(buildLiveActivityEndPayload(Date.now()))
    return await this.#deliver(
      { deviceToken: end.token, environment: end.environment },
      payload,
      (freshToken) => this.#liveActivityHeaders(end.token, payload, freshToken),
    )
  }

  /**
   * Start one Live Activity on a phone that has none.
   *
   * Addressed to the push-to-start token, which is the one credit this design
   * spends to make a card appear with no app running. A failure is a session
   * that reaches the island next time the app is opened, which is the old
   * behaviour rather than a broken state -- so it is reported, not retried.
   *
   * @param start - the token, its Apple, the rows and the banner.
   * @returns what Apple said.
   */
  async sendLiveActivityStart(start: ApnsLiveActivityStart): Promise<ApnsResult> {
    const payload = JSON.stringify(buildLiveActivityStartPayload(start, Date.now()))
    return await this.#deliver(
      { deviceToken: start.token, environment: start.environment },
      payload,
      (freshToken) => this.#liveActivityHeaders(start.token, payload, freshToken),
    )
  }

  /**
   * Bring one Live Activity that is already up up to date.
   *
   * Addressed to the activity's own token, which travels with the update because
   * only the app ever sees it.
   *
   * @param update - the activity token, its Apple and the rows.
   * @returns what Apple said.
   */
  async sendLiveActivityUpdate(update: ApnsLiveActivityUpdate): Promise<ApnsResult> {
    const payload = JSON.stringify(buildLiveActivityUpdatePayload(update, Date.now()))
    return await this.#deliver(
      { deviceToken: update.token, environment: update.environment },
      payload,
      (freshToken) => this.#liveActivityHeaders(update.token, payload, freshToken),
    )
  }

  /**
   * The framing and headers every Live Activity push shares.
   *
   * One function rather than three copies because the parts that differ are the
   * payload and the token, and the parts that must not differ are exactly the
   * ones that fail silently: the topic suffix, the push type and the priority.
   *
   * @param token - the activity or push-to-start token.
   * @param payload - the already-encoded body.
   * @param freshToken - whether to mint a new provider token for this attempt.
   * @returns the HTTP/2 headers.
   */
  #liveActivityHeaders(
    token: string,
    payload: string,
    freshToken: boolean,
  ): Record<string, string | number> {
    return {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
      [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${this.#currentToken(freshToken)}`,
      // An activity push is addressed to the app's Live Activity topic: the
      // bundle id plus this suffix. Sent to the plain app topic, Apple answers
      // `DeviceTokenNotForTopic` -- not a retired token, so a relay that read
      // that as one would be wrong, and one that retried it would retry forever.
      'apns-topic': `${this.#config.topic}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      // Apple accepts an activity push at priority 10 only. A deferred one would
      // arrive after the phone had stopped showing the activity.
      'apns-priority': 10,
      // Every event describes work that is happening now: an end kept for later
      // counts down something that already stopped, a start kept for later
      // announces a session that is finished, an update kept for later is a card
      // that is wrong in both directions.
      'apns-expiration': 0,
      'content-type': 'application/json',
      [constants.HTTP2_HEADER_CONTENT_LENGTH]: Buffer.byteLength(payload),
    }
  }

  /**
   * The framing and headers for one alert.
   *
   * @param notification - what to send.
   * @param payload - the already-encoded body.
   * @param freshToken - whether to mint a new provider token for this attempt.
   * @returns the HTTP/2 headers.
   */
  #alertHeaders(
    notification: ApnsNotification,
    payload: string,
    freshToken: boolean,
  ): Record<string, string | number> {
    return {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${notification.deviceToken}`,
      [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${this.#currentToken(freshToken)}`,
      'apns-topic': this.#config.topic,
      'apns-push-type': 'alert',
      // 10 delivers immediately; 5 lets the device defer it to save power. A
      // permission prompt that arrives when the phone next wakes up is a
      // notification about something that already timed out.
      'apns-priority': notification.urgent ? 10 : 5,
      'apns-expiration': notification.urgent ? 0 : Math.floor(Date.now() / 1000) + 3600,
      ...(notification.collapseId === '' ? {} : { 'apns-collapse-id': notification.collapseId }),
      'content-type': 'application/json',
      [constants.HTTP2_HEADER_CONTENT_LENGTH]: Buffer.byteLength(payload),
    }
  }

  /**
   * Send one request, retrying it once when Apple refuses the provider token.
   *
   * Shared by alerts and Live Activity ends: the retry rule is about the
   * deployment's signing key, not about what is being delivered.
   *
   * @param target - the token and the Apple it belongs to.
   * @param payload - the already-encoded body.
   * @param headers - builds the headers for one attempt, given whether to mint
   *   a fresh provider token.
   * @returns what Apple said.
   */
  async #deliver(
    target: { readonly deviceToken: string; readonly environment: ApnsEnvironment },
    payload: string,
    headers: (freshToken: boolean) => Record<string, string | number>,
  ): Promise<ApnsResult> {
    const first = await this.#attempt(target, payload, headers(false))
    if (first.reason === null || !STALE_TOKEN_REASONS.has(first.reason)) return first

    // A rejected provider token is the one APNs answer worth a second attempt.
    // A token is cached for fifty minutes, and the clock that decides when it is
    // stale is the same clock that minted it -- so a clock that moved under a
    // running relay can leave this process holding a token Apple has stopped
    // accepting while the cache still believes it is good, for as long as the
    // skew lasts. Once, and then Apple's own answer is reported: a loop here
    // would turn a genuinely bad key into a request storm against a rate-limited
    // endpoint, and asking again with the same reason cannot produce a different
    // answer.
    return await this.#attempt(target, payload, headers(true))
  }

  /**
   * Make one request.
   *
   * @param target - the token and the Apple it belongs to.
   * @param payload - the already-encoded body.
   * @param headers - the headers for this attempt.
   * @returns what Apple said.
   */
  async #attempt(
    target: { readonly deviceToken: string; readonly environment: ApnsEnvironment },
    payload: string,
    headers: Record<string, string | number>,
  ): Promise<ApnsResult> {
    return await new Promise<ApnsResult>((resolve) => {
      let settled = false
      const finish = (result: ApnsResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      let request
      try {
        request = this.#connect(target.environment).request(headers)
      } catch (error) {
        this.#log(`apns: could not open a request: ${describe(error)}`)
        finish({ delivered: false, unregistered: false, status: 0, reason: 'TransportError' })
        return
      }

      let status = 0
      let body = ''
      request.setEncoding('utf8')
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 0)
      })
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('error', (error) => {
        this.#log(`apns: request failed: ${describe(error)}`)
        finish({ delivered: false, unregistered: false, status, reason: 'TransportError' })
      })
      request.on('end', () => {
        const reason = readReason(body)
        if (status === 200) {
          finish({ delivered: true, unregistered: false, status, reason: null })
          return
        }
        finish({
          delivered: false,
          unregistered: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered',
          status,
          reason,
        })
      })
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.close(constants.NGHTTP2_CANCEL)
        finish({ delivered: false, unregistered: false, status: 0, reason: 'Timeout' })
      })
      request.end(payload)
    })
  }

  /** Close every session, for shutdown. */
  close(): void {
    for (const session of this.#sessions.values()) session.close()
    this.#sessions.clear()
  }
}

/** Read APNs's `{"reason": "..."}` body, tolerating anything else. */
function readReason(body: string): string | null {
  if (body === '') return null
  try {
    const parsed = JSON.parse(body) as { reason?: unknown }
    return typeof parsed.reason === 'string' ? parsed.reason : null
  } catch {
    return body.slice(0, 200)
  }
}

/** One line for a thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
