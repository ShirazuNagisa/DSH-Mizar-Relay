/**
 * The self-hosted relay's own surface: the computer directory and updates.
 *
 * The official deployment answers "which of my computers are online" from its
 * account service. A relay on a user's own server has no accounts -- that is the
 * point of it -- so the relay keeps a small directory instead: every tunnel says
 * who it is on the upgrade, and a phone lists it with one server PIN. Discovered
 * is not the same as trusted: tapping a computer in that list still needs the
 * single-use code the computer itself shows.
 *
 * The other half is updates. A self-hosted relay is expected to stay current
 * without anybody SSHing in, so a GitHub release is the source of truth and one
 * token -- printed once at install, stored only as a hash -- is what lets the
 * setup page start one. The updater itself is a shell script, not Node: swapping
 * the app out from under the process that is running it is the one job a service
 * cannot do to itself.
 *
 * @module dsh-mizar-relay/selfhost
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { verifyPassword } from './accounts/passwords.js'
import { clientAddress } from './client-address.js'
import { DEFAULT_GITHUB_REPO, type SelfHostConfig } from './config.js'
import { writeJson } from './http.js'
import { TUNNEL_PROTOCOL_VERSION } from './protocol.js'
import { RELAY_VERSION } from './version.js'

/** One computer that is online, as a phone's list shows it. */
export interface DesktopEntry {
  /** The room the phone dials; this is the discovery half, not the trust half. */
  readonly room: string
  /** The computer's stable id, when it sent one. */
  readonly deviceId: string
  /** Its display name, already decoded. */
  readonly name: string
  /** `macos`, `windows`, `linux`, or `unknown`. */
  readonly platform: string
  /** When this tunnel attached, in epoch milliseconds. */
  readonly onlineSince: number
}

/** A directory entry plus the ticket that keeps a stale close from deleting it. */
interface TicketedEntry extends DesktopEntry {
  readonly ticket: number
}

/** Platforms a computer may report; anything else is reported as `unknown`. */
const KNOWN_PLATFORMS = new Set(['macos', 'windows', 'linux'])

/** Longest display name the directory will carry, in characters. */
const MAX_NAME_LENGTH = 80

/** Most computers one list response will carry. */
const MAX_DIRECTORY_ENTRIES = 500

/**
 * What a computer says about itself when it attaches its tunnel.
 *
 * Sent as request headers on the upgrade, because the relay already reads
 * `x-mizar-client-id` there for the account half and one more header is cheaper
 * than a second handshake. The name is percent-encoded UTF-8: header values are
 * latin-1, and a computer called "办公室的 Mac" is a normal thing to have.
 *
 * @param headers - the upgrade request's headers.
 * @param room - the room the relay derived, which is the key.
 * @param now - the attach time, in epoch milliseconds.
 * @returns the entry to register.
 */
export function readDeviceHeaders(
  headers: IncomingMessage['headers'],
  room: string,
  now: number,
): DesktopEntry {
  const name = decodeHeader(headers['x-mizar-device-name']).slice(0, MAX_NAME_LENGTH)
  const platform = decodeHeader(headers['x-mizar-device-platform']).toLowerCase()
  return {
    room,
    deviceId: decodeHeader(headers['x-mizar-client-id']).slice(0, 128),
    name: name === '' ? 'Computer' : name,
    platform: KNOWN_PLATFORMS.has(platform) ? platform : 'unknown',
    onlineSince: now,
  }
}

/** Read one percent-encoded header, tolerating a value that is not encoded. */
function decodeHeader(value: string | string[] | undefined): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

/**
 * The rooms that are currently attached, keyed by room.
 *
 * Registering the same room again replaces the entry and issues a new ticket, so
 * a tunnel that was displaced and then closes cannot delete its successor's row.
 */
export class DesktopDirectory {
  readonly #entries = new Map<string, TicketedEntry>()
  #nextTicket = 1

  /**
   * Record a computer.
   *
   * @param entry - what the upgrade said.
   * @returns the ticket the caller must present to unregister this exact entry.
   */
  register(entry: DesktopEntry): number {
    const ticket = this.#nextTicket++
    this.#entries.set(entry.room, { ...entry, ticket })
    return ticket
  }

