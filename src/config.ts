/**
 * Relay configuration.
 *
 * Deliberately a file rather than a database: this relay serves one operator and
 * a handful of computers, and a token list that fits in a text file is easier to
 * audit than a schema. Everything here has an environment-variable override so a
 * container deployment does not need a writable filesystem.
 *
 * @module dsh-mizar-relay/config
 */
import { readFileSync } from 'node:fs'
import type { ApnsConfig } from './apns.js'
import type { FcmConfig } from './fcm.js'

/** How the relay is configured. */
export interface RelayConfig {
  /** Port the plain-HTTP server listens on. TLS is the reverse proxy's job. */
  readonly port: number
  /** Interface to bind. Loopback by default, because nginx sits in front. */
  readonly host: string
  /**
   * Tunnel credentials to accept, or empty to accept any.
   *
   * Empty is the normal mode, and the one that makes the plugin configurable by
   * doing nothing: a relay issues no credentials, every plugin invents its own
   * on first run, and the room is derived from whatever it presents. There is
   * nothing for an operator to hand out and nothing for a user to type.
   *
   * Non-empty restricts the relay to a known set, which is what a self-hoster
   * running a private relay wants. The check is a string comparison against a
   * list, so it is not a defence against a determined attacker -- it is a way to
   * keep one's own relay private.
   */
  readonly tokens: readonly string[]
  /**
   * Whether a local reverse proxy's `X-Real-IP` / `X-Forwarded-For` may say
   * which computer a tunnel belongs to.
   *
   * The documented deployment puts nginx in front and the relay on loopback, so
   * every tunnel then arrives from `127.0.0.1`: without this, the per-address
   * limit below counts the proxy and becomes a global cap. Only a connection
   * whose TCP peer is loopback is ever attributed to a header, so a relay
   * exposed directly cannot be talked out of its real peer.
   */
  readonly trustProxy: boolean
  /**
   * Tunnels allowed from one address.
   *
   * The relay is open, so without this a single host can register rooms until
   * the process runs out of memory. Four is generous for one household and far
   * below what a script would want.
   */
  readonly maxTunnelsPerIp: number
  /** Rooms served at once. Bounds memory regardless of how connections arrive. */
  readonly maxRooms: number
  /** Largest request body the relay will carry, in bytes. */
  readonly maxBodyBytes: number
  /**
   * Largest single WebSocket message the relay will carry, in bytes.
   *
   * Below iOS's hard limit of one mebibyte, because exceeding it does not
   * truncate the message -- it closes the socket, and the operator loses the
   * connection rather than the answer.
   */
  readonly maxMessageBytes: number
  /** Concurrent client connections allowed per room. */
  readonly maxClientsPerRoom: number
  /** How long a phone request waits for the computer before it is failed, in ms. */
  readonly requestTimeoutMs: number
  /** How long a tunnel may go without a pong before it is dropped, in ms. */
  readonly tunnelIdleMs: number
  /** UDP port for the endpoint probe, or 0 to disable. */
  readonly probePort: number
  /**
   * UDP port for the STUN responder, or `0` to disable it.
   *
   * Standard 3478 on purpose: it is the one port a restricted network is most
   * likely to recognise as STUN and let out, and clients are configured with an
   * explicit address anyway, so there is nothing to gain from being unusual.
   */
  readonly stunPort: number
  /**
   * How to reach Apple, or `null` when this relay does not send notifications.
   *
   * `null` is the default and a perfectly good deployment: everything except
   * notifications works without it, and a self-hoster who does not want a signing
   * key on their server should not have to have one.
   */
  readonly apns: ApnsConfig | null
  /**
   * How to reach Google, or `null` when this relay does not notify Androids.
   *
   * Independent of {@link apns} in both directions: a relay may serve only
   * iPhones, only Androids, or both, and neither key is required for the
   * tunnel to work. See {@link readFcm}.
   */
  readonly fcm: FcmConfig | null
  /**
   * Which kind of relay this is: `0` carries free traffic, `1` carries paid
   * traffic. The value is a label used by the account backend and the traffic
   * report; it never rejects a connection. Existing deployments load as `0`.
   */
  readonly role: 0 | 1
  /**
   * The account service, or `null` when this relay keeps no user state.
   *
   * Exactly one relay in a deployment (the paid/high-bandwidth one) enables
   * this. A free relay leaves it off and reports its traffic to the account
   * relay over `/internal/v1/traffic`.
   */
  readonly accounts: AccountsConfig | null
  /**
   * Data-plane abuse limits. Optional on the type so a hand-written config or
   * an older test fixture keeps compiling; `loadConfig` always fills it, and
   * {@link resolveAbuse} fills the defaults when a caller left it out.
   */
  readonly abuse?: AbuseLimits
  /**
   * Transactional mail, or `null` when this relay sends none.
   *
   * The free relay runs the SMTP/API sender (`role: "service"`); the account
   * relay runs a client that posts to it (`role: "client"`). A relay that does
   * neither leaves it out. Optional on the type so the many hand-built configs
   * in tests and embedders keep compiling.
   */
  readonly mail?: MailConfig | null
}

/** What this relay does with mail. */
export type MailRole = 'service' | 'client' | 'off'

/** How the mail service reaches the outside world. */
export type MailTransportKind = 'smtp' | 'tencent-ses'

