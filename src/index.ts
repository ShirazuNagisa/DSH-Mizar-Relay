/**
 * The relay.
 *
 * A computer opens one outbound WebSocket to `/tunnel` and is thereafter reachable at
 * `/r/<room>/...` by anything that can reach this server. Requests are replayed
 * over that socket; a phone WebSocket is bridged through it. Nothing about the
 * Mizar protocol is interpreted here -- the relay moves bytes and does not know
 * what a session is. That is what keeps the trust boundary where it belongs: the
 * plugin authenticates the phone exactly as it would on a LAN.
 *
 * Two behaviours are worth reading the code for:
 *
 *   - **The upgrade is deferred.** A phone WebSocket is not accepted until the
 *     computer has accepted it, so an unreachable computer produces an HTTP error rather
 *     than a socket that opens and immediately dies. The two look identical in a
 *     client's logs and only one of them is diagnosable.
 *   - **A room with no tunnel is a 404, and the same 404 as a room that never
 *     existed.** Telling the difference would let anybody enumerate which computers
 *     are online.
 *
 * @module dsh-mizar-relay/index
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { startStunServer } from './stun.js'
import { UdpGuard } from './udp-guard.js'
import { WebSocketServer, type WebSocket } from 'ws'
import { ApnsClient } from './apns.js'
import { AccountApi } from './accounts/api.js'
import { AdminApi } from './accounts/admin.js'
import { Enforcement } from './accounts/enforcement.js'
import { PaidGate, isGateExempt, type GateDecision } from './accounts/gate.js'
import { identityFor, isPrivateHeader } from './accounts/identity.js'
import { parseHash } from './accounts/passwords.js'
import { DataQuota, type QuotaDecision } from './accounts/quota.js'
import { AccountStore } from './accounts/store.js'
import { TrafficLedger, isValidDay, isValidIdentity } from './accounts/traffic.js'
import { VerificationCodes } from './accounts/verification.js'
import { addressGroup, clientAddress } from './client-address.js'
import {
  gateStartupChecks,
  loadConfig,
  resolveAbuse,
  type AbuseLimits,
  type RelayConfig,
} from './config.js'
import { FcmClient } from './fcm.js'
import { parseJsonObject, readBody, writeJson } from './http.js'
import { handleMailRequest, MAIL_PATH } from './mail/api.js'
import { MailClient } from './mail/client.js'
import { MailService } from './mail/service.js'
import { SmtpMailTransport } from './mail/smtp.js'
import { TencentMailTransport } from './mail/tencent.js'
import { deliver, PushRegistry, readDevice, readNotification } from './push.js'
import { deriveRoom, secretsEqual } from './room.js'
import { RoomRegistry, Tunnel, saneCloseCode, type TunnelStream } from './tunnel.js'
import {
  ROOM_PREFIX,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  splitRoomPath,
} from './protocol.js'

/** The relay's own version, for the admin settings page. */
const RELAY_VERSION = '0.3.2'

/** Path prefix of the push API. */
const PUSH_PREFIX = '/push/v1/'

/** Largest push request body. A notification is a few hundred bytes. */
const MAX_PUSH_BODY_BYTES = 64 * 1024

/** Headers that describe this hop rather than the request. */
const HOP_BY_HOP = new Set([
  'connection',
  'upgrade',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
])

/** Largest `Authorization: Bearer` prefix, so a huge header cannot be used to stall. */
const BEARER_PREFIX = 'bearer '

/** A running relay. */
export interface Relay {
  /** The port it actually bound, which differs from the config when 0 was asked for. */
  readonly port: number
  /** Stop listening and close every tunnel. */
  close(): Promise<void>
}

/** Injectable dependencies, used by tests to keep clocks and networks still. */
export interface RelayDependencies {
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
  readonly passwordParams?: import('./accounts/passwords.js').ScryptParams
  readonly appstoreRoots?: readonly string[]
}

/** The headers worth carrying to the computer: everything that describes the request. */
function forwardableHeaders(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    if (isPrivateHeader(name)) continue
    if (typeof value === 'string') out[name] = value
    else if (Array.isArray(value)) out[name] = value.join(', ')
  }
  return out
}

/** Extract the bearer token from an upgrade request. */
function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  if (header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length).trim()
  }
  return null
}

/**
 * Build the APNs client, or say why push is off.
 *
 * @param config - the `apns` block, which is present but may be unusable.
 * @param log - where to report.
 * @returns the client, or `null` when its key could not be read.
 */
function createApnsOrWarn(
  config: NonNullable<RelayConfig['apns']>,
  log: (message: string) => void,
): ApnsClient | null {
  try {
    return new ApnsClient(config, log)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(
      `relay: push is off — the configured Apple key could not be read (${message}). ` +
        'Replace apns.key in relay.config.json with the .p8 Apple gave you, or remove the apns block.',
    )
    return null
  }
}

/**
 * Build the FCM client, or say why push to Android is off.
 *
 * Same rule as APNs: a malformed service account costs push, not the tunnel.
 *
 * @param config - the `fcm` block, which is present but may be unusable.
 * @param log - where to report.
 * @returns the client, or `null` when its key could not be read.
 */
function createFcmOrWarn(
  config: NonNullable<RelayConfig['fcm']>,
  log: (message: string) => void,
): FcmClient | null {
  try {
    return new FcmClient(config, log)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(
      `relay: push to Android is off — the configured FCM service account could not be read (${message}). ` +
        'Replace fcm.serviceAccount / fcm.serviceAccountFile in relay.config.json with the JSON Firebase gave you, or remove the fcm block.',
    )
    return null
  }
}

/**
 * How often each bridged phone socket is pinged, in ms — and, twice over, how
 * long it may stay silent before the relay drops it.
 *
 * The tunnels have an application-level ping and the phones used to have
 * nothing, and the gap showed in the field: a phone that is only waiting for
 * the computer's answer sends nothing, so a proxy that closes idle connections
 * — nginx's sixty-second read-timeout default — kills the leg mid-request, and
 * the phone spends its own request timeout reconnecting for an answer that was
 * never coming down the old socket. Thirty seconds feeds every standard proxy
 * comfortably.
 *
 * The ping is protocol-level rather than a frame: every WebSocket peer answers
 * it below the application (iOS's `URLSessionWebSocketTask` and Android's
 * OkHttp both do), so it costs the phone nothing and says nothing to the Mizar
 * protocol this relay declines to interpret.
 */
function phoneKeepaliveMs(): number {
  return Math.max(
    1_000,
    Number(process.env['MIZAR_RELAY_PHONE_KEEPALIVE']) || 30_000,
  )
}

/**
 * Start the relay.
 *
 * @param config - the resolved configuration.
 * @param log - where to report.
 * @returns the running relay.
 */