  /**
   * Forget a computer, but only the entry this ticket registered.
   *
   * @param room - the room.
   * @param ticket - what {@link register} returned.
   */
  unregister(room: string, ticket: number): void {
    if (this.#entries.get(room)?.ticket === ticket) this.#entries.delete(room)
  }

  /**
   * The live computers, by name.
   *
   * @param isLive - whether a room's tunnel is still attached; a stale row is
   *   dropped rather than shown as online.
   * @returns the entries, sorted, at most {@link MAX_DIRECTORY_ENTRIES}.
   */
  list(isLive: (room: string) => boolean): DesktopEntry[] {
    const live: DesktopEntry[] = []
    for (const entry of this.#entries.values()) {
      if (!isLive(entry.room)) {
        this.#entries.delete(entry.room)
        continue
      }
      const { ticket: _ticket, ...rest } = entry
      live.push(rest)
    }
    live.sort((left, right) => left.name.localeCompare(right.name))
    return live.slice(0, MAX_DIRECTORY_ENTRIES)
  }

  /** How many entries are held, live or not. Tests use this. */
  get size(): number {
    return this.#entries.size
  }
}

/**
 * A failure counter for one secret, keyed by source address.
 *
 * Both secrets on this surface are short enough to be guessed at -- the PIN is
 * eight characters -- so a correct comparison is not enough; the number of
 * wrong ones has to be bounded too. Only failures count, and a success clears the
 * row, so an operator scanning the list all day never locks themselves out.
 */
export class AttemptGuard {
  readonly #attempts = new Map<string, { count: number; resetAt: number }>()

  /**
   * @param limit - failures allowed inside one window.
   * @param windowMs - how long a failure is remembered.
   */
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Whether this address has used up its failures. */
  blocked(address: string, now: number): boolean {
    const row = this.#attempts.get(address)
    if (row === undefined) return false
    if (row.resetAt <= now) {
      this.#attempts.delete(address)
      return false
    }
    return row.count >= this.limit
  }

  /** Record one failure. */
  fail(address: string, now: number): void {
    const row = this.#attempts.get(address)
    if (row === undefined || row.resetAt <= now) {
      this.#attempts.set(address, { count: 1, resetAt: now + this.windowMs })
      return
    }
    row.count += 1
  }

  /** Forget an address's failures. */
  clear(address: string): void {
    this.#attempts.delete(address)
  }
}

/** One release as the update check found it. */
interface ReleaseCheck {
  readonly latest: string | null
  readonly checkedAt: number
  readonly error: string | null
}

/** What the setup page is told about updates. */
export interface UpdateSnapshot {
  readonly current: string
  readonly latest: string | null
  readonly updateAvailable: boolean
  readonly checkedAt: number | null
  readonly state: string
  readonly error: string | null
}

/** The state file the updater writes. Every field is best-effort. */
interface UpdateStateFile {
  readonly state?: unknown
  readonly latest?: unknown
  readonly error?: unknown
  readonly updatedAt?: unknown
}

/** How long one GitHub answer is reused, in ms. */
const CHECK_TTL_MS = 5 * 60_000

/** How long a running update is believed before its state is treated as stale. */
const UPDATE_STALE_MS = 15 * 60_000

/** States in which the updater owns the installation. */
const BUSY_STATES = new Set(['preparing', 'downloading', 'verifying', 'installing', 'restarting'])

/**
 * Check GitHub for a newer release, and start the updater on request.
 *
 * The network call is injected so tests can run without one, and a failure is
 * data rather than an exception: an update check that cannot reach GitHub must
 * not make the page look broken.
 */
export class UpdateMonitor {
  readonly #repo: string
  readonly #dataDir: string
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #updateScript: string
  #cache: ReleaseCheck | null = null

  /**
   * @param options - repository, data directory, and the seams tests replace.
   */
  constructor(options: {
    readonly repo?: string
    readonly dataDir: string
    readonly fetchImpl?: typeof fetch
    readonly now?: () => number
    readonly updateScript?: string
  }) {
    this.#repo = options.repo ?? DEFAULT_GITHUB_REPO
    this.#dataDir = options.dataDir
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#updateScript = options.updateScript ?? ''
  }

  /**
   * Ask GitHub what the latest release is.
   *
   * @param force - ignore the in-memory cache.
   * @returns the release, or an error worth showing an operator.
   */
  async check(force = false): Promise<ReleaseCheck> {
    const now = this.#now()
    const cached = this.#cache
    if (!force && cached !== null && now - cached.checkedAt < CHECK_TTL_MS) return cached
    const result = await this.#fetchLatest(now)
    this.#cache = result
    return result
  }