/** One transactional mail configuration. */
export interface MailConfig {
  readonly role: MailRole
  readonly transport: MailTransportKind
  /** Where clients post, and who may call the service. */
  readonly service: {
    readonly url: string
    readonly token: string
    readonly allowFrom: readonly string[]
  }
  readonly smtp: {
    readonly host: string
    readonly port: number
    readonly secure: boolean
    readonly user: string
    readonly password: string
  }
  readonly tencent: {
    readonly secretId: string
    readonly secretKey: string
    readonly region: string
    readonly templateIds: {
      readonly verification: number
      readonly warning: number
      readonly banned: number
    }
  }
  readonly from: { readonly address: string; readonly name: string }
  /** The appeal address printed in a ban mail and shown by the phone. */
  readonly contact: string
  readonly limits: { readonly perRecipientPerHour: number; readonly globalPerHour: number }
}

/** Gravatar lookup policy. */
export interface GravatarConfig {
  /** Whether to try Gravatar at all before falling back to a generated avatar. */
  readonly enabled: boolean
  /**
   * Base URLs to try in order. A deployment in China needs a mirror in front:
   * the official host is unreachable there and every registration would pay
   * the timeout before falling back.
   */
  readonly baseURLs: readonly string[]
}

/** StoreKit / App Store subscription verification policy. */
export interface AppStoreConfig {
  /** Bundle id Apple signs into every transaction. */
  readonly bundleId: string
  /** The auto-renewable subscription product id. */
  readonly productId: string
  /** Whether sandbox transactions are accepted (they are on a test server). */
  readonly allowSandbox: boolean
  /** Whether App Store Server Notifications V2 are accepted. */
  readonly notificationsEnabled: boolean
}

/**
 * What the paid gate does with a request that is not from a paying account.
 *
 * `observe` exists for a rollout: it counts and logs the refusals it *would*
 * have made and lets the request through, so an operator can watch a new build
 * of the app reach every phone before the gate starts rejecting anything.
 */
export type PaidGateMode = 'off' | 'observe' | 'enforce'

/** How the paid relay decides who may use its bandwidth. */
export interface PaidGateConfig {
  /** Whether the gate runs, counts only, or refuses. */
  readonly mode: PaidGateMode
  /**
   * Whether a phone with no account at all is allowed through.
   *
   * Off by default: the point of the gate is that the paid relay carries paying
   * accounts. It exists because a client that cannot sign in yet (Android
   * today) would otherwise be locked out of a relay its computer is attached
   * to.
   */
  readonly allowUnaccounted: boolean
  /** How long a verified entitlement may be reused, in ms. */
  readonly cacheTtlMs: number
  /**
   * Refuse to start a paid relay whose gate is not actually protecting it.
   *
   * The rollout modes are deliberate and useful, which is exactly why they are
   * also the way a paywall ships turned off: `observe` counts instead of
   * refusing, and `allowUnaccounted` waves through callers with no account. A
   * relay that calls itself the paid one and runs either way is billing its
   * owners for bandwidth it gives away. When this is on, that combination is a
   * start-up failure instead of a log line an operator has to notice.
   */
  readonly strict?: boolean
}

/**
 * The data-plane abuse limits, and the traffic anomaly threshold.
 *
 * These are the knobs that turn the relay from "records every byte of a theft"
 * into "refuses the theft as it happens". They are optional on
 * {@link RelayConfig} so a hand-written config or an older test fixture keeps
 * working; {@link resolveAbuse} fills the safe defaults when the block is
 * absent. The defaults enforce rather than observe -- a limit that defaults to
 * off is a limit nobody turns on.
 */
export interface AbuseLimits {
  /** Sustained data-plane requests per minute per identity. `0` disables. */
  readonly requestsPerMinute: number
  /** Burst allowance for the request bucket; `0` picks a derived default. */
  readonly burst: number
  /** Carried bytes per identity per UTC day. `0` disables. */
  readonly bytesPerDay: number
  /** Global UDP probe replies per second. Bounds a spoofed-source reflector. */
  readonly probeRepliesPerSecond: number
  /** UDP probe replies per source address per second. */
  readonly probeRepliesPerSecondPerSource: number
  /** Per-identity bytes in one day that raises a traffic anomaly. `0` disables. */
  readonly trafficAlertBytesPerDay: number
  /** The same threshold for a paid account; free accounts use the field above. */
  readonly trafficAlertBytesPerDayPaid: number
  /** Day-over-day growth multiple that raises a spike anomaly. */
  readonly trafficAlertGrowthFactor: number
}

/** The `abuse` block as it appears in the config file; every field optional. */
export interface AbuseFileConfig {
  readonly requestsPerMinute?: number
  readonly burst?: number
  readonly bytesPerDay?: number
  readonly probeRepliesPerSecond?: number
  readonly probeRepliesPerSecondPerSource?: number
  readonly trafficAlertBytesPerDay?: number
  readonly trafficAlertBytesPerDayPaid?: number
  readonly trafficAlertGrowthFactor?: number
}

/**
 * The enforced defaults for {@link AbuseLimits}.
 *
 * One identity may move 500 MiB a day and make 300 requests a minute -- the
 * free plan's allowance, which is far below what saturates an uplink. A paid
 * relay raises `bytesPerDay` to 5 GiB in its own config; its warning threshold
 * for paid accounts is `trafficAlertBytesPerDayPaid`, while free accounts it
 * aggregates from the free relay stay on the 500 MiB default.
 */
