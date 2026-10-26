/**
 * Traffic accounting for the account service and the free relay.
 *
 * The relay already knows the exact payload bytes it moves; this file records
 * them by identity and day. It is deliberately not in the request path's
 * critical path: `record` only touches maps, and persistence/reporting happen on
 * a timer. A slow disk or an unreachable account relay must not add latency to
 * somebody's conversation.
 *
 * @module dsh-mizar-relay/accounts/traffic
 */
import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic, ensurePrivateDir } from './state.js'

/** One day's counters for one relay. */
export interface RelayCounters {
  in: number
  out: number
}

/** The counters for one identity. */
export interface IdentityTraffic {
  firstSeenAt: number
  lastSeenAt: number
  totalIn: number
  totalOut: number
  /** UTC day -> relay id -> counters. */
  days: Record<string, Record<string, RelayCounters>>
}

/** One relay seen in a report. */
export interface RelayInfo {
  role: 0 | 1
  lastReportAt: number
}

/** The traffic file. */
export interface TrafficFile {
  version: 1
  identities: Record<string, IdentityTraffic>
  relays: Record<string, RelayInfo>
}

/** One report entry. */
export interface TrafficEntry {
  identity: string
  day: string
  in: number
  out: number
}

/** A relay's traffic report. */
export interface TrafficReport {
  relayId: string
  role: 0 | 1
  entries: readonly TrafficEntry[]
  /**
   * Identities that hit the relay's hard daily cap.
   *
   * The cap refuses the request that would cross it, so carried bytes never
   * reach a warning threshold on the free relay. Without this the day an
   * account is stopped would be the one day the policy hears nothing about.
   */
  exhausted?: readonly TrafficExhaustion[]
}

/** One identity that spent its hard daily allowance. */
export interface TrafficExhaustion {
  readonly identity: string
  readonly day: string
  readonly bytes: number
}

/** Options for the ledger. */
export interface TrafficOptions {
  /** Directory to persist in; `null` keeps the ledger in memory (free relay). */
  readonly dataDir: string | null
  /** This relay's id, used for locally recorded traffic. */
  readonly relayId: string
  /** This relay's role. */
  readonly role: 0 | 1
  /** Where to POST batches, or empty for no reporting. */
  readonly reportTo: string
  /** Shared secret for the report. */
  readonly internalSecret: string
  /** Clock, injectable. */
  readonly now?: () => number
  /** Fetch, injectable. */
  readonly fetchImpl?: typeof fetch
  /** Logger. */
  readonly log?: (message: string) => void
  /**
   * Per-identity bytes in one UTC day that raise a volume anomaly, or `0` to
   * disable. Defaults to 500 MB -- the free plan's allowance.
   */
  readonly alertBytesPerDay?: number
  /**
   * How many times larger than an identity's own trailing daily average today's
   * total must be to raise a spike anomaly. Defaults to 8. `0` disables. The
   * day must also pass {@link SPIKE_MIN_BYTES}, whatever the plan.
   */
  readonly alertGrowthFactor?: number
  /**
   * The daily ceiling for one identity, when it depends on the plan.
   *
   * The account relay passes a function that resolves `account:<hash>` to the
   * owner's plan; a free relay can leave it out and use `alertBytesPerDay`.
   */
  readonly thresholdFor?: (identity: string) => number
  /** Called once per identity/day when an anomaly is noticed. */
  readonly onAnomaly?: (anomaly: TrafficAnomaly) => void
}

/**
 * One traffic anomaly the ledger noticed.
 *
 * Detection is deliberately simple and auditable: a volume threshold and a
 * self-relative spike. There is no model and no baseline shared between
 * identities, because the question an operator asks is narrow -- "is this
 * account doing something it was not doing yesterday" -- and a moving average
 * of an account's own days answers it without inventing a profile of what
 * normal looks like for everybody else.
 */
export interface TrafficAnomaly {
  readonly identity: string
  readonly day: string
  /** Bytes the identity carried that day at detection time. */
  readonly bytes: number
  readonly reason: 'volume' | 'spike' | 'quota'
  /** For `spike`, the trailing average it broke away from. */
  readonly baseline: number
  readonly at: number
}

/** How often the ledger persists/reports. */
const FLUSH_INTERVAL_MS = 30_000

/** How many days are kept. */
const RETENTION_DAYS = 90

/** How many identities are kept; a cap against a client-id flood. */
const MAX_IDENTITIES = 50_000

/** How many anomalies are kept for the admin pages. */
const MAX_ANOMALIES = 200

/** How many trailing days the spike baseline averages. */
const BASELINE_DAYS = 7

