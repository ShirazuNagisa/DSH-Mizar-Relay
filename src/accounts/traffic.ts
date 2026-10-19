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
}

/** How often the ledger persists/reports. */
const FLUSH_INTERVAL_MS = 30_000

/** How many days are kept. */
const RETENTION_DAYS = 90

/** How many identities are kept; a cap against a client-id flood. */
const MAX_IDENTITIES = 50_000

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
    }
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
    if (this.#reportTo !== '' && this.#pending.size > 0) await this.#sendPending()
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
    if (entries.length === 0) return
    const body = JSON.stringify({ relayId: this.#relayId, role: this.#role, entries })
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