export const DEFAULT_ABUSE: AbuseLimits = {
  requestsPerMinute: 300,
  burst: 0,
  bytesPerDay: 500 * 1024 * 1024,
  probeRepliesPerSecond: 200,
  probeRepliesPerSecondPerSource: 5,
  trafficAlertBytesPerDay: 500 * 1024 * 1024,
  trafficAlertBytesPerDayPaid: 5 * 1024 * 1024 * 1024,
  trafficAlertGrowthFactor: 8,
}

/** What the account service needs to run. */
export interface AccountsConfig {
  /** Whether this relay serves accounts/admin/traffic aggregation. */
  readonly enabled: boolean
  /** Where `accounts.json`/`invites.json`/`traffic.json` live. */
  readonly dataDir: string
  /** scrypt hash of the admin password, generated by the installer. */
  readonly adminPasswordHash: string
  /** Shared secret for relay-to-relay traffic reports. */
  readonly internalSecret: string
  /** Where to POST traffic batches (a free relay points at the account relay). */
  readonly reportTo: string
  /** This relay's id in the traffic report. */
  readonly reportId: string
  /** How the paid relay treats a phone that is not paying for it. */
  readonly paidGate: PaidGateConfig
  /** Gravatar lookup policy. */
  readonly gravatar: GravatarConfig
  /** Apple identity-token audiences (the bundle id). */
  readonly appleAudiences: readonly string[]
  /** Apple JWKS endpoint. */
  readonly appleKeysURL: string
  /** App Store subscription policy. */
  readonly appstore: AppStoreConfig
  /** Public origin used in admin/docs, without a trailing slash. */
  readonly publicBaseURL: string
  /** GitHub sign-in, or `null` when it is off. */
  readonly github: GitHubConfig | null
}

/** The file-shaped `github` object, where every field is optional. */
export interface GitHubFileConfig {
  readonly enabled?: boolean
  readonly clientId?: string
  readonly clientSecret?: string
  readonly callbackURL?: string
}

/** The GitHub sign-in policy, resolved. */
export interface GitHubConfig {
  readonly enabled: boolean
  readonly clientId: string
  readonly clientSecret: string
  readonly callbackURL: string
}

/** The file-shaped `accounts` object, where every field is optional. */
export interface AccountsFileConfig {
  readonly enabled?: boolean
  readonly dataDir?: string
  readonly adminPasswordHash?: string
  readonly internalSecret?: string
  readonly reportTo?: string
  readonly reportId?: string
  readonly gravatar?: {
    readonly enabled?: boolean
    readonly baseURLs?: readonly string[]
  }
  readonly appleAudiences?: readonly string[]
  readonly appleKeysURL?: string
  readonly paidGate?: {
    /** `true`/`false` are accepted as shorthand for `enforce`/`off`. */
    readonly mode?: PaidGateMode | boolean
    readonly allowUnaccounted?: boolean
    readonly cacheTtlMs?: number
    /**
     * Refuse to start when the gate is not actually protecting a paid relay.
     * See {@link gateStartupChecks}.
     */
    readonly strict?: boolean
  }
  readonly appstore?: {
    readonly bundleId?: string
    readonly productId?: string
    readonly allowSandbox?: boolean
    readonly notificationsEnabled?: boolean
  }
  readonly publicBaseURL?: string
  readonly github?: GitHubFileConfig
}

/**
 * The `fcm` object as it appears in the config file.
 *
 * A superset of {@link FcmConfig}: the file may carry the whole service-account
 * JSON, either inline or as a path to the downloaded file, which is the shape
 * a Firebase console actually hands out. The individual fields are for a
 * deployment that would rather keep them apart -- a container's secret store
 * usually mounts them that way.
 */
export interface FcmFileConfig {
  /** The service-account JSON, whole, inline. `\n` is unescaped for you. */
  readonly serviceAccount?: string
  /** Or a path to the downloaded service-account JSON. */
  readonly serviceAccountFile?: string
  /** The Firebase project id, when not read from the service account. */
  readonly projectId?: string
  /** The service account's address, when not read from the service account. */
  readonly clientEmail?: string
  /** The service account's private key PEM, when not read from the service account. */
  readonly privateKey?: string
  /** The Android notification channel the app created. */
  readonly channelId?: string
  /** Override Google's origins. Tests only. */
  readonly authority?: string
}

/** Where the config file lives unless overridden. */
export const DEFAULT_CONFIG_PATH = 'relay.config.json'

/**
 * Read configuration from a file plus the environment.
 *
 * Environment wins, so a container can override a mounted file without rewriting
 * it. An empty value is treated as absent rather than as an empty string, which
 * is what an unset Docker variable looks like.
 *
 * The only failure that stops this is a config file that exists and cannot be
 * parsed; an absent file is normal, because every value has an environment
 * override and a default. An empty token list is not an error either -- it is
 * the self-registration mode the relay ships in.
 *
 * @param path - the config file path.
 * @param env - the environment to read overrides from.
 * @returns the resolved configuration.
 * @throws when a config file is present but unreadable, so a typo in it is not
 *   silently served by the defaults.
 */
