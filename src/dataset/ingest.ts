/**
 * `POST /dataset/v1/ingest` — the account relay's door for anonymous turns.
 *
 * The desktop authenticates with the same account session token it uses for the
 * account API; the relay uses that token to say yes or no and then deliberately
 * forgets it. What lands on disk is a batch id, a day directory and the turns:
 * no account id, no device id, no token hash, no address. That is the whole
 * privacy contract of this module, and it is asserted in its tests.
 *
 * @module dsh-mizar-relay/dataset/ingest
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { AccountStore } from '../accounts/store.js'
import { readBody, writeJson } from '../http.js'
import { parseTurn, type TurnRecord } from './schema.js'

/** Requests one account may make per hour. */
const REQUESTS_PER_HOUR = 600

/** Bytes one account may upload per UTC day. */
const BYTES_PER_DAY = 50 * 1024 * 1024

/** The batch id a client may choose; anything else is generated. */
const BATCH = /^[A-Za-z0-9_-]{8,64}$/

/**
 * One set of counters per account store.
 *
 * A limiter built per request would reset on every request -- which is exactly
 * the bug a rate limit is meant to prevent. The weak key lets a test's fake
 * store, and a relay's real one, each keep their own window.
 */
const LIMITERS = new WeakMap<
  AccountStore,
  { budget: Budgets; hourly: Hourly; bytes: number; requests: number; now: () => number }
>()

function limiters(options: IngestOptions): { budget: Budgets; hourly: Hourly } {
  const now = options.now ?? Date.now
  const bytes = options.limits?.bytesPerDay ?? BYTES_PER_DAY
  const requests = options.limits?.requestsPerHour ?? REQUESTS_PER_HOUR
  const existing = LIMITERS.get(options.store)
  if (existing !== undefined && existing.bytes === bytes && existing.requests === requests) {
    return existing
  }
  const fresh = { budget: new Budgets(now, bytes), hourly: new Hourly(requests, now), bytes, requests, now }
  LIMITERS.set(options.store, fresh)
  return fresh
}

export interface IngestOptions {
  readonly store: AccountStore
  readonly dataDir: string
  readonly maxBatchBytes: number
  readonly now?: () => number
  readonly log?: (message: string) => void
  /** Small limits for tests; production uses the constants above. */
  readonly limits?: { readonly requestsPerHour?: number; readonly bytesPerDay?: number }
}

interface Budget {
  day: string
  bytes: number
  requests: number
}

/**
 * The per-account counters.
 *
 * Kept in memory on purpose: a relay restart forgiving an hour of a client's
 * budget is a smaller problem than a second file of account-keyed usage on a
 * machine whose whole point is not to keep one.
 */
class Budgets {
  readonly #map = new Map<string, Budget>()
  readonly #now: () => number
  readonly #limit: number

  constructor(now: () => number, limit: number) {
    this.#now = now
    this.#limit = limit
  }

