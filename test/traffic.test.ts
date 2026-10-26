/** Traffic accounting: per identity/day merge, persistence, and reporting. */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TrafficLedger,
  dayKey,
  isValidDay,
  isValidIdentity,
} from '../src/accounts/traffic.js'

let dir = ''
let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'mizar-traffic-'))
  return dir
}

describe('identity keys', () => {
  it('accepts the three shapes and rejects anything else', () => {
    expect(isValidIdentity(`account:${'a'.repeat(64)}`)).toBe(true)
    expect(isValidIdentity('guest:device-0001')).toBe(true)
    expect(isValidIdentity('anon:0123456789abcdef')).toBe(true)
    expect(isValidIdentity('account:short')).toBe(false)
    expect(isValidIdentity('guest:bad id')).toBe(false)
    expect(isValidIdentity('other:thing')).toBe(false)
  })

  it('accepts only UTC dates', () => {
    expect(isValidDay('2026-10-19')).toBe(true)
    expect(isValidDay('2026-13-01')).toBe(false)
    expect(isValidDay('2026-1-1')).toBe(false)
  })
})

describe('the ledger', () => {
  it('merges two relays and both directions', async () => {
    const home = await scratch()
    const now = Date.parse('2026-10-19T12:00:00Z')
    const ledger = await TrafficLedger.open({
      dataDir: home,
      relayId: 'primary-1',
      role: 1,
      reportTo: '',
      internalSecret: '',
      now: () => now,
    })
    ledger.record('account:' + 'a'.repeat(64), 100, 200)
    ledger.ingest({
      relayId: 'primary-0',
      role: 0,
      entries: [{ identity: 'account:' + 'a'.repeat(64), day: dayKey(now), in: 10, out: 20 }],
    })
    await ledger.flush()
    expect(ledger.summaryForHashes(['a'.repeat(64)])).toEqual({
      totalIn: 110,
      totalOut: 220,
      todayIn: 110,
      todayOut: 220,
    })
    const snapshot = ledger.snapshot()
    expect(snapshot.relays.map((relay) => relay.id).sort()).toEqual(['primary-0', 'primary-1'])
    await ledger.close()

    const reopened = await TrafficLedger.open({
      dataDir: home,
      relayId: 'primary-1',
      role: 1,
      reportTo: '',
      internalSecret: '',
      now: () => now,
    })
    expect(reopened.summaryForHashes(['a'.repeat(64)]).totalIn).toBe(110)
    await reopened.close()
  })

  it('reports pending batches to the account relay', async () => {
    const home = await scratch()
    const received: Array<Record<string, unknown>> = []
    server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        received.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const now = Date.parse('2026-10-19T12:00:00Z')
    const ledger = await TrafficLedger.open({
      dataDir: null,
      relayId: 'primary-0',
      role: 0,
      reportTo: `http://127.0.0.1:${port}`,
      internalSecret: 'report-secret',
      now: () => now,
    })
    ledger.record('guest:device-0001', 7, 9)
    await ledger.flush()
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      relayId: 'primary-0',
      role: 0,
      entries: [{ identity: 'guest:device-0001', day: '2026-10-19', in: 7, out: 9 }],
    })
    await ledger.close()
  })

  it('keeps a batch when the account relay is down', async () => {
    const home = await scratch()
    void home
    const now = Date.parse('2026-10-19T12:00:00Z')
    const ledger = await TrafficLedger.open({
      dataDir: null,
      relayId: 'primary-0',
      role: 0,
      reportTo: 'http://127.0.0.1:1',
      internalSecret: 'report-secret',
      now: () => now,
    })
    ledger.record('guest:device-0001', 7, 9)
    await ledger.flush()
    // A second flush still has the entry; a real retry would happen on the timer.
    expect(ledger.snapshot().identities).toHaveLength(1)
    await ledger.close()
  })
})

describe('traffic anomaly detection', () => {
  const ID = 'account:' + 'a'.repeat(64)
  const MIB = 1024 * 1024

  it('raises a volume anomaly once an identity passes its daily ceiling', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    const logged: string[] = []
    const ledger = await TrafficLedger.open({
      dataDir: null,
      relayId: 'primary-1',
      role: 1,
      reportTo: '',
      internalSecret: '',
      now: () => now,
      alertBytesPerDay: 1000,
      alertGrowthFactor: 0,
      log: (message) => logged.push(message),
    })
    // Under the ceiling: quiet.
    ledger.record(ID, 400, 400)
    expect(ledger.anomalies()).toHaveLength(0)
    // Crossing it is noticed, and only once for the day however many frames
    // follow -- a burst must be one alert, not one per request.
    ledger.record(ID, 200, 200)
    ledger.record(ID, 200, 200)
    const anomalies = ledger.anomalies()
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]).toMatchObject({ identity: ID, reason: 'volume' })
    expect(logged.some((line) => line.includes('ANOMALY'))).toBe(true)
    await ledger.close()
  })

  it('raises a spike anomaly when today dwarfs the identity own trailing average', async () => {
    let now = Date.parse('2026-10-12T12:00:00Z')
    const ledger = await TrafficLedger.open({
      dataDir: null,
      relayId: 'primary-1',
      role: 1,
      reportTo: '',
      internalSecret: '',
      now: () => now,
      alertBytesPerDay: 0,
      alertGrowthFactor: 8,
    })
    // Seven quiet days at 2MiB establish the baseline.
    for (let day = 0; day < 7; day += 1) {
      ledger.record(ID, 1024 * 1024, 1024 * 1024)
      now += 86_400_000
    }
    expect(ledger.anomalies()).toHaveLength(0)
    // Today is far past 8x that baseline and past the 100MiB floor.
    ledger.record(ID, 60 * MIB, 60 * MIB)
    const anomalies = ledger.anomalies()
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]).toMatchObject({ identity: ID, reason: 'spike', bytes: 120 * MIB })
    await ledger.close()
  })

  it('does not raise a spike until the day passes 100MiB', async () => {
    let now = Date.parse('2026-10-12T12:00:00Z')
    const ledger = await TrafficLedger.open({
      dataDir: null,
      relayId: 'primary-1',
      role: 1,
      reportTo: '',
      internalSecret: '',
      now: () => now,
      alertBytesPerDay: 0,
      alertGrowthFactor: 8,
    })
    // The same quiet 2MiB baseline; growth alone would fire long before 100MiB.
    for (let day = 0; day < 7; day += 1) {
      ledger.record(ID, 1024 * 1024, 1024 * 1024)
      now += 86_400_000
    }
    // Exactly at the floor is still under it: the rule is "more than 100MiB".
    ledger.record(ID, 50 * MIB, 50 * MIB)
    expect(ledger.anomalies()).toHaveLength(0)
    // One byte past the floor is enough, and the day still alerts only once.
    ledger.record(ID, 1, 0)
    const anomalies = ledger.anomalies()
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]).toMatchObject({ identity: ID, reason: 'spike', bytes: 100 * MIB + 1 })
    await ledger.close()
  })

  it('stays quiet for a new identity whose first bytes are small', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    const ledger = await TrafficLedger.open({
      dataDir: null,
      relayId: 'primary-1',
      role: 1,
      reportTo: '',
      internalSecret: '',
      now: () => now,
      alertBytesPerDay: 0,
      alertGrowthFactor: 8,
    })
    // A brand-new account moving its first megabytes is a person signing in,
    // not a bot: growth only counts past a meaningful absolute size.
    ledger.record(ID, 512 * 1024, 512 * 1024)
    expect(ledger.anomalies()).toHaveLength(0)
    await ledger.close()
  })
})