export function loadConfig(
  path: string = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  let file: Partial<RelayConfig> = {}
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Partial<RelayConfig>
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    // No file is fine: everything may come from the environment.
  }

  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)

  const rawTokens = pick(env['MIZAR_RELAY_TOKENS'], file.tokens?.join(','), '')
  const tokens = rawTokens
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')

  // Resolved before the object below because the paid gate's default depends on
  // it: only the paid relay gates, and only when it also owns the account store.
  const role = readRole(pick(env['MIZAR_RELAY_ROLE'], file.role, 0))

  return {
    port: Number(pick(env['MIZAR_RELAY_PORT'], file.port, 8787)),
    host: pick(env['MIZAR_RELAY_HOST'], file.host, '127.0.0.1'),
    tokens,
    trustProxy: flag(pick(env['MIZAR_RELAY_TRUST_PROXY'], file.trustProxy, true)),
    maxTunnelsPerIp: Number(pick(env['MIZAR_RELAY_MAX_TUNNELS_PER_IP'], file.maxTunnelsPerIp, 4)),
    maxRooms: Number(pick(env['MIZAR_RELAY_MAX_ROOMS'], file.maxRooms, 10_000)),
    maxBodyBytes: Number(pick(env['MIZAR_RELAY_MAX_BODY'], file.maxBodyBytes, 4 * 1024 * 1024)),
    maxMessageBytes: Number(
      pick(env['MIZAR_RELAY_MAX_MESSAGE'], file.maxMessageBytes, 900 * 1024),
    ),
    maxClientsPerRoom: Number(pick(env['MIZAR_RELAY_MAX_CLIENTS'], file.maxClientsPerRoom, 8)),
    requestTimeoutMs: Number(pick(env['MIZAR_RELAY_REQUEST_TIMEOUT'], file.requestTimeoutMs, 30_000)),
    tunnelIdleMs: Number(pick(env['MIZAR_RELAY_TUNNEL_IDLE'], file.tunnelIdleMs, 90_000)),
    probePort: Number(pick(env['MIZAR_RELAY_PROBE_PORT'], file.probePort, 8788)),
    stunPort: Number(pick(env['MIZAR_RELAY_STUN_PORT'], file.stunPort, 3478)),
    apns: readApns(env, file.apns ?? null),
    fcm: readFcm(env, (file.fcm ?? null) as FcmFileConfig | null),
    role,
    accounts: readAccounts(env, (file.accounts ?? null) as AccountsFileConfig | null, role),
    abuse: readAbuse(env, (file.abuse ?? null) as AbuseFileConfig | null),
    mail: readMail(env, (file.mail ?? null) as MailFileConfig | null),
  }
}

/** The `mail` block as it appears in the config file; every field optional. */
interface MailFileConfig {
  readonly role?: MailRole
  readonly transport?: MailTransportKind
  readonly service?: {
    readonly url?: string
    readonly token?: string
    readonly allowFrom?: readonly string[]
  }
  readonly smtp?: {
    readonly host?: string
    readonly port?: number
    readonly secure?: boolean
    readonly user?: string
  }
  readonly tencent?: {
    readonly secretId?: string
    readonly region?: string
    readonly templateIds?: {
      readonly verification?: number
      readonly warning?: number
      readonly banned?: number
    }
  }
  readonly from?: { readonly address?: string; readonly name?: string }
  readonly contact?: string
  readonly limits?: { readonly perRecipientPerHour?: number; readonly globalPerHour?: number }
}

/**
 * Resolve the mail block.
 *
 * Secrets are read from the environment first so a config file can be committed
 * without a password in it. An absent block is `null`: no mail, no editor.
 */
function readMail(env: NodeJS.ProcessEnv, file: MailFileConfig | null): MailConfig | null {
  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)
  const role = pick(env['MIZAR_MAIL_ROLE'], file?.role, 'off')
  if (role === 'off') return null
  const transport = pick(env['MIZAR_MAIL_TRANSPORT'], file?.transport, 'tencent-ses')
  const allowFrom = (env['MIZAR_MAIL_ALLOW_FROM'] ?? file?.service?.allowFrom?.join(',') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  const config: MailConfig = {
    role,
    transport,
    service: {
      url: (env['MIZAR_MAIL_SERVICE_URL'] ?? file?.service?.url ?? '').replace(/\/+$/, ''),
      token: env['MIZAR_MAIL_SERVICE_TOKEN'] ?? file?.service?.token ?? '',
      allowFrom,
    },
    smtp: {
      host: env['MIZAR_SMTP_HOST'] ?? file?.smtp?.host ?? '',
      port: Number(pick(env['MIZAR_SMTP_PORT'], file?.smtp?.port, 465)),
      secure: flag(pick(env['MIZAR_SMTP_SECURE'], file?.smtp?.secure, true)),
      user: env['MIZAR_SMTP_USER'] ?? file?.smtp?.user ?? '',
      password: env['MIZAR_SMTP_PASSWORD'] ?? '',
    },
    tencent: {
      secretId: env['MIZAR_TENCENT_SECRET_ID'] ?? file?.tencent?.secretId ?? '',
      secretKey: env['MIZAR_TENCENT_SECRET_KEY'] ?? '',
      region: env['MIZAR_TENCENT_REGION'] ?? file?.tencent?.region ?? 'ap-hongkong',
      templateIds: {
        verification: Number(
          pick(
            env['MIZAR_TENCENT_TEMPLATE_VERIFICATION'],
            file?.tencent?.templateIds?.verification,
            0,
          ),
        ),
        warning: Number(
          pick(env['MIZAR_TENCENT_TEMPLATE_WARNING'], file?.tencent?.templateIds?.warning, 0),
        ),
        banned: Number(
          pick(env['MIZAR_TENCENT_TEMPLATE_BANNED'], file?.tencent?.templateIds?.banned, 0),
        ),
      },
    },
    from: {
      address: env['MIZAR_MAIL_FROM_ADDRESS'] ?? file?.from?.address ?? 'noreply@shirazu-nagisa.com',
      name: env['MIZAR_MAIL_FROM_NAME'] ?? file?.from?.name ?? 'DSH-Mizar',
    },
    contact: env['MIZAR_MAIL_CONTACT'] ?? file?.contact ?? 'shirazunagisa@icloud.com',
    limits: {
      perRecipientPerHour: Number(
        pick(env['MIZAR_MAIL_PER_RECIPIENT_HOUR'], file?.limits?.perRecipientPerHour, 5),
      ),
      globalPerHour: Number(
        pick(env['MIZAR_MAIL_GLOBAL_HOUR'], file?.limits?.globalPerHour, 200),
      ),
    },
  }
  if (role === 'client') {
    if (config.service.url === '' || config.service.token === '') {
      throw new Error('mail.role is "client" but mail.service.url/token are missing')
    }
  }
  if (role === 'service') {
    if (config.transport === 'tencent-ses') {
      const missing = [
        config.tencent.secretId === '' ? 'secretId' : '',
        config.tencent.secretKey === '' ? 'secretKey' : '',
        config.tencent.templateIds.verification === 0 ? 'templateIds.verification' : '',
        config.tencent.templateIds.warning === 0 ? 'templateIds.warning' : '',
        config.tencent.templateIds.banned === 0 ? 'templateIds.banned' : '',
      ].filter((value) => value !== '')
      if (missing.length > 0) {
        throw new Error(`mail service (tencent-ses) is missing: ${missing.join(', ')}`)
      }
    } else if (config.smtp.host === '' || config.smtp.user === '' || config.smtp.password === '') {
      throw new Error('mail service (smtp) needs host, user and MIZAR_SMTP_PASSWORD')
    }
  }
  return config
}