export async function startRelay(
  config: RelayConfig,
  log: (message: string) => void = console.log,
  deps: RelayDependencies = {},
): Promise<Relay> {
  const rooms = new RoomRegistry()
  /** Live tunnels per source address. Not a security boundary, a resource one. */
  const tunnelsPerIp = new Map<string, number>()
  const wss = new WebSocketServer({ noServer: true })
  /** The data-plane abuse limits, resolved once and used by the meter and the probe. */
  const abuse: AbuseLimits = resolveAbuse(config)
  /** Every room's notification endpoints. See `push.ts` for why this is memory. */
  const pushRegistry = new PushRegistry()
  // A key that will not parse is a configuration mistake, not a reason for the
  // tunnel to be down: the relay's whole job -- letting a phone reach a computer --
  // needs nothing from Apple or Google, and an operator who pasted a key with the
  // wrong newlines in it should be told so, not given a service that exits at start-up.
  //
  // Measured on the shipped bundle: the example config's placeholder key made
  // `createPrivateKey` throw `ERR_OSSL_UNSUPPORTED` out of `startRelay`, so a
  // fresh install following the deployment notes never listened at all. The FCM
  // service account goes through the same guard for the same reason.
  const apns =
    config.apns === null ? null : createApnsOrWarn(config.apns, log)
  const fcm = config.fcm === null ? null : createFcmOrWarn(config.fcm, log)
  /** Whether this relay can notify anybody at all, on any platform. */
  const pushEnabled = apns !== null || fcm !== null
  /** Phone sockets waiting for the computer to accept their upgrade. */
  // The upgrade socket is a Duplex, not a net.Socket: `ws` accepts whatever the
  // HTTP server hands over, and typing it as a Socket made every use of it an error.
  const waiting = new Set<{ socket: Duplex; timer: NodeJS.Timeout }>()
  /** Phone sockets (or in-flight upgrades) held by each room, for the per-room cap. */
  const phoneSlots = new Map<string, number>()

  // The account service and the traffic ledger are created before the HTTP
  // server so every route below closes over the same instance. A relay with
  // accounts disabled still has a ledger when it is configured to report to the
  // account relay; it simply keeps it in memory and stores no files.
  const accountsConfig = config.accounts
  if (accountsConfig?.enabled === true && parseHash(accountsConfig.adminPasswordHash) === null) {
    throw new Error(
      'accounts.enabled requires a valid adminPasswordHash; run the installer or the account CLI to generate one',
    )
  }
  // `loadConfig` already refuses this, but a caller can hand `startRelay` a
  // config it built itself -- and a gate with no store would report itself as
  // enforcing while letting everybody through.
  if (accountsConfig !== null && accountsConfig.paidGate.mode !== 'off' && !accountsConfig.enabled) {
    throw new Error(
      `accounts.paidGate.mode is "${accountsConfig.paidGate.mode}" but accounts.enabled is false; ` +
        'the gate has no account store to verify against',
    )
  }
  const accountStore =
    accountsConfig?.enabled === true
      ? await AccountStore.open({
          dataDir: accountsConfig.dataDir,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          ...(deps.passwordParams === undefined ? {} : { passwordParams: deps.passwordParams }),
          ...(deps.appstoreRoots === undefined ? {} : { appstoreRoots: deps.appstoreRoots }),
          gravatar: accountsConfig.gravatar,
          apple: {
            audiences: accountsConfig.appleAudiences,
            keysURL: accountsConfig.appleKeysURL,
          },
          appstore: {
            bundleId: accountsConfig.appstore.bundleId,
            productId: accountsConfig.appstore.productId,
            allowSandbox: accountsConfig.appstore.allowSandbox,
          },
          log,
        })
      : null
  // Mail. A `service` process owns the transport (主力0); the account relay owns
  // only a client that posts to it. Both can be absent: the tunnel never needs
  // mail to move a byte.
  const mailConfig = config.mail ?? null
  const mailService =
    mailConfig !== null && mailConfig.role === 'service'
      ? await MailService.open({
          dataDir: accountsConfig?.dataDir ?? './data',
          transport:
            mailConfig.transport === 'smtp'
              ? new SmtpMailTransport({
                  host: mailConfig.smtp.host,
                  port: mailConfig.smtp.port,
                  secure: mailConfig.smtp.secure,
                  user: mailConfig.smtp.user,
                  password: mailConfig.smtp.password,
                  from: mailConfig.from.address,
                  replyTo: mailConfig.contact,
                  log,
                })
              : new TencentMailTransport({
                  secretId: mailConfig.tencent.secretId,
                  secretKey: mailConfig.tencent.secretKey,
                  region: mailConfig.tencent.region,
                  from: `${mailConfig.from.name} <${mailConfig.from.address}>`,
                  replyTo: mailConfig.contact,
                }),
          templateIds: mailConfig.tencent.templateIds,
          limits: mailConfig.limits,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          log,
        })
      : null
  const mailClient =
    mailConfig !== null && mailConfig.role === 'client'
      ? new MailClient({ url: mailConfig.service.url, token: mailConfig.service.token })
      : null

  // Codes live on the account relay, next to the accounts they protect.
  const verification =
    accountStore === null || accountsConfig === null
      ? null
      : await VerificationCodes.open({
          dataDir: accountsConfig.dataDir,
          secret:
            accountsConfig.internalSecret !== ''
              ? accountsConfig.internalSecret
              : accountsConfig.adminPasswordHash,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          log,
        })

  // The traffic policy. It records warnings even when mail is unavailable, so a
  // deployment without a sender still bans after three warnings -- it just
  // cannot tell the person why.
  const enforcement =
    accountStore === null
      ? null
      : new Enforcement({
          store: accountStore,
          mail: mailClient,
          contact: mailConfig?.contact ?? 'shirazunagisa@icloud.com',
          ...(deps.now === undefined ? {} : { now: deps.now }),
          log,
        })

  const traffic = await TrafficLedger.open({
    dataDir: accountsConfig?.enabled === true ? accountsConfig.dataDir : null,
    relayId: accountsConfig?.reportId === undefined || accountsConfig.reportId === ''
      ? `relay-${config.role}`
      : accountsConfig.reportId,
    role: config.role,
    reportTo: accountsConfig?.reportTo ?? '',
    internalSecret: accountsConfig?.internalSecret ?? '',
    alertBytesPerDay: abuse.trafficAlertBytesPerDay,
    alertGrowthFactor: abuse.trafficAlertGrowthFactor,
    // The plan-aware ceiling needs the account store; a free relay keeps the
    // flat threshold. `onAnomaly` is wired either way, so the callback does not
    // silently vanish with the store: on the account relay enforcement turns it
    // into a warning or a ban, and -- where it cannot act, because the identity
    // is a `guest:`/`anon:` header rather than an account -- it now says so in
    // the log instead of returning silently. On a free relay (no store, no
    // enforcement) the ledger's own ANOMALY line and the healthz `anomalies`
    // count are the surface.
    onAnomaly: (anomaly) => {
      enforcement?.observe(anomaly)
    },
    ...(accountStore === null
      ? {}
      : {
          // Free accounts keep the 500 MB ceiling even when their traffic was
          // reported by the free relay; paid accounts get 5 GB.
          thresholdFor: (identity: string): number => {
            const plan = identity.startsWith('account:')
              ? accountStore.planForSessionHash(identity.slice('account:'.length))
              : null
            return plan === 'paid'
              ? (abuse.trafficAlertBytesPerDayPaid ?? 5 * 1024 * 1024 * 1024)
              : abuse.trafficAlertBytesPerDay
          },
        }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    log,
  })
  accountStore?.setTrafficRemover((hashes) => {
    for (const hash of hashes) traffic.remove(`account:${hash}`)
  })

  // The paid gate. It is built only when the relay both owns the account store
  // and was told to gate; `loadConfig` refuses the combination of "enforce" and
  // "no store", so a misconfiguration is a startup failure rather than a
  // protection that reports itself as on and is not. The gate registers its own
  // invalidation hook with the store, so a refund or a sign-out reaches it
  // without this file having to remember to connect the two.
  const gateConfig = accountsConfig?.paidGate ?? null
  const paidGate =
    accountStore === null || gateConfig === null || gateConfig.mode === 'off'
      ? null
      : new PaidGate({
          store: accountStore,
          mode: gateConfig.mode,
          allowUnaccounted: gateConfig.allowUnaccounted,
          cacheTtlMs: gateConfig.cacheTtlMs,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          log,
        })

  // The paid gate's production posture. `observe` and `allowUnaccounted` are
  // rollout tools that silently give away the bandwidth this relay sells, so a
  // paid relay that runs either way is a billing hole wearing a config file.
  // `strict` turns that from a warning into a start-up refusal; without it the
  // problems are named loudly and the relay still starts, because a rollout
  // that cannot be watched is not a rollout.
  const gateProblems = gateStartupChecks(config)
  if (gateProblems.length > 0) {
    const strict = gateConfig?.strict === true
    for (const problem of gateProblems) {
      log(`relay: ${strict ? 'REFUSING TO START' : 'WARNING'} — ${problem}`)
    }
    if (strict) {
      throw new Error(
        `the paid gate is not enforcing and paidGate.strict is on:\n  - ${gateProblems.join('\n  - ')}`,
      )
    }
  }

  // The data-plane meter. One instance, keyed by the same identity keys the
  // traffic ledger uses, so a caller cannot get a fresh budget by rotating
  // headers and the two agree on who spent what.
  const quota = new DataQuota({
    requestsPerMinute: abuse.requestsPerMinute,
    ...(abuse.burst > 0 ? { burst: abuse.burst } : {}),
    bytesPerDay: abuse.bytesPerDay,
    onExhausted: (identity: string, bytes: number, day: string) => {
      // Recorded for the report as well as for the policy: a free relay's
      // account lives on the account relay, and it can only warn if the
      // spending is reported.
      traffic.noteExhausted(identity, day, bytes)
      enforcement?.observe({ identity, bytes, day, reason: 'quota' })
    },
    ...(deps.now === undefined ? {} : { now: deps.now }),
    log,
  })

  // The address meter, the second half of the data-plane budget. The identity
  // meter is only as strong as the identity, and on a free relay the identity
  // is whatever `x-mizar-client-id` the phone chose to send -- a script can
  // mint a new one per request and collect a fresh 500 MiB each time. This
  // meter is keyed by the address group (an IPv6 peer is aggregated to its
  // /64), which the caller cannot rotate its way out of, so the ceiling on
  // "one household" becomes a ceiling again.
  //
  // It only bounds callers the paid gate did NOT vouch for. A verified account
  // already has an identity that cannot be forged and an enforcement chain
  // that can ban it; charging the shared address budget as well would let one
  // heavy user spend a whole NAT's allowance.
  const ipQuota = new DataQuota({
    requestsPerMinute: abuse.requestsPerMinutePerIp,
    // The burst is shared with the identity meter's tuning knob: one knob per
    // concern, and an operator who sizes the address bucket is sizing the same
    // kind of bucket.
    ...(abuse.burst > 0 ? { burst: abuse.burst } : {}),
    bytesPerDay: abuse.bytesPerDayPerIp,
    onExhausted: (group: string, bytes: number, day: string) => {
      // An address has no account to warn and no report row to write -- the
      // ledger's keys are identities, and inventing `ip:` keys there would
      // corrupt the account relay's view. The log and the healthz counters are
      // the whole surface, which is the honest one: this limit answers "where
      // is the bandwidth going", not "who is spending it".
      log(
        `relay: address ${group} spent its ${Math.round(abuse.bytesPerDayPerIp / (1024 * 1024))}MiB ` +
          `daily budget on ${day} (${Math.round(bytes / (1024 * 1024))}MiB); refusing its requests until the day turns over`,
      )
    },
    ...(deps.now === undefined ? {} : { now: deps.now }),
    log,
  })

  /**
   * The address meter's key for one caller, or `null` when the caller is out
   * of its scope.
   *
   * @param peer - the source address {@link clientAddress} resolved.
   * @param verifiedHash - the token hash the paid gate verified, or `null`.
   * @returns the key, or `null` for a gate-verified account.
   */
  function addressKey(peer: string, verifiedHash: string | null): string | null {
    return verifiedHash === null ? `ip:${addressGroup(peer)}` : null
  }

  /**
   * Spend against the meters one request owes: its identity budget, and --
   * unless the gate vouched for the identity -- its address budget.
   *
   * The identity meter runs first on purpose. The address budget is shared by
   * everyone behind one NAT, so it must only be spent by traffic the caller's
   * own budget also approved: with the reverse order a caller whose identity
   * budget is gone could still drain the shared address budget with requests
   * doomed to be refused, locking their household out for the day at no cost.
   * The cost of this order is the opposite and small -- when the address meter
   * refuses, the caller's own budget has already counted bytes that never
   * moved, which just makes their day end slightly early.
   *
   * @param ipKey - from {@link addressKey}, or `null` to skip the address meter.
   * @param identityKey - the traffic ledger's identity key.
   * @param bytes - payload bytes about to be carried, `0` for a bare request.
   * @returns the first refusal, or an allowance.
   */
  function admitBytes(ipKey: string | null, identityKey: string, bytes: number): QuotaDecision {
    const decision = quota.admit(identityKey, bytes)
    if (!decision.allowed || ipKey === null) return decision
    return ipQuota.admit(ipKey, bytes)
  }

  /**
   * Record bytes already carried against both meters. Same order and same
   * reason as {@link admitBytes}.
   *
   * @param ipKey - from {@link addressKey}, or `null` to skip the address meter.
   * @param identityKey - the traffic ledger's identity key.
   * @param bytes - payload bytes carried.
   */
  function chargeBytes(ipKey: string | null, identityKey: string, bytes: number): void {
    quota.charge(identityKey, bytes)
    if (ipKey !== null) ipQuota.charge(ipKey, bytes)
  }

  /**
   * Answer a request the paid gate refused.
   *
   * `402` is the one a phone acts on: it means "sign in with a paying account",
   * which is a different screen from `401` ("your session is gone"). `Retry-After`
   * is deliberately absent -- waiting does not help a free account.
   */
  function refuseGate(response: ServerResponse, decision: GateDecision & { allowed: false }): void {
    response.setHeader('x-mizar-gate', decision.code)
    writeJson(response, decision.status, { error: decision.code, message: decision.message })
  }

  /**
   * Answer a WebSocket upgrade the paid gate refused.
   *
   * A raw response rather than `wss.handleUpgrade`: the point is to never
   * complete the handshake. The phone's URLSession surfaces the status code of a
   * failed upgrade, which is how the app can tell "this server is for paid
   * accounts" from "the network is down" instead of showing one message for both.
   */
  function refuseUpgrade(socket: Duplex, decision: GateDecision & { allowed: false }): void {
    const body = JSON.stringify({ error: decision.code, message: decision.message })
    const reason =
      decision.status === 402 ? 'Payment Required' : decision.status === 403 ? 'Forbidden' : 'Unauthorized'
    socket.write(
      `HTTP/1.1 ${decision.status} ${reason}\r\n` +
        'content-type: application/json; charset=utf-8\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        'cache-control: no-store\r\n' +
        `x-mizar-gate: ${decision.code}\r\n` +
        'connection: close\r\n\r\n' +
        body,
    )
    socket.destroy()
  }

  const accountApi =
    accountStore === null
      ? null
      : new AccountApi({
          store: accountStore,
          trustProxy: config.trustProxy,
          notificationsEnabled: accountsConfig?.appstore.notificationsEnabled ?? true,
          ...(accountsConfig?.github === undefined || accountsConfig.github === null
            ? {}
            : { github: accountsConfig.github }),
          // Verification is on only when this relay can actually send: a
          // deployment without a mail client keeps the pre-verification
          // behaviour rather than refusing every registration.
          verification: mailClient === null ? null : verification,
          mail: mailClient,
          ...(mailConfig === null ? {} : { contact: mailConfig.contact }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          log,
        })
  const adminApi =
    accountStore === null || accountsConfig === null
      ? null
      : new AdminApi({
          store: accountStore,
          traffic,
          passwordHash: accountsConfig.adminPasswordHash,
          role: config.role,
          dataDir: accountsConfig.dataDir,
          publicBaseURL: accountsConfig.publicBaseURL,
          bundleId: accountsConfig.appstore.bundleId,
          productId: accountsConfig.appstore.productId,
          version: RELAY_VERSION,
          trustProxy: config.trustProxy,
          paidGate: paidGate?.mode ?? 'off',
          ...(deps.now === undefined ? {} : { now: deps.now }),
        })

  const server: Server = createServer((request, response) => {
    void handleHttp(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })

  /** Answer one phone HTTP request by replaying it over its room's tunnel. */
  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/'
    if (url === '/healthz') {
      writeJson(response, 200, {
        ok: true,
        rooms: rooms.size,
        inFlight: rooms.inFlight,
        pushDevices: pushRegistry.deviceCount,
        // Either-or, and left that way so the grep an operator already has
        // ("push":true) keeps meaning "this relay can notify somebody". `fcm`
        // is the new half and says which one.
        push: pushEnabled,
        fcm: fcm !== null,
        version: TUNNEL_PROTOCOL_VERSION,
        role: config.role,
        accounts: accountStore !== null,
        // `off` when this relay carries anybody, which is every free relay and
        // every paid one that has not opted in. A monitoring check can read this
        // one field and know whether the paywall is actually up.
        paidGate: paidGate?.mode ?? 'off',
        // The two ways a paywall ships open, spelled out so a monitor can alert
        // on either without parsing the config. `gateEnforced` is the single
        // boolean that is true only when both are right.
        paidGateAllowUnaccounted: accountsConfig?.paidGate.allowUnaccounted ?? false,
        gateEnforced:
          paidGate?.mode === 'enforce' && (accountsConfig?.paidGate.allowUnaccounted ?? false) === false,
        // The data-plane meters, so an operator can see refusals climbing
        // without reading logs. `entries` is the number of identities being
        // metered; the `ip` half is keyed by source address (IPv6 aggregated to
        // its /64) and is what catches a caller rotating its claimed identity.
        quota: {
          entries: quota.stats.entries,
          refusedRate: quota.stats.refusedRate,
          refusedBudget: quota.stats.refusedBudget,
          ip: {
            entries: ipQuota.stats.entries,
            refusedRate: ipQuota.stats.refusedRate,
            refusedBudget: ipQuota.stats.refusedBudget,
          },
        },
        // Traffic anomalies the ledger has recorded (any identity, up to its
        // 200-entry window), so a monitor can alert on abuse without reading
        // logs. On a free relay these are guest/anon callers -- there is no
        // account to warn, so this count and the address budget's refusals are
        // the whole response.
        anomalies: traffic.anomalies().length,
        // Whether this relay can mail, and what is waiting. `null` on a relay
        // that neither sends nor asks the other one to.
        mail: mailService?.status ?? (mailClient === null ? null : { role: 'client' }),
      })
      return
    }

    // The plugin's notification API. Handled before the room paths because it is
    // not part of the tunnel: these requests are answered here, not replayed to
    // a computer.
    if (url.startsWith(PUSH_PREFIX)) {
      await handlePush(request, response, url.slice(PUSH_PREFIX.length).split('?')[0] ?? '')
      return
    }

    // The account API and the admin UI are answered here, never replayed to a
    // computer. The paths are reserved whether or not this relay serves them, so
    // a free relay answers 404 instead of leaking the request into a room.
    const parsedUrl = new URL(url, 'http://relay.invalid')
    if (parsedUrl.pathname.startsWith('/account/v1/')) {
      if (accountApi === null) {
        writeJson(response, 404, { error: 'not found' })
      } else {
        await accountApi.handle(request, response, parsedUrl)
      }
      return
    }
    if (parsedUrl.pathname === '/internal/v1/traffic') {
      await handleTrafficReport(request, response)
      return
    }
    if (parsedUrl.pathname === MAIL_PATH) {
      if (mailService === null || mailConfig === null) {
        writeJson(response, 404, { error: 'not found' })
        return
      }
      await handleMailRequest(request, response, parsedUrl.pathname, {
        service: mailService,
        token: mailConfig.service.token,
        allowFrom: mailConfig.service.allowFrom,
        log,
      })
      return
    }
    if (parsedUrl.pathname === '/admin' || parsedUrl.pathname.startsWith('/admin/')) {
      if (adminApi === null) {
        writeJson(response, 404, { error: 'not found' })
      } else {
        await adminApi.handle(request, response, parsedUrl)
      }
      return
    }

    const split = splitRoomPath(url)
    if (split === null) {
      writeJson(response, 404, { error: 'not found' })
      return
    }

    // The same answer whether the room is empty or was never issued. Distinguishing
    // them would let anyone enumerate which computers are currently online.
    const tunnel = rooms.get(split.room)
    if (tunnel === undefined || !tunnel.alive) {
      writeJson(response, 404, { error: 'not found' })
      return
    }

    // The paywall, before a single byte is read from the body: an unpaid caller
    // should cost the relay a header parse and a map lookup, not a megabyte.
    // `/hello` and `/pair` are exempt -- they are the handshake a phone needs
    // *before* it has an account, and neither carries conversation traffic.
    const gateDecision =
      paidGate === null || isGateExempt(split.path) ? null : paidGate.authorize(request.headers)
    if (gateDecision !== null && !gateDecision.allowed) {
      refuseGate(response, gateDecision)
      return
    }

    const peer = clientAddress(request.socket.remoteAddress, request.headers, config.trustProxy !== false)
    // A token the gate verified is a better identity than the `x-mizar-account`
    // hash the phone claims: one cannot be spoofed, the other can, and the hash
    // is what decides which account pays for these bytes.
    const verifiedHash =
      gateDecision !== null && gateDecision.allowed && gateDecision.tokenHash !== ''
        ? gateDecision.tokenHash
        : null
    const identity =
      verifiedHash === null
        ? identityFor(request.headers, {
            room: split.room,
            peer,
            userAgent: request.headers['user-agent'] ?? '',
          })
        : { kind: 'account' as const, hash: verifiedHash, key: `account:${verifiedHash}` }
    const ipKey = addressKey(peer, verifiedHash)
    const body = await readBody(request, config.maxBodyBytes)
    if (body === null) {
      writeJson(response, 413, { error: 'request body too large' })
      return
    }

    // The data-plane meter, charged before the bytes are replayed. `admit` costs
    // a map lookup and refuses an over-quota caller here rather than after the
    // megabyte has crossed the uplink; the byte count is the request body plus
    // the answer the relay already knows it will carry.
    const decision = admitBytes(ipKey, identity.key, body.length)
    if (!decision.allowed) {
      const status = 429
      response.setHeader('retry-after', String(decision.retryAfterSeconds ?? 60))
      response.setHeader('x-mizar-quota', decision.reason ?? 'rate')
      writeJson(response, status, {
        error: 'QUOTA_EXCEEDED',
        message:
          decision.reason === 'budget'
            ? 'this account has spent its daily traffic allowance'
            : 'too many requests from this account',
      })
      return
    }

    try {
      const result = await tunnel.request(
        request.method ?? 'GET',
        split.path,
        forwardableHeaders(request),
        body.length === 0 ? null : body.toString('base64'),
      )
      // The cap is on the wire in both directions. It used to bound the phone's
      // request only, so whatever a computer answered was allocated and written
      // through unmeasured -- and in open-registration mode anybody may be a computer.
      const carried = result.body === null ? 0 : Buffer.byteLength(result.body, 'base64')
      if (carried > config.maxBodyBytes) {
        log(
          `relay: refused a ${Math.round(carried / 1024)}KB answer from room ${split.room} — ` +
            `over the ${Math.round(config.maxBodyBytes / 1024)}KB body cap`,
        )
        writeJson(response, 502, {
          error: 'the computer answered with more than this relay carries',
          detail: `${carried} bytes`,
        })
        return
      }
      const payload = result.body === null ? Buffer.alloc(0) : Buffer.from(result.body, 'base64')
      traffic.record(identity.key, body.length, carried)
      // The answer's bytes were not known at admission time, so they are charged
      // after the fact. The budget still refuses the *next* request once it is
      // spent; nothing already delivered is recalled.
      chargeBytes(ipKey, identity.key, carried)
      response.writeHead(result.status, {
        ...result.headers,
        'content-length': String(payload.length),
      })
      response.end(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(response, 502, { error: 'the computer did not answer', detail: message })
    }
  }

  /**
   * Accept one traffic report from another relay.
   *
   * This is the only account-ish route without a user session: it is
   * authenticated by the shared internal secret, carries no personal data beyond
   * the already-hashed identity keys, and is small and idempotent (counters add).
   */
  async function handleTrafficReport(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      accountsConfig === null ||
      accountsConfig.internalSecret === '' ||
      request.method !== 'POST'
    ) {
      writeJson(response, 404, { error: 'not found' })
      return
    }
    const presented = bearerToken(request)
    if (presented === null || !secretsEqual(presented, accountsConfig.internalSecret)) {
      writeJson(response, 401, { error: 'the internal secret is required' })
      return
    }
    const raw = await readBody(request, 1024 * 1024)
    if (raw === null) {
      writeJson(response, 413, { error: 'report too large' })
      return
    }
    const parsed = parseJsonObject(raw.toString('utf8'))
    if (parsed === null) {
      writeJson(response, 400, { error: 'a JSON object is required' })
      return
    }
    const relayId = typeof parsed['relayId'] === 'string' ? parsed['relayId'] : ''
    const role = parsed['role']
    const entries = parsed['entries'] ?? []
    const exhaustedRaw = parsed['exhausted'] ?? []
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(relayId) || (role !== 0 && role !== 1) || !Array.isArray(entries)) {
      writeJson(response, 400, { error: 'relayId, role and entries are required' })
      return
    }
    if (!Array.isArray(exhaustedRaw)) {
      writeJson(response, 400, { error: 'exhausted must be an array' })
      return
    }
    if (entries.length > 500 || exhaustedRaw.length > 500) {
      writeJson(response, 413, { error: 'at most 500 entries per report' })
      return
    }
    const clean = entries.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as Record<string, unknown>
      const identity = record['identity']
      const day = record['day']
      const bytesIn = record['in']
      const bytesOut = record['out']
      if (!isValidIdentity(identity) || !isValidDay(day)) return []
      if (typeof bytesIn !== 'number' || typeof bytesOut !== 'number') return []
      if (!Number.isFinite(bytesIn) || !Number.isFinite(bytesOut) || bytesIn < 0 || bytesOut < 0) return []
      return [{ identity, day, in: bytesIn, out: bytesOut }]
    })
    const cleanExhausted = exhaustedRaw.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const identity = record['identity']
      const day = record['day']
      const bytes = record['bytes']
      if (!isValidIdentity(identity) || !isValidDay(day)) return []
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return []
      return [{ identity, day, bytes }]
    })
    traffic.ingest({
      relayId,
      role,
      entries: clean,
      exhausted: cleanExhausted,
    })
    writeJson(response, 200, { ok: true, accepted: clean.length, exhausted: cleanExhausted.length })
  }

  /**
   * Answer one push request.
   *
   * Authenticated by the tunnel credential, and the room is derived from it --
   * the same derivation the tunnel upgrade uses, so a computer can only ever register
   * a token against its own room. The phone never calls this: it hands its token
   * to the computer over the authenticated Mizar protocol, and the computer brings it
   * here. That is what keeps a second trust relationship out of the design.
   *
   * @param request - the request.
   * @param response - the response to fill.
   * @param path - the endpoint, with the prefix removed.
   */
  async function handlePush(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const presented = bearerToken(request)
    const known =
      presented !== null &&
      presented.length >= 16 &&
      (config.tokens.length === 0 || config.tokens.some((token) => secretsEqual(token, presented)))
    if (!known || presented === null) {
      writeJson(response, 401, { error: 'a tunnel credential is required' })
      return
    }
    const room = deriveRoom(presented)

    const raw = await readBody(request, MAX_PUSH_BODY_BYTES)
    if (raw === null) {
      writeJson(response, 413, { error: 'request body too large' })
      return
    }
    let parsed: unknown = null
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw.toString('utf8'))
      } catch {
        parsed = null
      }
    }

    switch (path) {
      case 'register': {
        const device = readDevice(parsed)
        if (device === null) {
          writeJson(response, 400, {
            error:
              'deviceId and a token valid for its platform are required, and a hex liveActivityToken when one is sent',
          })
          return
        }
        // The registry is in memory and a room only exists once a device is
        // registered, so this is what bounds it: a room already known keeps
        // working (its computer re-announces every reconnect), a new one past the
        // limit does not.
        if (!pushRegistry.has(room) && pushRegistry.roomCount >= config.maxRooms) {
          log(`push: refused a room — already holding ${config.maxRooms} of them`)
          writeJson(response, 429, { error: 'this relay holds as many push rooms as it may have' })
          return
        }
        if (!pushRegistry.register(room, device)) {
          writeJson(response, 429, { error: 'this room has as many devices as it may have' })
          return
        }
        log(
          `push: registered ${device.deviceId} (${device.platform}, ${device.environment ?? 'n/a'}) for room ${room}`,
        )
        writeJson(response, 200, {
          ok: true,
          devices: pushRegistry.devices(room).length,
          enabled: pushEnabled,
        })
        return
      }

      case 'unregister': {
        const deviceId = (parsed as { deviceId?: unknown } | null)?.deviceId
        if (typeof deviceId !== 'string' || deviceId === '') {
          writeJson(response, 400, { error: 'deviceId is required' })
          return
        }
        const removed = pushRegistry.unregister(room, deviceId)
        writeJson(response, 200, { ok: true, removed, devices: pushRegistry.devices(room).length })
        return
      }

      case 'notify': {
        const notification = readNotification(parsed)
        if (notification === null) {
          writeJson(response, 400, { error: 'title and body are required' })
          return
        }
        const outcome = await deliver({ registry: pushRegistry, apns, fcm, log }, room, notification)
        writeJson(response, 200, { ok: true, ...outcome })
        return
      }

      case 'status': {
        // Deliberately no tokens: this is the endpoint an operator curls to find
        // out why their phone is silent, and a diagnostic that leaks credentials
        // is not a diagnostic.
        writeJson(response, 200, {
          ok: true,
          devices: pushRegistry.devices(room).map((device) => ({
            deviceId: device.deviceId,
            platform: device.platform,
            environment: device.environment,
            locale: device.locale,
            registeredAt: device.registeredAt,
          })),
          enabled: pushEnabled,
        })
        return
      }

      default:
        writeJson(response, 404, { error: 'not found' })
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '/'

    if (url === TUNNEL_PATH || url.startsWith(`${TUNNEL_PATH}?`)) {
      handleTunnelUpgrade(request, socket, head)
      return
    }

    const split = splitRoomPath(url)
    if (split === null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const tunnel = rooms.get(split.room)
    if (tunnel === undefined || !tunnel.alive) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    // The session socket is where every conversation byte goes, so this is the
    // gate that matters most. It runs before a slot is taken or the computer is
    // disturbed: an unpaid caller never causes a `ws-open` to be sent upstream.
    const gateDecision =
      paidGate === null || isGateExempt(split.path) ? null : paidGate.authorize(request.headers)
    if (gateDecision !== null && !gateDecision.allowed) {
      refuseUpgrade(socket, gateDecision)
      return
    }

    const peer = clientAddress(request.socket.remoteAddress, request.headers, config.trustProxy !== false)
    const verifiedHash =
      gateDecision !== null && gateDecision.allowed && gateDecision.tokenHash !== ''
        ? gateDecision.tokenHash
        : null
    const identity =
      verifiedHash === null
        ? identityFor(request.headers, {
            room: split.room,
            peer,
            userAgent: request.headers['user-agent'] ?? '',
          })
        : { kind: 'account' as const, hash: verifiedHash, key: `account:${verifiedHash}` }
    const ipKey = addressKey(peer, verifiedHash)

    // `maxClientsPerRoom` is the only bound on how many sockets one room holds,
    // and it counts the ones still waiting for the computer as well as the bridged
    // ones: the upgrade is deferred, so a room with a slow computer would otherwise
    // accept every socket that arrived before the first answer.
    const held = phoneSlots.get(split.room) ?? 0
    if (held >= config.maxClientsPerRoom) {
      log(
        `relay: refused a phone socket for room ${split.room} — ` +
          `${config.maxClientsPerRoom} already open`,
      )
      socket.write('HTTP/1.1 429 Too Many Requests\r\nretry-after: 5\r\n\r\n')
      socket.destroy()
      return
    }

    // The data-plane meter, charged one request for the upgrade itself. The
    // frames are then charged individually in `bridgePhone`, which is where the
    // real bytes are. Checking here means a caller that has spent its request
    // budget cannot even take a phone slot.
    const quotaDecision = admitBytes(ipKey, identity.key, 0)
    if (!quotaDecision.allowed) {
      socket.write(
        'HTTP/1.1 429 Too Many Requests\r\n' +
          `retry-after: ${quotaDecision.retryAfterSeconds ?? 60}\r\n` +
          `x-mizar-quota: ${quotaDecision.reason ?? 'rate'}\r\n` +
          'connection: close\r\n\r\n',
      )
      socket.destroy()
      return
    }

    phoneSlots.set(split.room, held + 1)
    // One release per socket, on whichever of its events comes first. The raw
    // Duplex outlives the upgrade -- `ws` wraps it rather than replacing it --
    // so this covers a socket that never completed the handshake too.
    let slotReleased = false
    const releaseSlot = (): void => {
      if (slotReleased) return
      slotReleased = true
      const remaining = (phoneSlots.get(split.room) ?? 1) - 1
      if (remaining <= 0) phoneSlots.delete(split.room)
      else phoneSlots.set(split.room, remaining)
    }
    socket.once('close', releaseSlot)
    socket.once('error', releaseSlot)

    // The raw socket is left unanswered until the computer says yes. Answering first
    // and closing afterwards would show the phone a socket that opened and died,
    // which reads as a bug in the app rather than as an unreachable computer.
    const entry = {
      socket,
      timer: setTimeout(() => {
        waiting.delete(entry)
        socket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n')
        socket.destroy()
      }, config.requestTimeoutMs),
    }
    entry.timer.unref?.()
    waiting.add(entry)

    /** The phone went away before the computer answered. */
    const onSocketGone = (): void => {
      clearTimeout(entry.timer)
      waiting.delete(entry)
    }
    socket.on('close', onSocketGone)
    socket.on('error', onSocketGone)

    // Held in an object rather than a `let` so the callbacks below can read them
    // without TypeScript narrowing each to the `null` it had at closure-creation
    // time -- neither can exist before the call that creates it returns.
    //
    // The phone socket arrives asynchronously, which is what makes this necessary:
    // the stream's handlers are fixed when it opens and the socket they must talk
    // to does not exist yet -- and, for data coming back, will not exist for
    // another round trip. A first version of this left `onMessage` empty with a
    // comment explaining that the computer "does not send before the upgrade
    // completes", which was true and beside the point: the handler is permanent,
    // and so the computer's answers had nowhere to go for the life of the stream.
    const opened: { stream: TunnelStream | null; phone: WebSocket | null } = {
      stream: null,
      phone: null,
    }
    opened.stream = tunnel.openStream(split.path, forwardableHeaders(request), {
      onOpened: () => {
        const stream = opened.stream
        if (stream === null) return
        clearTimeout(entry.timer)
        waiting.delete(entry)
        socket.removeListener('close', onSocketGone)
        socket.removeListener('error', onSocketGone)
        wss.handleUpgrade(request, socket, head, (phone: WebSocket) => {
          opened.phone = phone
          bridgePhone(phone, stream, identity, ipKey)
        })
      },
      onError: (message) => {
        clearTimeout(entry.timer)
        waiting.delete(entry)
        log(`relay: stream refused for room ${split.room}: ${message}`)
        // Before the upgrade there is still an HTTP request to answer, and saying
        // 502 is far more useful than a socket that opens and immediately dies.
        // After it, the phone socket is the only thing left to close.
        if (opened.phone !== null) {
          opened.phone.close(1011, 'the computer dropped the stream')
        } else if (!socket.destroyed) {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          socket.destroy()
        }
      },
      onMessage: (data, binary) => {
        // The last hop before the phone, and the only place that knows the
        // phone's limit. iOS's `URLSessionWebSocketTask` refuses any message
        // over one mebibyte and **closes the socket** -- so forwarding an
        // oversized frame does not deliver an answer, it kills the connection:
        //
        //   input message size 4959085 exceeds maximum message size 1048576
        //   Read completed with an error Message too long
        //
        // The plugin guards its own output too, but a plugin older than this
        // relay is a normal state during an upgrade, and a limit that depends on
        // the far end having been upgraded is not a limit.
        if (data.length > config.maxMessageBytes) {
          log(
            `relay: refusing a ${Math.round(data.length / 1024)}KB frame for room ${split.room} — ` +
              'the phone would drop the connection instead',
          )
          return
        }
        traffic.record(identity.key, 0, data.length)
        // Computer -> phone bytes spend the same daily budget. Refusing here is
        // dropping the frame rather than the connection: the caller is over its
        // allowance, but the session the phone already holds should survive
        // until the day turns over.
        if (!admitBytes(ipKey, identity.key, data.length).allowed) return
        opened.phone?.send(data, { binary })
      },
      onClose: (code, reason) => {
        clearTimeout(entry.timer)
        waiting.delete(entry)
        opened.phone?.close(saneCloseCode(code), reason)
      },
    })

    if (opened.stream === null) {
      clearTimeout(entry.timer)
      waiting.delete(entry)
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.destroy()
      }
    }
  })

  /** Move bytes between a phone WebSocket and its tunnel stream. */
  function bridgePhone(
    phone: WebSocket,
    stream: TunnelStream,
    identity: ReturnType<typeof identityFor>,
    ipKey: string | null,
  ): void {
    // The phone joins the keepalive round here. Its silence is measured from
    // now rather than from the epoch, so a socket that never answers is dropped
    // on the round after the one that first pings it.
    phones.set(phone, Date.now())
    phone.on('pong', () => phones.set(phone, Date.now()))
    phone.on('message', (data: Buffer, isBinary: boolean) => {
      if (data.length > config.maxMessageBytes) {
        phone.close(1009, 'message too large')
        stream.close(1009, 'message too large')
        return
      }
      // Phone -> computer bytes spend the budget too. A *budget* refusal closes
      // the socket: the day is genuinely over for this account. A *rate*
      // refusal does not: a launch burst of frames is not somebody spending
      // their traffic, and closing with "traffic allowance spent" made the app
      // tell people their quota was gone when it was not. The frame is dropped
      // and the socket stays, exactly like the computer -> phone direction.
      const decision = admitBytes(ipKey, identity.key, data.length)
      if (!decision.allowed) {
        if (decision.reason === 'budget') {
          phone.close(1008, 'traffic allowance spent')
          stream.close(1008, 'traffic allowance spent')
        }
        return
      }
      traffic.record(identity.key, data.length, 0)
      stream.send(Buffer.isBuffer(data) ? data : Buffer.from(String(data)), isBinary)
    })
    phone.on('close', (code: number, reason: Buffer) => {
      // The phone's code is forwarded, and a `close` handler is given reserved
      // codes like 1006 that must not be sent on. Replaying one unexamined took
      // the plugin down with a TypeError.
      phones.delete(phone)
      stream.close(saneCloseCode(code), reason.toString('utf8'))
    })
    phone.on('error', () => {
      phones.delete(phone)
      stream.close(1011, 'phone socket error')
    })
  }

  /** Authenticate and attach a computer's tunnel. */
  function handleTunnelUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Self-registration. A relay that issued credentials would need an operator
    // to hand them out and a user to type them, which is the configuration this
    // design exists to remove -- so any well-formed credential is accepted and
    // the room is derived from it.
    //
    // That is safe for the reason the room is derived rather than chosen: the
    // room is 60 bits of a hash of a secret this computer generated locally, so
    // knowing one tells you nothing about any other. What the relay must guard
    // is not who may connect but how many may, which is what the limits below
    // are for.
    const presented = bearerToken(request)
    if (presented === null || presented.length < 16) {
      log('relay: tunnel refused — a credential of at least 16 characters is required')
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    if (config.tokens.length > 0 && !config.tokens.some((token) => secretsEqual(token, presented))) {
      log('relay: tunnel refused — this relay only accepts its configured credentials')
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Behind the documented nginx deployment every tunnel arrives from
    // 127.0.0.1, and counting the proxy would turn this per-address limit into a
    // global one: four computers online and the fifth refused. The headers are
    // read only when the peer is loopback, so a relay exposed directly keeps
    // counting the real peer. See client-address.ts.
    //
    // The count is per address *group* (an IPv6 peer is aggregated to its /64),
    // so privacy-address rotation inside one subscriber's delegation cannot
    // mint fresh allowances. See `addressGroup`.
    const peer = clientAddress(
      request.socket.remoteAddress,
      request.headers,
      config.trustProxy !== false,
    )
    const peerKey = addressGroup(peer)
    if (tunnelsPerIp.get(peerKey) !== undefined && (tunnelsPerIp.get(peerKey) ?? 0) >= config.maxTunnelsPerIp) {
      log(`relay: tunnel refused — ${peer} already has ${config.maxTunnelsPerIp} tunnels`)
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }

    const room = deriveRoom(presented)
    if (rooms.get(room) === undefined && rooms.size >= config.maxRooms) {
      log(`relay: tunnel refused — already serving ${config.maxRooms} rooms`)
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (host: WebSocket) => {
      tunnelsPerIp.set(peerKey, (tunnelsPerIp.get(peerKey) ?? 0) + 1)
      const tunnel = new Tunnel(
        {
          send: (text) => host.send(text),
          close: (code, reason) => host.close(code, reason),
          on: (event, listener) => host.on(event, listener as never),
          get bufferedAmount() {
            return host.bufferedAmount
          },
        },
        config.requestTimeoutMs,
      )

      const displaced = rooms.register(room, tunnel)
      displaced?.close(4000, 'replaced by a newer tunnel')
      log(`relay: tunnel for room ${room} connected${displaced ? ' (replaced a stale one)' : ''}`)

      let released = false
      host.on('close', () => {
        if (!released) {
          released = true
          const remaining = (tunnelsPerIp.get(peerKey) ?? 1) - 1
          if (remaining <= 0) tunnelsPerIp.delete(peerKey)
          else tunnelsPerIp.set(peerKey, remaining)
        }
        const wasCurrent = rooms.remove(room, tunnel)
        if (wasCurrent) log(`relay: tunnel for room ${room} disconnected`)
      })

      host.send(
        JSON.stringify({
          t: 'welcome',
          room,
          protocolVersion: TUNNEL_PROTOCOL_VERSION,
        }),
      )
    })
  }

  /**
   * Keep every computer awake, and drop the ones that stop answering.
   *
   * The ping is what turns a half-open tunnel into a disconnect the relay can
   * act on. Without it a computer whose process died keeps a socket that accepts
   * writes, and every phone request pays a full timeout to discover it.
   */
  let pingCounter = 0
  const interval = Math.max(5_000, Math.floor(config.tunnelIdleMs / 3))
  const sweeper = setInterval(() => {
    for (const room of rooms.rooms) {
      const tunnel = rooms.get(room)
      if (tunnel === undefined || !tunnel.alive) continue
      if (!tunnel.responsiveWithin(config.tunnelIdleMs)) {
        log(`relay: tunnel for room ${room} stopped answering; dropping it`)
        tunnel.close(4001, 'no pong within the idle window')
        rooms.remove(room, tunnel)
        continue
      }
      pingCounter += 1
      tunnel.ping(`p${pingCounter}`)
    }
  }, interval)
  sweeper.unref?.()

  /**
   * Keep every phone awake, and drop the ones that stop answering.
   *
   * The sibling of the tunnel sweeper above, one hop closer to the operator.
   * The value carried per socket is the last time it gave any sign of life: a
   * pong, mostly, since the ping asks for one, and any unsolicited pong counts
   * too. A phone whose answer is more than two intervals old is not a slow
   * phone — a live one answers within a round trip — it is a socket only this
   * side still believes in, one that holds its stream, and the computer's local
   * end of it, open for nothing. Terminating it is what lets both ends clean up
   * instead of waiting out a timeout that never fires.
   */
  const keepaliveMs = phoneKeepaliveMs()
  const phones = new Map<WebSocket, number>()
  const phoneSweeper = setInterval(() => {
    const now = Date.now()
    for (const [phone, lastAnswer] of phones) {
      if (now - lastAnswer > keepaliveMs * 2) {
        log('relay: a phone stopped answering its keepalive; dropping it')
        phones.delete(phone)
        phone.terminate()
        continue
      }
      phone.ping()
    }
  }, keepaliveMs)
  phoneSweeper.unref?.()

  // Awaited so the returned port is the real one. Binding port 0 is how the
  // tests avoid colliding with a relay someone is actually running, and a
  // synchronous read of `server.address()` happens before the bind completes --
  // it would report the requested 0 rather than the assigned port.
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : config.port)
    })
  })
  log(`relay: listening on ${config.host}:${boundPort}`)
  log(
    config.tokens.length === 0
      ? 'relay: open registration — any plugin may register a room'
      : `relay: ${config.tokens.length} configured credential(s)`,
  )
  if (paidGate !== null) {
    log(
      paidGate.mode === 'enforce'
        ? 'relay: paid gate is enforcing — only paying accounts are carried' +
            (gateConfig?.allowUnaccounted === true ? ' (unaccounted phones allowed)' : '')
        : 'relay: paid gate is observing — refusals are counted and logged, nothing is blocked',
    )
  }

  const probe = startProbe(config, log)
  // The direct path's address discovery. Same reply limits as the probe: both
  // answer a source address nobody verified, so both are bounded the same way.
  const stunLimits = resolveAbuse(config)
  const stun = startStunServer({
    port: config.stunPort,
    limits: {
      repliesPerSecond: stunLimits.probeRepliesPerSecond,
      repliesPerSecondPerSource: stunLimits.probeRepliesPerSecondPerSource,
    },
    log,
  })

  return {
    port: boundPort,
    close: async () => {
      clearInterval(sweeper)
      await traffic.close()
      await mailService?.close()
      await accountStore?.close()
      for (const entry of waiting) clearTimeout(entry.timer)
      waiting.clear()
      rooms.closeAll()
      apns?.close()
      fcm?.close()
      probe?.close()
      stun?.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * The UDP endpoint probe.
 *
 * This is the relay being useful with the one thing a computer behind a campus
 * firewall cannot do for itself: it has a public address, so it can tell each
 * peer where that peer appears from the outside. That is the whole of STUN for
 * this purpose, in about twenty lines, and it means no third-party service is
 * needed for hole punching.
 *
 * The reply is JSON rather than RFC 5389, because the only consumer is this
 * project's own code and a readable answer is worth more here than
 * interoperability with a browser.
 *
 * It is also the relay's one spoofable surface: UDP source addresses can be
 * forged, so an unthrottled responder is a reflection amplifier pointed at
 * whoever an attacker names. Two limits keep it from being one -- a per-source
 * cap for the ordinary case and a global cap that a distributed spoof cannot
 * walk past -- plus a hard bound on how large a reply grows, so the
 * amplification factor stays near one instead of near the ratio an attacker
 * would choose.
 *
 * @param config - the relay configuration.
 * @param log - where to report.
 * @returns the socket, or `null` when the probe is disabled.
 */
function startProbe(config: RelayConfig, log: (message: string) => void): UdpSocket | null {
  if (config.probePort <= 0) return null
  const abuse = resolveAbuse(config)
  const socket = createSocket('udp4')
  // The same guard the STUN responder uses: the two are the relay's only
  // services that answer an unverified source address, so the protection
  // against being used as a reflector lives in one place and is tested once.
  const guard = new UdpGuard({
    repliesPerSecond: abuse.probeRepliesPerSecond,
    repliesPerSecondPerSource: abuse.probeRepliesPerSecondPerSource,
  })

  socket.on('message', (data: Buffer, from) => {
    // Any payload earns an answer; the peer wants its own address back, not a
    // handshake.
    if (!guard.allow(from.address)) return

    // The token is echoed so a peer can match an answer to its own probe. It is
    // capped and the reply is otherwise fixed-size, which is what keeps the
    // amplification factor near one: a request of any size earns at most this
    // many bytes back, so the reflector is not worth an attacker's bandwidth.
    const MAX_ECHO_BYTES = 32
    const echoed = data.length > 0 && data.length <= MAX_ECHO_BYTES ? data.toString('utf8') : null
    const reply = JSON.stringify({
      address: from.address,
      port: from.port,
      token: echoed,
    })
    const payload = Buffer.from(reply, 'utf8')
    // A final hard bound, independent of the fields above: under one MTU and
    // always smaller than a maximal request, so the reply can never be the
    // larger half of the exchange.
    if (payload.length > 512) return
    socket.send(payload, from.port, from.address)
  })
  socket.on('error', (error) => log(`relay: probe socket error: ${error.message}`))
  socket.bind(config.probePort, '0.0.0.0', () => {
    log(`relay: endpoint probe on udp/${config.probePort}`)
  })
  return socket
}

/**
 * Start from configuration, or exit with the reason.
 *
 * A config error is a start-up failure, not a runtime one: a relay with no
 * tokens accepts nothing, and one with a typo'd port is not running where anyone
 * expects. Failing loudly beats being up and useless.
 */
export function main(): void {
  let config: RelayConfig
  try {
    config = loadConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
    return
  }

  void startRelay(config)
    .then((relay) => {
      const shutdown = (signal: string): void => {
        console.log(`relay: ${signal}, shutting down`)
        void relay.close().then(() => process.exit(0))
      }
      process.on('SIGTERM', () => shutdown('SIGTERM'))
      process.on('SIGINT', () => shutdown('SIGINT'))
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}

// Run when invoked directly, stay importable when a test wants a relay.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main()
}