/**
 * A day must carry more than this before growth alone raises a spike.
 *
 * A small account's ordinary day can be many times its own quiet baseline
 * without being news: 20 MiB against a 2 MiB average is 10x, but it is not a
 * runaway. The floor keeps the self-relative detector from mailing people about
 * small days; the volume ceiling still catches absolute heavy days, and a day
 * that runs out of hard allowance still reports `quota`. Paid and free accounts
 * share this floor -- it is about the size of the day, not the plan.
 */
const SPIKE_MIN_BYTES = 100 * 1024 * 1024

/** One identity/day pending report. */
interface PendingReport {
  identity: string
  day: string
  in: number
  out: number
}

/** The traffic ledger. */
export class TrafficLedger {
  readonly #dataDir: string | null
  readonly #filePath: string
  readonly #relayId: string
  readonly #role: 0 | 1
  readonly #reportTo: string
  readonly #internalSecret: string
  readonly #now: () => number
  readonly #fetch: typeof fetch
  readonly #log: (message: string) => void
  readonly #identities = new Map<string, IdentityTraffic>()
  readonly #relays = new Map<string, RelayInfo>()
  readonly #pending = new Map<string, PendingReport>()
  /** Identity/day pairs that spent their hard cap, waiting for the next report. */
  readonly #pendingExhausted = new Map<string, TrafficExhaustion>()
  readonly #alertBytesPerDay: number
  readonly #alertGrowthFactor: number
  readonly #thresholdFor: ((identity: string) => number) | null
  readonly #onAnomaly: ((anomaly: TrafficAnomaly) => void) | null
  /** Recent anomalies, newest last, bounded. */
  readonly #anomalies: TrafficAnomaly[] = []
  /** Identity/day pairs already reported, so one burst is one alert. */
  readonly #anomalySeen = new Set<string>()
  #timer: NodeJS.Timeout | null = null
  #closed = false
  #lastReportFailure = 0

  private constructor(options: TrafficOptions) {
    this.#dataDir = options.dataDir
    this.#filePath = join(options.dataDir ?? '', 'traffic.json')
    this.#relayId = options.relayId === '' ? 'relay' : options.relayId
    this.#role = options.role
    this.#reportTo = options.reportTo.replace(/\/+$/, '')
    this.#internalSecret = options.internalSecret
    this.#now = options.now ?? Date.now
    this.#fetch = options.fetchImpl ?? fetch
    this.#log = options.log ?? (() => undefined)
    this.#alertBytesPerDay = Math.max(0, options.alertBytesPerDay ?? 500 * 1024 * 1024)
    this.#alertGrowthFactor = Math.max(0, options.alertGrowthFactor ?? 8)
    this.#thresholdFor = options.thresholdFor ?? null
    this.#onAnomaly = options.onAnomaly ?? null
  }