/**
 * Resolve the data-plane abuse limits.
 *
 * An absent block is the normal state for every deployment that predates the
 * limits, so it resolves to {@link DEFAULT_ABUSE} rather than to "no limits":
 * a limit that defaults to off is a limit nobody turns on. `0` is the explicit
 * way to disable one of them, which an operator has to type.
 */
function readAbuse(env: NodeJS.ProcessEnv, file: AbuseFileConfig | null): AbuseLimits {
  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)
  const num = (fromEnv: string | undefined, fromFile: number | undefined, fallback: number): number => {
    const value = Number(pick(fromEnv, fromFile, fallback))
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    requestsPerMinute: num(
      env['MIZAR_ABUSE_REQUESTS_PER_MINUTE'],
      file?.requestsPerMinute,
      DEFAULT_ABUSE.requestsPerMinute,
    ),
    burst: num(env['MIZAR_ABUSE_BURST'], file?.burst, DEFAULT_ABUSE.burst),
    bytesPerDay: num(env['MIZAR_ABUSE_BYTES_PER_DAY'], file?.bytesPerDay, DEFAULT_ABUSE.bytesPerDay),
    probeRepliesPerSecond: num(
      env['MIZAR_ABUSE_PROBE_REPLIES_PER_SECOND'],
      file?.probeRepliesPerSecond,
      DEFAULT_ABUSE.probeRepliesPerSecond,
    ),
    probeRepliesPerSecondPerSource: num(
      env['MIZAR_ABUSE_PROBE_REPLIES_PER_SOURCE'],
      file?.probeRepliesPerSecondPerSource,
      DEFAULT_ABUSE.probeRepliesPerSecondPerSource,
    ),
    trafficAlertBytesPerDay: num(
      env['MIZAR_ABUSE_TRAFFIC_ALERT_BYTES'],
      file?.trafficAlertBytesPerDay,
      DEFAULT_ABUSE.trafficAlertBytesPerDay,
    ),
    trafficAlertBytesPerDayPaid: num(
      env['MIZAR_ABUSE_TRAFFIC_ALERT_BYTES_PAID'],
      file?.trafficAlertBytesPerDayPaid,
      DEFAULT_ABUSE.trafficAlertBytesPerDayPaid,
    ),
    trafficAlertGrowthFactor: num(
      env['MIZAR_ABUSE_TRAFFIC_ALERT_GROWTH'],
      file?.trafficAlertGrowthFactor,
      DEFAULT_ABUSE.trafficAlertGrowthFactor,
    ),
  }
}

/**
 * Fill the abuse limits for a config that was built by hand.
 *
 * `loadConfig` always produces them, but tests and embedders construct
 * `RelayConfig` literals. Rather than making the field required -- which would
 * break every one of those literals for a block most of them do not care about
 * -- the relay asks for its limits through this and gets the enforced defaults.
 */
export function resolveAbuse(config: RelayConfig): AbuseLimits {
  return config.abuse ?? DEFAULT_ABUSE
}

/**
 * Whether a paid relay's gate is actually protecting it.
 *
 * The two ways a paywall ships open are `observe` (counts and lets through) and
 * `allowUnaccounted` (waves callers with no account through). Both are
 * deliberate rollout tools and both silently give away the bandwidth the relay
 * is supposed to sell, so this is the check that turns either one from a log
 * line into a start-up refusal when the operator asks for it with
 * `paidGate.strict`.
 *
 * @param config - the resolved configuration.
 * @returns the problems found, empty when the gate is enforcing. Each string is
 *   specific enough to act on without reading the code.
 */
