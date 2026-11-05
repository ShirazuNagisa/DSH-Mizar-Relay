/**
 * The dataset endpoints: what they accept, what they refuse, and what they do
 * not become.
 *
 * The interesting assertions are the negative ones. A relay that stores an
 * account id beside the turns has built the mapping the feature promises not to
 * have; a flush that deletes before the receiver acknowledges has traded data
 * for a hopeful log line. Both are tested here, not just described.
 */
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountStore } from '../src/accounts/store.js'
import { handleDatasetIngest } from '../src/dataset/ingest.js'
import { handleDatasetReceive } from '../src/dataset/receive.js'
import { flushOnce } from '../src/dataset/flush.js'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import { hashPassword } from '../src/accounts/passwords.js'

const SECRET = 'test-dataset-secret'
const SESSION = '0123456789abcdef0123456789abcdef'
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
const DAY = '2026-11-03'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-dataset-'))
})

afterEach(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

function turn(n = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: `${SESSION}:${n}`,
    session: SESSION,
    turn: n,
    engine: 'dsh',
    minutes: 1.5,
    reason: 'completed',
    steps: 3,
    replyCount: 1,
    endsWithQuestion: false,
    user: 'fix the build',
    tools: 'read×2 · bash×1',
    failures: [],
    subagents: [],
    jobs: [],
    texts: ['done'],
    day: DAY,
    ...overrides,
  }
}

function store(answer: 'good' | 'bad' = 'good'): AccountStore {
  return {
    tokenEntitlement: (token: string) =>
      answer === 'good' && token === 'session-token'
        ? { ok: true, userId: 'user-should-not-be-stored', paidUntil: null, paid: false }
        : { ok: false, reason: 'unknown' },
  } as unknown as AccountStore
}

async function serve(
  handler: (request: Parameters<typeof handleDatasetIngest>[0], response: Parameters<typeof handleDatasetIngest>[1]) => Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson', authorization: 'Bearer session-token', ...headers },
    body,
  })
}