  /**
   * Open a ledger, loading its file when it persists.
   *
   * @param options - paths and reporting configuration.
   * @returns the ledger.
   */
  static async open(options: TrafficOptions): Promise<TrafficLedger> {
    const ledger = new TrafficLedger(options)
    if (ledger.#dataDir !== null) {
      await ensurePrivateDir(ledger.#dataDir)
      const file = await readJsonFile<TrafficFile | null>(ledger.#filePath, null).catch((error: unknown) => {
        // Traffic is statistics; a corrupt file is not worth refusing to boot
        // for, unlike accounts.json. The bad file is left as evidence.
        ledger.#log(`traffic: ${ledger.#filePath} is unreadable (${(error as Error).message}); starting empty`)
        return null
      })
      if (file !== null) {
        for (const [identity, value] of Object.entries(file.identities ?? {})) {
          ledger.#identities.set(identity, value)
        }
        for (const [id, value] of Object.entries(file.relays ?? {})) ledger.#relays.set(id, value)
      }
    }
    ledger.#relays.set(ledger.#relayId, { role: ledger.#role, lastReportAt: ledger.#now() })
    ledger.#timer = setInterval(() => {
      void ledger.flush()
    }, FLUSH_INTERVAL_MS)
    ledger.#timer.unref?.()
    return ledger
  }

  /**
   * Record bytes moved for one identity.
   *
   * @param identity - `account:<hash>`, `guest:<id>`, or `anon:<hash>`.
   * @param bytesIn - phone -> computer payload bytes.
   * @param bytesOut - computer -> phone payload bytes.
   */
  record(identity: string, bytesIn: number, bytesOut: number): void {
    if (this.#closed || identity === '') return
    const incoming = Math.max(0, Math.floor(bytesIn))
    const outgoing = Math.max(0, Math.floor(bytesOut))
    if (incoming === 0 && outgoing === 0) return
    const now = this.#now()
    const day = dayKey(now)
    const existing = this.#identities.get(identity)
    if (existing === undefined) {
      this.#pruneIfNeeded()
      this.#identities.set(identity, {
        firstSeenAt: now,
        lastSeenAt: now,
        totalIn: incoming,
        totalOut: outgoing,
        days: { [day]: { [this.#relayId]: { in: incoming, out: outgoing } } },
      })
    } else {
      existing.lastSeenAt = now
      existing.totalIn += incoming
      existing.totalOut += outgoing
      const perDay = existing.days[day] ?? (existing.days[day] = {})
      const perRelay = perDay[this.#relayId] ?? (perDay[this.#relayId] = { in: 0, out: 0 })
      perRelay.in += incoming
      perRelay.out += outgoing
    }
    this.#checkAnomaly(identity, day)
    if (this.#reportTo !== '') {
      const key = `${identity}\n${day}`
      const pending = this.#pending.get(key)
      if (pending === undefined) {
        this.#pending.set(key, { identity, day, in: incoming, out: outgoing })
      } else {
        pending.in += incoming
        pending.out += outgoing
      }
      if (this.#pending.size > 10_000) {
        // Drop the oldest quarter rather than growing forever while 主力1 is down.
        const drop = Math.ceil(this.#pending.size / 4)
        let index = 0
        for (const keyToDrop of this.#pending.keys()) {
          if (index >= drop) break
          this.#pending.delete(keyToDrop)
          index += 1
        }
        this.#log(`traffic: report buffer overflow, dropped ${drop} entries`)
      }
    }
  }

  /**
   * Note that an identity hit this relay's hard daily cap.
   *
   * Only a reporting relay needs this: the account relay sees the same identity
   * through its own meter and through {@link ingest}.
   *
   * @param identity - the traffic identity key.
   * @param day - the UTC day.
   * @param bytes - bytes carried when the cap was reached.
   */
  noteExhausted(identity: string, day: string, bytes: number): void {
    if (this.#closed || this.#reportTo === '') return
    this.#pendingExhausted.set(`${identity}\n${day}`, { identity, day, bytes: Math.max(0, bytes) })
  }

  /**
   * Merge one relay's report.
   *
   * @param report - a validated report from a free relay.
   */
  ingest(report: TrafficReport): void {
    const now = this.#now()
    this.#relays.set(report.relayId, { role: report.role, lastReportAt: now })
    for (const entry of report.entries) {
      if (!isValidIdentity(entry.identity) || !isValidDay(entry.day)) continue
      const incoming = Math.max(0, Math.floor(entry.in))
      const outgoing = Math.max(0, Math.floor(entry.out))
      const existing = this.#identities.get(entry.identity)
      if (existing === undefined) {
        this.#pruneIfNeeded()
        this.#identities.set(entry.identity, {
          firstSeenAt: now,
          lastSeenAt: now,
          totalIn: incoming,
          totalOut: outgoing,
          days: { [entry.day]: { [report.relayId]: { in: incoming, out: outgoing } } },
        })
        continue
      }
      existing.lastSeenAt = Math.max(existing.lastSeenAt, now)
      existing.totalIn += incoming
      existing.totalOut += outgoing
      const perDay = existing.days[entry.day] ?? (existing.days[entry.day] = {})
      const perRelay = perDay[report.relayId] ?? (perDay[report.relayId] = { in: 0, out: 0 })
      perRelay.in += incoming
      perRelay.out += outgoing
      this.#checkAnomaly(entry.identity, entry.day)
    }
    // A relay that spent its hard cap says so; the request that would have
    // crossed the line was refused, so its bytes are never in `entries`.
    for (const exhaustion of report.exhausted ?? []) {
      if (!isValidIdentity(exhaustion.identity) || !isValidDay(exhaustion.day)) continue
      this.#emit({
        identity: exhaustion.identity,
        day: exhaustion.day,
        bytes: Math.max(0, Math.floor(exhaustion.bytes)),
        reason: 'quota',
        baseline: 0,
        at: now,
      })
    }
  }

  /**
   * Notice when one identity's day stops looking like its own recent past.
   *
   * Two independent detectors, both cheap and both boring on purpose:
   *
   *   - **Volume.** The identity moved more than `alertBytesPerDay` in one UTC
   *     day. This is an absolute ceiling -- a person's heavy day -- so it fires
   *     on a runaway account regardless of what that account usually does.
   *   - **Spike.** Today is more than `alertGrowthFactor` times the identity's
   *     own trailing daily average, and today has passed an absolute floor
   *     ({@link SPIKE_MIN_BYTES}). The floor keeps a quiet account's small day
   *     from looking like a ramp; the multiple catches the ramp itself.
   *
   * Each identity/day is reported at most once, so a burst is one alert rather
   * than one per frame. Both are heuristics meant to make an operator look, not
   * to block: nothing is refused here, because a false positive must not take
   * away somebody's connection.
   */
  #checkAnomaly(identity: string, day: string): void {
    const ceiling = this.#thresholdFor === null ? this.#alertBytesPerDay : this.#thresholdFor(identity)
    if (ceiling <= 0 && this.#alertGrowthFactor === 0) return
    const key = `${identity}\n${day}`
    if (this.#anomalySeen.has(key)) return
    const value = this.#identities.get(identity)
    if (value === undefined) return
    const today = dayTotal(value.days[day])
    const at = this.#now()

    let anomaly: TrafficAnomaly | null = null
    if (ceiling > 0 && today > ceiling) {
      anomaly = { identity, day, bytes: today, reason: 'volume', baseline: ceiling, at }
    } else if (this.#alertGrowthFactor > 0 && today > SPIKE_MIN_BYTES) {
      const baseline = trailingAverage(value.days, day, BASELINE_DAYS)
      // A tiny baseline makes any byte look like a spike, so growth only counts
      // once the identity has both a meaningful history and a meaningful day --
      // 1 MiB of history keeps a new account's first request from alerting.
      if (baseline > 1024 * 1024 && today > baseline * this.#alertGrowthFactor) {
        anomaly = { identity, day, bytes: today, reason: 'spike', baseline, at }
      }
    }
    if (anomaly === null) return
    this.#emit(anomaly)
  }

  /**
   * Record one anomaly and tell the policy, once per identity/day.
   *
   * The listener is the enforcement policy, which persists and mails. It must
   * never be able to fail the meter.
   */
  #emit(anomaly: TrafficAnomaly): void {
    const key = `${anomaly.identity}\n${anomaly.day}`
    if (this.#anomalySeen.has(key)) return
    this.#anomalySeen.add(key)
    this.#anomalies.push(anomaly)
    if (this.#anomalies.length > MAX_ANOMALIES) this.#anomalies.splice(0, this.#anomalies.length - MAX_ANOMALIES)
    const label = anomaly.identity.length > 28 ? `${anomaly.identity.slice(0, 28)}…` : anomaly.identity
    this.#log(
      anomaly.reason === 'volume'
        ? `traffic: ANOMALY ${label} carried ${formatMiB(anomaly.bytes)} on ${anomaly.day}, over the ${formatMiB(anomaly.baseline)} ceiling`
        : anomaly.reason === 'quota'
          ? `traffic: ANOMALY ${label} spent its hard daily allowance on ${anomaly.day} (${formatMiB(anomaly.bytes)})`
          : `traffic: ANOMALY ${label} carried ${formatMiB(anomaly.bytes)} on ${anomaly.day}, over ${this.#alertGrowthFactor}× its ${formatMiB(anomaly.baseline)} average`,
    )
    try {
      this.#onAnomaly?.(anomaly)
    } catch {
      // A listener that throws is a bug in the listener, not in the accounting.
    }
  }

  /** The anomalies noticed so far, newest last. */
  anomalies(): readonly TrafficAnomaly[] {
    return this.#anomalies
  }

  /** A read-only copy for the admin pages. */
  snapshot(): { identities: Array<{ identity: string } & IdentityTraffic>; relays: Array<{ id: string } & RelayInfo> } {
    return {
      identities: [...this.#identities.entries()].map(([identity, value]) => ({ identity, ...value })),
      relays: [...this.#relays.entries()].map(([id, value]) => ({ id, ...value })),
    }
  }

  /** Sum the traffic for a set of account hashes. */
  summaryForHashes(hashes: readonly string[]): { totalIn: number; totalOut: number; todayIn: number; todayOut: number } {
    const today = dayKey(this.#now())
    let totalIn = 0
    let totalOut = 0
    let todayIn = 0
    let todayOut = 0
    for (const hash of hashes) {
      const value = this.#identities.get(`account:${hash}`)
      if (value === undefined) continue
      totalIn += value.totalIn
      totalOut += value.totalOut
      for (const [day, perRelay] of Object.entries(value.days)) {
        if (day !== today) continue
        for (const counters of Object.values(perRelay)) {
          todayIn += counters.in
          todayOut += counters.out
        }
      }
    }
    return { totalIn, totalOut, todayIn, todayOut }
  }

  /** Remove an identity, used when an account is deleted. */
  remove(identity: string): void {
    this.#identities.delete(identity)
  }

  /** Persist and report. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.#dataDir !== null) {
      try {
        await writeJsonAtomic(this.#filePath, {
          version: 1,
          identities: Object.fromEntries(this.#identities),
          relays: Object.fromEntries(this.#relays),
        } satisfies TrafficFile)
      } catch (error) {
        this.#log(`traffic: could not persist ${this.#filePath}: ${(error as Error).message}`)
      }
    }
    if ((this.#reportTo !== '' && this.#pending.size > 0) || this.#pendingExhausted.size > 0) {
      await this.#sendPending()
    }
    this.#prune()
  }

  /** Stop timers and flush one last time. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    await this.flush()
  }

  /** Send pending report batches. */
  async #sendPending(): Promise<void> {
    if (this.#internalSecret === '') {
      if (this.#now() - this.#lastReportFailure > 60_000) {
        this.#lastReportFailure = this.#now()
        this.#log('traffic: reportTo is set but internalSecret is empty; reports are held')
      }
      return
    }
    const entries = [...this.#pending.values()].slice(0, 500)
    const exhausted = [...this.#pendingExhausted.values()].slice(0, 500)
    if (entries.length === 0 && exhausted.length === 0) return
    const body = JSON.stringify({ relayId: this.#relayId, role: this.#role, entries, exhausted })
    try {
      const response = await this.#fetch(`${this.#reportTo}/internal/v1/traffic`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#internalSecret}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`relay answered ${response.status}`)
      for (const entry of entries) this.#pending.delete(`${entry.identity}\n${entry.day}`)
      for (const item of exhausted) this.#pendingExhausted.delete(`${item.identity}\n${item.day}`)
    } catch (error) {
      if (this.#now() - this.#lastReportFailure > 60_000) {
        this.#lastReportFailure = this.#now()
        this.#log(`traffic: report failed: ${(error as Error).message}`)
      }
    }
  }

  /** Drop days past retention and identities that have been quiet too long. */
  #prune(): void {
    const now = this.#now()
    const cutoff = dayKey(now - RETENTION_DAYS * 86_400_000)
    const quiet = now - 180 * 86_400_000
    for (const [identity, value] of this.#identities) {
      for (const day of Object.keys(value.days)) {
        if (day < cutoff) delete value.days[day]
      }
      if (value.lastSeenAt < quiet && Object.keys(value.days).length === 0) {
        this.#identities.delete(identity)
      }
    }
  }

  /** Keep the identity map bounded. */
  #pruneIfNeeded(): void {
    if (this.#identities.size < MAX_IDENTITIES) return
    let oldestKey: string | null = null
    let oldest = Number.POSITIVE_INFINITY
    for (const [key, value] of this.#identities) {
      if (value.lastSeenAt < oldest) {
        oldest = value.lastSeenAt
        oldestKey = key
      }
    }
    if (oldestKey !== null) this.#identities.delete(oldestKey)
  }
}

/** The UTC day key. */
export function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/** Sum one day's in+out across every relay that reported it. */
function dayTotal(perRelay: Record<string, RelayCounters> | undefined): number {
  if (perRelay === undefined) return 0
  let total = 0
  for (const counters of Object.values(perRelay)) total += counters.in + counters.out
  return total
}

/**
 * The mean daily total over the `count` days before `day`.
 *
 * Days the identity did not appear count as zero, which is what makes a ramp
 * from silence look like a ramp: averaging only the busy days would make a
 * once-a-month account's heavy day look routine.
 */
function trailingAverage(
  days: Record<string, Record<string, RelayCounters>>,
  day: string,
  count: number,
): number {
  const end = Date.parse(`${day}T00:00:00Z`)
  let total = 0
  for (let index = 1; index <= count; index += 1) {
    total += dayTotal(days[dayKey(end - index * 86_400_000)])
  }
  return total / count
}

/** MiB with one decimal, for log lines an operator reads at a glance. */
function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`
}

/** Whether an identity key is one this relay understands. */
export function isValidIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 200) return false
  if (value.startsWith('account:')) return /^account:[0-9a-f]{64}$/.test(value)
  if (value.startsWith('guest:')) return /^guest:[A-Za-z0-9._-]{1,64}$/.test(value)
  if (value.startsWith('anon:')) return /^anon:[0-9a-f]{8,64}$/.test(value)
  return false
}

/** Whether a day key is a UTC date. */
export function isValidDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