export function gateStartupChecks(config: RelayConfig): string[] {
  const accounts = config.accounts
  if (accounts === null || !accounts.enabled) return []
  // A free relay (role 0) is not supposed to gate -- it has no paid users to
  // gate for -- so its gate state is not a problem, whatever it is.
  if (config.role !== 1) return []
  const problems: string[] = []
  const gate = accounts.paidGate
  if (gate.mode === 'off') {
    problems.push(
      'paidGate.mode is "off": this relay calls itself the paid one and carries every caller, ' +
        'paying or not. Set paidGate.mode="enforce" (or delete the paidGate block, which defaults to enforce).',
    )
  } else if (gate.mode === 'observe') {
    problems.push(
      'paidGate.mode is "observe": the gate counts refusals but lets them through, which is a ' +
        'rollout tool and not a paywall. Switch to "enforce" once the phones have been watched.',
    )
  }
  if (gate.allowUnaccounted) {
    problems.push(
      'paidGate.allowUnaccounted is true: any caller with no account at all is carried for free. ' +
        'Turn it off unless a client that cannot sign in yet has to reach this relay.',
    )
  }
  return problems
}

/**
 * Read the relay role.
 *
 * Only `0` (free) and `1` (paid) are meaningful. A typo must not silently turn
 * a paid relay into a free one or the other way around, so anything else is a
 * startup failure rather than a default.
 *
 * @param value - the file or environment value.
 * @returns the role.
 * @throws when the value is not 0 or 1.
 */
function readRole(value: unknown): 0 | 1 {
  const parsed = Number(value)
  if (parsed !== 0 && parsed !== 1) {
    throw new Error(`role must be 0 (free relay) or 1 (paid relay), got ${String(value)}`)
  }
  return parsed
}

/**
 * Resolve the account service configuration.
 *
 * An absent block is the normal state for every relay that is not the account
 * relay, and for every deployment older than accounts. It stays `null` rather
 * than becoming a block full of defaults so the rest of the process can ask one
 * question -- "does this relay serve accounts?" -- and the answer is exactly
 * the operator's.
 *
 * @param env - the environment.
 * @param file - the `accounts` object from the config file, when present.
 * @param role - the relay's role, which decides the paid gate's default.
 * @returns the configuration, or `null` when accounts are not configured.
 */
function readAccounts(
  env: NodeJS.ProcessEnv,
  file: AccountsFileConfig | null,
  role: 0 | 1,
): AccountsConfig | null {
  if (file === null) return null
  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)
  const commaList = (value: string, fallback: readonly string[]): readonly string[] => {
    if (value === '') return fallback
    const list = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    return list.length === 0 ? fallback : list
  }

  const gravatar = file.gravatar ?? {}
  const appstore = file.appstore ?? {}
  const enabled = flagOr(pick(env['MIZAR_ACCOUNTS_ENABLED'], file.enabled, false), false)
  const publicBaseURL = pick(env['MIZAR_ACCOUNT_PUBLIC_BASE_URL'], file.publicBaseURL, '')
  const githubFile = file.github ?? {}
  const githubEnabled = flagOr(pick(env['MIZAR_GITHUB_ENABLED'], githubFile.enabled, false), false)
  const githubClientId = pick(env['MIZAR_GITHUB_CLIENT_ID'], githubFile.clientId, '')
  const githubClientSecret = pick(env['MIZAR_GITHUB_CLIENT_SECRET'], githubFile.clientSecret, '')
  // The callback lives on the same origin the accounts surface does, so a
  // deployment that already told the relay its public origin gets the right
  // default; the manual still pins the exact URL in the OAuth App.
  const githubCallbackURL = pick(
    env['MIZAR_GITHUB_CALLBACK_URL'],
    githubFile.callbackURL,
    publicBaseURL === '' ? '' : `${publicBaseURL}/account/v1/github/callback`,
  )
  if (githubEnabled) {
    const missing: string[] = []
    if (githubClientId === '') missing.push('clientId')
    if (githubClientSecret === '') missing.push('clientSecret')
    if (githubCallbackURL === '') missing.push('callbackURL')
    if (missing.length > 0) {
      throw new Error(
        `accounts.github needs clientId, clientSecret and callbackURL; missing: ${missing.join(', ')}`,
      )
    }
  }
  if (githubFile.clientSecret !== undefined && githubFile.clientSecret !== '') {
    // The manual's rule: the secret lives in the environment file with mode 600,
    // not in a config file that is easier to copy or commit by accident.
    console.warn(
      'accounts.github.clientSecret is set in the config file; prefer MIZAR_GITHUB_CLIENT_SECRET in the environment',
    )
  }
  return {
    enabled,
    dataDir: pick(env['MIZAR_ACCOUNTS_DATA_DIR'], file.dataDir, './data'),
    adminPasswordHash: pick(env['MIZAR_ADMIN_PASSWORD_HASH'], file.adminPasswordHash, ''),
    internalSecret: pick(env['MIZAR_ACCOUNT_INTERNAL_SECRET'], file.internalSecret, ''),
    reportTo: pick(env['MIZAR_ACCOUNT_REPORT_TO'], file.reportTo, ''),
    reportId: pick(env['MIZAR_ACCOUNT_REPORT_ID'], file.reportId, ''),
    paidGate: readPaidGate(env, file.paidGate ?? {}, role, enabled),
    gravatar: {
      enabled: flagOr(pick(env['MIZAR_ACCOUNTS_GRAVATAR'], gravatar.enabled, true), true),
      baseURLs: commaList(
        String(pick(env['MIZAR_GRAVATAR_BASE_URLS'], undefined as string | undefined, '')),
        gravatar.baseURLs ?? ['https://www.gravatar.com'],
      ),
    },
    appleAudiences: commaList(
      String(pick(env['MIZAR_APPLE_AUDIENCES'], undefined as string | undefined, '')),
      file.appleAudiences ?? ['me.shirazu.dshmizar'],
    ),
    appleKeysURL: pick(
      env['MIZAR_APPLE_KEYS_URL'],
      file.appleKeysURL,
      'https://appleid.apple.com/auth/keys',
    ),
    appstore: {
      bundleId: pick(env['MIZAR_APPSTORE_BUNDLE_ID'], appstore.bundleId, 'me.shirazu.dshmizar'),
      productId: pick(
        env['MIZAR_APPSTORE_PRODUCT_ID'],
        appstore.productId,
        'me.shirazu.dshmizar.paid.monthly',
      ),
      allowSandbox: flagOr(pick(env['MIZAR_APPSTORE_ALLOW_SANDBOX'], appstore.allowSandbox, true), true),
      notificationsEnabled: flagOr(
        pick(env['MIZAR_APPSTORE_NOTIFICATIONS'], appstore.notificationsEnabled, true),
        true,
      ),
    },
    publicBaseURL,
    github: githubEnabled
      ? { enabled: true, clientId: githubClientId, clientSecret: githubClientSecret, callbackURL: githubCallbackURL }
      : null,
  }
}