describe('dataset ingest', () => {
  it('refuses a request without a valid session', async () => {
    const server = await serve((request, response) =>
      handleDatasetIngest(request, response, {
        store: store('bad'),
        dataDir: dir,
        maxBatchBytes: 1024,
        now: () => NOW,
      }),
    )
    try {
      const response = await post(server.url, `${JSON.stringify(turn())}\n`, {
        authorization: 'Bearer nope',
      })
      expect(response.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('stores turns and never stores the account that sent them', async () => {
    const server = await serve((request, response) =>
      handleDatasetIngest(request, response, {
        store: store(),
        dataDir: dir,
        maxBatchBytes: 10_000,
        now: () => NOW,
      }),
    )
    try {
      const response = await post(server.url, `${JSON.stringify(turn())}\n`, {
        'x-mizar-batch': 'batch-0001',
        'x-mizar-client': 'agi-mizar/0.1.1',
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, accepted: 1, rejected: 0 })
    } finally {
      await server.close()
    }
    const day = join(dir, 'dataset', 'incoming', DAY)
    const files = await readdir(day)
    expect(files).toContain('batch-0001.ndjson')
    const meta = await readFile(join(day, 'batch-0001.meta.json'), 'utf8')
    expect(meta).not.toContain('user-should-not-be-stored')
    expect(meta).not.toContain('session-token')
    expect(meta).not.toContain('127.0.0.1')
    const data = await readFile(join(day, 'batch-0001.ndjson'), 'utf8')
    expect(JSON.parse(data.trim())).toMatchObject({ id: `${SESSION}:1` })
  })

  it('keeps the valid lines and counts the invalid ones', async () => {
    const server = await serve((request, response) =>
      handleDatasetIngest(request, response, {
        store: store(),
        dataDir: dir,
        maxBatchBytes: 10_000,
        now: () => NOW,
      }),
    )
    try {
      const body = [
        JSON.stringify(turn(1)),
        'not json',
        JSON.stringify(turn(2, { session: 'not-hex' })),
        JSON.stringify(turn(2)),
      ].join('\n')
      const response = await post(server.url, `${body}\n`, { 'x-mizar-batch': 'batch-0002' })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ accepted: 2, rejected: 2 })
    } finally {
      await server.close()
    }
  })

  it('is idempotent for a batch id that already exists', async () => {
    const server = await serve((request, response) =>
      handleDatasetIngest(request, response, {
        store: store(),
        dataDir: dir,
        maxBatchBytes: 10_000,
        now: () => NOW,
      }),
    )
    try {
      const body = `${JSON.stringify(turn())}\n`
      expect((await post(server.url, body, { 'x-mizar-batch': 'batch-0003' })).status).toBe(200)
      const again = await post(server.url, body, { 'x-mizar-batch': 'batch-0003' })
      expect(again.status).toBe(200)
      expect(await again.json()).toMatchObject({ duplicate: true, accepted: 0 })
    } finally {
      await server.close()
    }
  })

  it('refuses a body past the batch cap', async () => {
    const server = await serve((request, response) =>
      handleDatasetIngest(request, response, {
        store: store(),
        dataDir: dir,
        maxBatchBytes: 20,
        now: () => NOW,
      }),
    )
    try {
      const response = await post(server.url, `${JSON.stringify(turn())}\n`)
      expect(response.status).toBe(413)
    } finally {
      await server.close()
    }
  })

  it('rate limits one account instead of one address', async () => {
    const accountStore = store()
    const server = await serve((request, response) =>
      handleDatasetIngest(request, response, {
        store: accountStore,
        dataDir: dir,
        maxBatchBytes: 10_000,
        now: () => NOW,
        limits: { requestsPerHour: 1 },
      }),
    )
    try {
      const body = `${JSON.stringify(turn())}\n`
      expect((await post(server.url, body, { 'x-mizar-batch': 'batch-a1' })).status).toBe(200)
      const limited = await post(server.url, body, { 'x-mizar-batch': 'batch-a2' })
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBeTruthy()
    } finally {
      await server.close()
    }
  })
})

describe('dataset receive', () => {
  function sign(timestamp: number, body: Buffer, secret = SECRET): string {
    const digest = createHash('sha256').update(body).digest('hex')
    const mac = createHmac('sha256', secret).update(`${timestamp}.${digest}`).digest('hex')
    return `sha256=${mac}`
  }

  async function send(
    url: string,
    body: Buffer,
    overrides: Record<string, string> = {},
  ): Promise<Response> {
    const timestamp = Math.floor(NOW / 1000)
    const digest = createHash('sha256').update(body).digest('hex')
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/gzip',
        'x-mizar-timestamp': String(timestamp),
        'x-mizar-signature': sign(timestamp, body),
        'x-mizar-archive': 'dataset-test.tar.gz',
        'x-mizar-sha256': digest,
        ...overrides,
      },
      body,
    })
  }

  it('stores a signed archive and acknowledges its hash', async () => {
    const server = await serve((request, response) =>
      handleDatasetReceive(request, response, {
        dataDir: dir,
        secret: SECRET,
        maxArchiveBytes: 1024 * 1024,
        now: () => NOW,
      }),
    )
    const body = Buffer.from('not really a tarball, but signed')
    try {
      const response = await send(server.url, body)
      expect(response.status).toBe(200)
      const answer = (await response.json()) as { sha256: string }
      expect(answer.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    } finally {
      await server.close()
    }
    const stored = await readFile(join(dir, 'dataset', 'archive', DAY, 'dataset-test.tar.gz'))
    expect(stored).toEqual(body)
  })

  it('refuses a bad signature and a traversal name', async () => {
    const server = await serve((request, response) =>
      handleDatasetReceive(request, response, {
        dataDir: dir,
        secret: SECRET,
        maxArchiveBytes: 1024 * 1024,
        now: () => NOW,
      }),
    )
    const body = Buffer.from('hello')
    try {
      const bad = await send(server.url, body, {
        'x-mizar-signature': 'sha256=00',
      })
      expect(bad.status).toBe(401)
      const traversal = await send(server.url, body, {
        'x-mizar-archive': '../escape.tar.gz',
      })
      expect(traversal.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('refuses an archive past the cap and leaves no partial file', async () => {
    const server = await serve((request, response) =>
      handleDatasetReceive(request, response, {
        dataDir: dir,
        secret: SECRET,
        maxArchiveBytes: 4,
        now: () => NOW,
      }),
    )
    try {
      const response = await send(server.url, Buffer.from('too large'))
      expect(response.status).toBe(413)
    } finally {
      await server.close()
    }
    // The content-length precheck refuses before creating the receive directory.
    const receive = await readdir(join(dir, 'dataset', 'receive')).catch(() => [])
    expect(receive).toEqual([])
  })
})

describe('dataset flush', () => {
  async function seed(batch = 'batch-0001', turns = 1): Promise<string> {
    const day = join(dir, 'dataset', 'incoming', DAY)
    await mkdir(day, { recursive: true })
    const lines = Array.from({ length: turns }, (_, index) =>
      JSON.stringify(turn(index + 1)),
    ).join('\n')
    const path = join(day, `${batch}.ndjson`)
    await writeFile(path, `${lines}\n`)
    await writeFile(
      join(day, `${batch}.meta.json`),
      JSON.stringify({ v: 1, batchId: batch, turns }),
    )
    return path
  }

  it('posts one signed archive and deletes the batches only after a 2xx', async () => {
    const path = await seed()
    let received = Buffer.alloc(0)
    let headers: Record<string, string | string[] | undefined> = {}
    const receiver = createServer((request, response) => {
      headers = request.headers
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received = Buffer.concat(chunks)
        const sha = createHash('sha256').update(received).digest('hex')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, sha256: sha }))
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const port = (receiver.address() as AddressInfo).port
    try {
      const result = await flushOnce({
        dataDir: dir,
        receiveURL: `http://127.0.0.1:${port}/dataset/v1/receive`,
        secret: SECRET,
        now: () => NOW,
      })
      expect(result.archives).toBe(1)
      expect(result.turns).toBe(1)
      const archiveHeader = String(headers['x-mizar-archive'])
      expect(archiveHeader).toMatch(/^dataset-\d{8}-\d{6}\.tar\.gz$/)
      const timestamp = String(headers['x-mizar-timestamp'])
      const signature = String(headers['x-mizar-signature'])
      const digest = createHash('sha256').update(received).digest('hex')
      const expected = `sha256=${createHmac('sha256', SECRET)
        .update(`${timestamp}.${digest}`)
        .digest('hex')}`
      expect(signature).toBe(expected)
      expect(received.length).toBeGreaterThan(0)
      await expect(readFile(path)).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()))
    }
  })

  it('keeps the batches when the receiver refuses', async () => {
    const path = await seed()
    const receiver = createServer((request, response) => {
      request.resume()
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'nope' }))
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const port = (receiver.address() as AddressInfo).port
    try {
      await expect(
        flushOnce({
          dataDir: dir,
          receiveURL: `http://127.0.0.1:${port}/dataset/v1/receive`,
          secret: SECRET,
          now: () => NOW,
        }),
      ).rejects.toThrow('500')
      // The file is still there, so the next timer run is a retry.
      await expect(readFile(path)).resolves.toBeTruthy()
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()))
    }
  })

  it('does nothing when there is no cache', async () => {
    const result = await flushOnce({
      dataDir: dir,
      receiveURL: 'http://127.0.0.1:1/dataset/v1/receive',
      secret: SECRET,
      now: () => NOW,
    })
    expect(result.archives).toBe(0)
  })
})