  /** The release fetch, kept separate so `check` stays about caching. */
  async #fetchLatest(now: number): Promise<ReleaseCheck> {
    let response: Response
    try {
      response = await this.#fetch(`https://api.github.com/repos/${this.#repo}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `dsh-mizar-relay/${RELAY_VERSION}`,
        },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      return { latest: null, checkedAt: now, error: describe(error) }
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        return {
          latest: null,
          checkedAt: now,
          error: 'GitHub is rate limiting this server; try again later',
        }
      }
      return { latest: null, checkedAt: now, error: `GitHub answered ${response.status}` }
    }
    let tag: unknown
    try {
      tag = (await response.json() as { tag_name?: unknown }).tag_name
    } catch (error) {
      return { latest: null, checkedAt: now, error: describe(error) }
    }
    if (typeof tag !== 'string') {
      return { latest: null, checkedAt: now, error: 'the release had no tag' }
    }
    const latest = tag.replace(/^v/i, '').trim()
    if (!/^\d+\.\d+\.\d+/.test(latest)) {
      return { latest: null, checkedAt: now, error: `the release tag "${tag}" is not a version` }
    }
    return { latest, checkedAt: now, error: null }
  }

  /**
   * The whole picture for the setup page.
   *
   * @param force - refresh the GitHub half even if it is cached.
   * @returns installed version, latest version, and what the updater is doing.
   */
  async snapshot(force = false): Promise<UpdateSnapshot> {
    const state = await this.readState()
    const check = await this.check(force)
    const latest = check.latest
    return {
      current: RELAY_VERSION,
      latest,
      updateAvailable: latest !== null && compareVersions(latest, RELAY_VERSION) > 0,
      checkedAt: check.checkedAt,
      state: state.state,
      error: check.error ?? state.error,
    }
  }

  /** Read the updater's state file, or an idle state when it has never run. */
  async readState(): Promise<{ state: string; latest: string | null; error: string | null; updatedAt: number }> {
    try {
      const text = await readFile(join(this.#dataDir, 'update-state.json'), 'utf8')
      const parsed = JSON.parse(text) as UpdateStateFile
      return {
        state: typeof parsed.state === 'string' ? parsed.state : 'idle',
        latest: typeof parsed.latest === 'string' ? parsed.latest : null,
        error: typeof parsed.error === 'string' ? parsed.error : null,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      }
    } catch {
      return { state: 'idle', latest: null, error: null, updatedAt: 0 }
    }
  }

  /**
   * Hand the installation to the updater.
   *
   * `systemd-run` rather than a child process: a restart of the relay kills its
   * whole cgroup, and an updater inside that cgroup would die in the middle of
   * replacing the files it is running from. A transient unit outlives the
   * service restart it causes.
   *
   * @returns whether the update was started, and why not when it was not.
   */
  async start(): Promise<{ started: boolean; reason?: string }> {
    if (this.#updateScript === '') return { started: false, reason: 'no updater is installed' }
    const state = await this.readState()
    if (BUSY_STATES.has(state.state) && this.#now() - state.updatedAt < UPDATE_STALE_MS) {
      return { started: false, reason: 'an update is already running' }
    }
    return await new Promise((resolve) => {
      const child = spawn(
        'systemd-run',
        [
          // Deliberately not `dsh-mizar-relay-update`: that is the name of the
          // static unit the daily timer runs, and a transient unit cannot
          // shadow it. This one is only for the "update now" button.
          '--unit=dsh-mizar-relay-update-now',
          '--collect',
          '--quiet',
          '--description=DSH-Mizar relay update (setup page)',
          this.#updateScript,
          '--apply',
        ],
        { detached: true, stdio: 'ignore' },
      )
      child.once('error', (error) => {
        resolve({ started: false, reason: `could not start the updater: ${describe(error)}` })
      })
      child.once('spawn', () => {
        child.unref()
        resolve({ started: true })
      })
    })
  }
}

/** Compare two dotted versions; a missing or junk component counts as zero. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => {
        const parsed = Number.parseInt(part, 10)
        return Number.isFinite(parsed) ? parsed : 0
      })
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** What the self-hosting API needs from the relay it is mounted on. */
export interface SelfHostApiDeps {
  readonly config: SelfHostConfig
  readonly directory: DesktopDirectory
  /** Whether a room's tunnel is still attached. */
  readonly isLive: (room: string) => boolean
  readonly trustProxy: boolean
  readonly monitor: UpdateMonitor
  readonly now: () => number
  readonly log: (message: string) => void
}

/** How many wrong secrets one address may present inside one window. */
const SECRET_ATTEMPT_LIMIT = 10

/** How long a wrong secret is remembered, in ms. */
const SECRET_ATTEMPT_WINDOW_MS = 15 * 60_000

/**
 * Build the handler for `/selfhost/v1/*`.
 *
 * @param deps - the directory, the configuration and the seams.
 * @returns a handler that answers its paths and declines everything else.
 */
export function createSelfHostApi(
  deps: SelfHostApiDeps,
): (request: IncomingMessage, response: ServerResponse, pathname: string) => Promise<boolean> {
  const pinGuard = new AttemptGuard(SECRET_ATTEMPT_LIMIT, SECRET_ATTEMPT_WINDOW_MS)
  const tokenGuard = new AttemptGuard(SECRET_ATTEMPT_LIMIT, SECRET_ATTEMPT_WINDOW_MS)

  const addressOf = (request: IncomingMessage): string =>
    clientAddress(request.socket.remoteAddress, request.headers, deps.trustProxy !== false)

  /**
   * Check one secret, counting wrong answers.
   *
   * @param presented - the header value, or `''`.
   * @param hash - the stored scrypt hash, or `''` when this secret is disabled.
   * @param guard - the failure counter that belongs to this secret.
   * @param address - the caller, for the counter.
   * @param missing - the error code to use when nothing was presented.
   * @returns `null` when the caller may continue, or the reason it may not.
   */
  async function requireSecret(
    presented: string,
    hash: string,
    guard: AttemptGuard,
    address: string,
    missing: { status: number; error: string },
  ): Promise<{ status: number; error: string } | null> {
    if (hash === '') return null
    if (guard.blocked(address, deps.now())) {
      deps.log(`selfhost: ${address} is presenting too many wrong secrets; refusing for now`)
      return { status: 429, error: 'TOO_MANY_ATTEMPTS' }
    }
    if (presented === '') return missing
    if (!(await verifyPassword(presented, hash))) {
      guard.fail(address, deps.now())
      return { status: 403, error: 'SECRET_INVALID' }
    }
    guard.clear(address)
    return null
  }

  return async (request, response, pathname) => {
    if (!pathname.startsWith('/selfhost/v1/')) return false
    const address = addressOf(request)
    if (pathname === '/selfhost/v1/desktops') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return true
      }
      const pin = typeof request.headers['x-mizar-server-pin'] === 'string'
        ? request.headers['x-mizar-server-pin']
        : ''
      const refusal = await requireSecret(pin, deps.config.pinHash, pinGuard, address, {
        status: 401,
        error: 'PIN_REQUIRED',
      })
      if (refusal !== null) {
        writeJson(response, refusal.status, { error: refusal.error })
        return true
      }
      writeJson(response, 200, {
        relay: {
          version: RELAY_VERSION,
          protocol: TUNNEL_PROTOCOL_VERSION,
          publicURL: deps.config.publicURL,
        },
        desktops: deps.directory.list(deps.isLive),
      })
      return true
    }
    if (pathname === '/selfhost/v1/update') {
      const token = typeof request.headers['x-mizar-update-token'] === 'string'
        ? request.headers['x-mizar-update-token']
        : ''
      const refusal = await requireSecret(token, deps.config.updateTokenHash, tokenGuard, address, {
        status: 401,
        error: 'UPDATE_TOKEN_REQUIRED',
      })
      if (refusal !== null) {
        writeJson(response, refusal.status, { error: refusal.error })
        return true
      }
      if (deps.config.updateTokenHash === '') {
        // The whole endpoint is about the token; without one there is nothing
        // here a page should be able to reach.
        writeJson(response, 404, { error: 'NOT_FOUND' })
        return true
      }
      if (request.method === 'GET') {
        writeJson(response, 200, await deps.monitor.snapshot())
        return true
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return true
      }
      const result = await deps.monitor.start()
      if (!result.started) {
        deps.log(`selfhost: update was not started — ${result.reason ?? 'unknown reason'}`)
        writeJson(response, 409, { started: false, reason: result.reason ?? 'not started' })
        return true
      }
      deps.log(`selfhost: update started by ${address}`)
      writeJson(response, 202, { started: true, current: RELAY_VERSION })
      return true
    }
    writeJson(response, 404, { error: 'NOT_FOUND' })
    return true
  }
}

/** One line from an unknown error, for logs and the page. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