/**
 * Resolve the paid gate.
 *
 * The default is the whole policy in one line: a relay that owns the account
 * store and calls itself the paid one gates, and everything else does not. A
 * free relay has no store to check against, so `enforce` there would be a
 * startup failure rather than a gate that silently lets everybody through --
 * a protection that reports itself as on and is not is worse than none.
 *
 * @param env - the environment.
 * @param file - the `paidGate` object from the config file, when present.
 * @param role - the relay's role.
 * @param accountsEnabled - whether the account store runs on this relay.
 * @returns the gate configuration.
 * @throws when the gate is asked to enforce without a store to enforce with.
 */
function readPaidGate(
  env: NodeJS.ProcessEnv,
  file: NonNullable<AccountsFileConfig['paidGate']>,
  role: 0 | 1,
  accountsEnabled: boolean,
): PaidGateConfig {
  const raw = env['MIZAR_PAID_GATE'] !== undefined && env['MIZAR_PAID_GATE'] !== ''
    ? env['MIZAR_PAID_GATE']
    : file.mode
  const fallback: PaidGateMode = accountsEnabled && role === 1 ? 'enforce' : 'off'
  const mode = parsePaidGateMode(raw, fallback)
  if (mode !== 'off' && !accountsEnabled) {
    throw new Error(
      `paidGate.mode is "${mode}" but accounts.enabled is false; ` +
        'the gate has no account store to verify against. Set accounts.enabled=true, ' +
        'or paidGate.mode="off".',
    )
  }
  const ttlRaw = Number(
    env['MIZAR_PAID_GATE_CACHE_TTL'] !== undefined && env['MIZAR_PAID_GATE_CACHE_TTL'] !== ''
      ? env['MIZAR_PAID_GATE_CACHE_TTL']
      : (file.cacheTtlMs ?? 60_000),
  )
  const cacheTtlMs = Number.isFinite(ttlRaw) ? Math.min(600_000, Math.max(0, Math.round(ttlRaw))) : 60_000
  return {
    mode,
    allowUnaccounted: flagOr(
      env['MIZAR_PAID_GATE_ALLOW_UNACCOUNTED'] !== undefined &&
        env['MIZAR_PAID_GATE_ALLOW_UNACCOUNTED'] !== ''
        ? env['MIZAR_PAID_GATE_ALLOW_UNACCOUNTED']
        : (file.allowUnaccounted ?? false),
      false,
    ),
    cacheTtlMs,
    strict: flagOr(
      env['MIZAR_PAID_GATE_STRICT'] !== undefined && env['MIZAR_PAID_GATE_STRICT'] !== ''
        ? env['MIZAR_PAID_GATE_STRICT']
        : (file.strict ?? false),
      false,
    ),
  }
}

/**
 * Read a gate mode.
 *
 * Booleans are accepted because `"mode": true` is the shortest thing an
 * operator can write and means exactly what it looks like. Anything else that
 * is not a mode is an error: a typo must not quietly disable a paywall.
 *
 * @param value - the file or environment value.
 * @param fallback - the answer when nothing was set.
 * @returns the mode.
 * @throws when the value is not a mode.
 */
function parsePaidGateMode(value: unknown, fallback: PaidGateMode): PaidGateMode {
  if (value === undefined || value === '') return fallback
  if (typeof value === 'boolean') return value ? 'enforce' : 'off'
  const text = String(value).trim().toLowerCase()
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return 'enforce'
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return 'off'
  if (text === 'observe' || text === 'enforce') return text
  throw new Error(`paidGate.mode must be off, observe or enforce, got ${String(value)}`)
}

/**
 * Read a boolean whose default may be `false`.
 *
 * {@link flag} defaults to true because the options it was written for are
 * on-by-default. Accounts are the other way round, and an absent variable must
 * mean "off" there.
 *
 * @param value - the file or environment value.
 * @param fallback - the answer when nothing was set.
 * @returns the resolved boolean.
 */
function flagOr(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

/**
 * Read a boolean that arrives as a JSON `true`/`false` or as an environment
 * string.
 *
 * `MIZAR_RELAY_TRUST_PROXY=0`, `false`, `no` and `off` all turn the option off;
 * anything else on non-empty turns it on. The point is that a container's
 * `MIZAR_RELAY_TRUST_PROXY=false` must not be read as a truthy string, which is
 * the way a plain `Boolean(...)` gets this wrong.
 */
function flag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === '') return true
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