describe('dataset routing', () => {
  const FAST = { N: 1024, r: 8, p: 1 }
  let relay: Relay | undefined

  afterEach(async () => {
    await relay?.close()
    relay = undefined
  })

  it('accepts a real account token and does not expose receive on role 1', async () => {
    const adminHash = await hashPassword('admin-password', FAST)
    const config: RelayConfig = {
      port: 0,
      host: '127.0.0.1',
      tokens: [],
      trustProxy: true,
      maxTunnelsPerIp: 8,
      maxRooms: 10,
      maxBodyBytes: 1024 * 1024,
      maxMessageBytes: 1024 * 1024,
      maxClientsPerRoom: 8,
      requestTimeoutMs: 2_000,
      tunnelIdleMs: 60_000,
      probePort: 0,
      apns: null,
      fcm: null,
      role: 1,
      accounts: {
        enabled: true,
        dataDir: dir,
        adminPasswordHash: adminHash,
        internalSecret: 'internal',
        reportTo: '',
        reportId: 'dataset-routing',
        gravatar: { enabled: false, baseURLs: [] },
        appleAudiences: ['me.shirazu.dshmizar'],
        appleKeysURL: 'https://appleid.apple.com/auth/keys',
        appstore: {
          bundleId: 'me.shirazu.dshmizar',
          productId: 'me.shirazu.dshmizar.paid.monthly',
          allowSandbox: true,
          notificationsEnabled: false,
        },
        publicBaseURL: 'https://accounts.test',
        paidGate: { mode: 'off', allowUnaccounted: false, cacheTtlMs: 60_000 },
      },
      dataset: {
        enabled: true,
        dataDir: dir,
        receiveURL: '',
        secret: 'secret',
        maxBatchBytes: 1024 * 1024,
        maxArchiveBytes: 1024 * 1024,
      },
    }
    relay = await startRelay(config, () => undefined, {
      now: () => NOW,
      passwordParams: FAST,
    })
    const base = `http://127.0.0.1:${relay.port}`
    const registered = await fetch(`${base}/account/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'dataset-user',
        email: 'dataset@example.com',
        password: 'correct horse battery',
        device: { id: 'desktop-1', name: 'Mac', model: 'Mac14,2', platform: 'macos', appVersion: '0.1.1' },
      }),
    })
    expect(registered.status).toBe(200)
    const token = String((await registered.json()).token)

    const uploaded = await fetch(`${base}/dataset/v1/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-ndjson',
        authorization: `Bearer ${token}`,
        'x-mizar-batch': 'routing-batch-1',
      },
      body: `${JSON.stringify(turn())}\n`,
    })
    expect(uploaded.status).toBe(200)
    const day = join(dir, 'dataset', 'incoming', DAY)
    expect(await readdir(day)).toContain('routing-batch-1.ndjson')

    const receive = await fetch(`${base}/dataset/v1/receive`, { method: 'POST', body: 'x' })
    expect(receive.status).toBe(404)
  })
})
