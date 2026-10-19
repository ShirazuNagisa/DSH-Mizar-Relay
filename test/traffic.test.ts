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