/**
 * Resolve the APNs half of the configuration.
 *
 * The `.p8` key arrives either inline or as a path, and inline is supported
 * because that is what a container's secret store usually gives you. The `\n`
 * unescaping is for the same place: a PEM pasted into an environment variable
 * has its newlines written as two characters, and a key that is nearly right is
 * one that fails at signing time with a message about PEM parsing rather than
 * about the environment.
 *
 * @param env - the environment.
 * @param file - the `apns` object from the config file, when present.
 * @returns the configuration, or `null` when this relay does not push.
 */
function readApns(
  env: NodeJS.ProcessEnv,
  file: Partial<ApnsConfig> | null,
): ApnsConfig | null {
  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)

  const keyId = pick(env['MIZAR_APNS_KEY_ID'], file?.keyId, '')
  const teamId = pick(env['MIZAR_APNS_TEAM_ID'], file?.teamId, '')
  const topic = pick(env['MIZAR_APNS_TOPIC'], file?.topic, '')
  const inline = pick(env['MIZAR_APNS_KEY'], file?.key, '')
  const path = pick(env['MIZAR_APNS_KEY_FILE'], undefined, '')

  let key = inline.replace(/\\n/g, '\n')
  if (key === '' && path !== '') {
    try {
      key = readFileSync(path, 'utf8')
    } catch {
      // Treated as "not configured" rather than as a startup failure: a relay
      // that refuses to boot because a notification key is missing takes the
      // tunnel down with it, and the tunnel is the part that matters.
      return null
    }
  }

  if (key === '' || keyId === '' || teamId === '' || topic === '') return null

  const environment: string = pick(env['MIZAR_APNS_ENV'], undefined as string | undefined, 'production')
  return {
    key,
    keyId,
    teamId,
    topic,
    production: environment !== 'sandbox',
    ...(env['MIZAR_APNS_TIME_SENSITIVE'] === '1' ||
    env['MIZAR_APNS_TIME_SENSITIVE'] === 'true'
      ? { timeSensitive: true }
      : {}),
  }
}

/**
 * Resolve the FCM half of the configuration.
 *
 * The service account is the awkward part: Firebase hands out a JSON file whose
 * three interesting fields are exactly the three this client needs, so both
 * shapes are accepted -- the file (inline or by path) with the fields read out
 * of it, or the fields on their own, which wins when both are present. The `\n`
 * unescaping is for the same place it is in {@link readApns}: a PEM pasted into
 * an environment variable has its newlines written as two characters, and a key
 * that is nearly right fails at signing time with a message about RSA keys
 * rather than about the environment.
 *
 * Incomplete means `null`, not a startup failure. A relay that refuses to boot
 * because a notification credential is missing takes the tunnel down with it,
 * and the tunnel is the part that matters -- a missing or malformed service
 * account shows up as `"fcm": false` on `/healthz` and one log line per room
 * notified, rather than as a relay that is not running.
 *
 * @param env - the environment.
 * @param file - the `fcm` object from the config file, when present.
 * @returns the configuration, or `null` when this relay does not push to Android.
 */
function readFcm(env: NodeJS.ProcessEnv, file: FcmFileConfig | null): FcmConfig | null {
  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)

  const inline = pick(env['MIZAR_FCM_SERVICE_ACCOUNT'], file?.serviceAccount, '')
  const path = pick(env['MIZAR_FCM_SERVICE_ACCOUNT_FILE'], file?.serviceAccountFile, '')

  let account: Record<string, unknown> = {}
  if (inline !== '') {
    const parsed = parseServiceAccount(inline)
    if (parsed === null) return null
    account = parsed
  } else if (path !== '') {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      // See the comment above: not configured, not a reason to stop the tunnel.
      return null
    }
    const parsed = parseServiceAccount(text)
    if (parsed === null) return null
    account = parsed
  }

  const projectId = pick(env['MIZAR_FCM_PROJECT_ID'], file?.projectId, text(account, 'project_id'))
  const clientEmail = pick(env['MIZAR_FCM_CLIENT_EMAIL'], file?.clientEmail, text(account, 'client_email'))
  const privateKey = pick(
    env['MIZAR_FCM_PRIVATE_KEY'],
    file?.privateKey,
    text(account, 'private_key'),
  ).replace(/\\n/g, '\n')
  const channelId = pick(env['MIZAR_FCM_CHANNEL_ID'], file?.channelId, '')
  const authority = pick(env['MIZAR_FCM_AUTHORITY'], file?.authority, '')

  if (projectId === '' || clientEmail === '' || privateKey === '') return null

  return {
    projectId,
    clientEmail,
    privateKey,
    ...(channelId === '' ? {} : { channelId }),
    ...(authority === '' ? {} : { authority }),
  }
}

/**
 * Parse a service-account JSON body.
 *
 * No unescaping here: `JSON.parse` already turns the `\n` inside the JSON's
 * `private_key` string into a real newline, and the one place a doubly-escaped
 * PEM still needs fixing is {@link readFcm}'s final `replace`, which sees the
 * extracted key whichever way it arrived.
 */
function parseServiceAccount(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** One string field of a service account, or `''` when it is not a string. */
function text(account: Record<string, unknown>, key: string): string {
  const value = account[key]
  return typeof value === 'string' ? value : ''
}