  /** Whether one more request of `bytes` is allowed; records it when it is. */
  take(account: string, bytes: number): 'ok' | 'requests' | 'bytes' {
    const day = new Date(this.#now()).toISOString().slice(0, 10)
    const current = this.#map.get(account)
    const budget =
      current === undefined || current.day !== day
        ? { day, bytes: 0, requests: 0 }
        : current
    if (budget.requests >= REQUESTS_PER_HOUR * 24) return 'requests'
    if (budget.bytes + bytes > this.#limit) return 'bytes'
    budget.requests += 1
    budget.bytes += bytes
    this.#map.set(account, budget)
    if (this.#map.size > 20_000) {
      for (const [key, value] of this.#map) {
        if (value.day !== day) this.#map.delete(key)
      }
    }
    return 'ok'
  }
}

/**
 * A per-hour limiter that also answers "how long until the next slot".
 *
 * `RateWindow` only says yes/no, and a 429 without a hint invites a client to
 * hammer. One hour is the window, so the answer is at most an hour.
 */
class Hourly {
  readonly #hits = new Map<string, number[]>()
  readonly #limit: number
  readonly #now: () => number

  constructor(limit: number, now: () => number) {
    this.#limit = limit
    this.#now = now
  }

  check(key: string): number {
    const now = this.#now()
    const cutoff = now - 60 * 60_000
    const hits = (this.#hits.get(key) ?? []).filter((at) => at > cutoff)
    if (hits.length >= this.#limit) {
      const earliest = hits[0] ?? now
      this.#hits.set(key, hits)
      return Math.max(1, Math.ceil((earliest + 60 * 60_000 - now) / 1000))
    }
    hits.push(now)
    this.#hits.set(key, hits)
    if (this.#hits.size > 20_000) {
      for (const [bucket, times] of this.#hits) {
        if ((times.at(-1) ?? 0) <= cutoff) this.#hits.delete(bucket)
      }
    }
    return 0
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  return typeof value === 'string' ? value : ''
}

function bearer(request: IncomingMessage): string {
  const value = header(request, 'authorization')
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : ''
}

function cleanClient(value: string): string {
  const text = value.replace(/[\r\n]/g, ' ').trim().slice(0, 80)
  // A header that looks like a credential is not stored even truncated.
  if (/^(sk-|gh[pousr]_|github_pat_|Bearer\s)/i.test(text)) return 'unknown'
  return text
}

/**
 * Handle one ingest request. The caller has already decided this relay serves
 * the endpoint (role 1, dataset enabled, account store present).
 */
export async function handleDatasetIngest(
  request: IncomingMessage,
  response: ServerResponse,
  options: IngestOptions,
): Promise<void> {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  const { budget, hourly } = limiters(options)

  const token = bearer(request)
  const entitlement = token === '' ? null : options.store.tokenEntitlement(token)
  if (entitlement === null || !entitlement.ok) {
    writeJson(response, 401, { error: 'UNAUTHORIZED' })
    return
  }
  const account = entitlement.userId

  const rawBatch = header(request, 'x-mizar-batch').trim()
  if (rawBatch !== '' && !BATCH.test(rawBatch)) {
    writeJson(response, 400, { error: 'BAD_BATCH' })
    return
  }
  const batch = rawBatch === '' ? randomUUID() : rawBatch
  const client = cleanClient(header(request, 'x-mizar-client'))

  const body = await readBody(request, options.maxBatchBytes)
  if (body === null) {
    writeJson(response, 413, { error: 'TOO_LARGE' })
    return
  }

  const retry = hourly.check(account)
  if (retry > 0) {
    response.setHeader('retry-after', String(retry))
    writeJson(response, 429, { error: 'RATE_LIMITED' })
    return
  }
  const allowed = budget.take(account, body.length)
  if (allowed !== 'ok') {
    response.setHeader('retry-after', '3600')
    writeJson(response, 429, { error: 'RATE_LIMITED' })
    return
  }

  const turns: TurnRecord[] = []
  const seen = new Set<string>()
  let rejected = 0
  for (const line of body.toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const turn = parseTurn(trimmed)
    if (turn === null || seen.has(turn.id)) {
      rejected += 1
      continue
    }
    seen.add(turn.id)
    turns.push(turn)
  }
  if (turns.length === 0) {
    writeJson(response, 400, { error: 'NO_VALID_TURNS' })
    return
  }

  const day = new Date(now()).toISOString().slice(0, 10)
  const dir = join(options.dataDir, 'dataset', 'incoming', day)
  const dataPath = join(dir, `${batch}.ndjson`)
  if (await exists(dataPath)) {
    writeJson(response, 200, { ok: true, duplicate: true, accepted: 0, rejected: 0 })
    return
  }

  const text = `${turns.map((turn) => JSON.stringify(turn)).join('\n')}\n`
  const bytes = Buffer.byteLength(text)
  const sha256 = createHash('sha256').update(text).digest('hex')
  const meta = {
    v: 1,
    batchId: batch,
    receivedAt: now(),
    bytes,
    turns: turns.length,
    rejected,
    client,
    sha256,
  }

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await atomicWrite(join(dir, `${batch}.ndjson.tmp`), dataPath, text)
    await atomicWrite(
      join(dir, `${batch}.meta.json.tmp`),
      join(dir, `${batch}.meta.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
    )
  } catch (error) {
    log(`dataset: could not store batch ${batch}: ${(error as Error).message}`)
    writeJson(response, 500, { error: 'STORE_FAILED' })
    return
  }

  // One line, no account, no address: the log cannot become the mapping the
  // storage layer is careful not to keep.
  log(`dataset: batch ${batch} accepted (${turns.length} turns, ${rejected} rejected)`)
  writeJson(response, 200, { ok: true, accepted: turns.length, rejected })
}

async function atomicWrite(temp: string, final: string, text: string): Promise<void> {
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, final)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
