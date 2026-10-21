/**
 * The GitHub sign-in routes, over HTTP, against a real relay.
 *
 * The browser round-trip is faked at the network boundary: the stub fetch
 * answers for github.com and api.github.com, so the tests drive the real
 * routes, the real pending/handoff state, and the real store resolution --
 * only GitHub itself is a stand-in.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startRelay, type Relay } from '../src/index.js'
import { loadConfig, type RelayConfig } from '../src/config.js'
import { hashPassword } from '../src/accounts/passwords.js'

const NOW = 1_769_000_000_000
const FAST = { N: 1024, r: 8, p: 1 }

/** The stub's answers; each test points them at the identity it needs. */
const stub = {
  networkDown: false,
  refuseCode: false,
  user: { id: 1234501, login: 'octocat', email: null } as Record<string, unknown>,
  emails: [{ email: 'octo@example.com', primary: true, verified: true }] as unknown,
}

const fakeFetch: typeof fetch = (async (input, init) => {
  void init
  const url = String(input instanceof Request ? input.url : input)
  if (url === 'https://github.com/login/oauth/access_token') {
    if (stub.networkDown) throw new Error('upstream unreachable')
    if (stub.refuseCode) {
      return new Response(
        JSON.stringify({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }),
        { status: 400 },
      )
    }
    return new Response(JSON.stringify({ access_token: 'gho_unit_test', token_type: 'bearer' }), { status: 200 })
  }
  if (url === 'https://api.github.com/user') return new Response(JSON.stringify(stub.user), { status: 200 })
  if (url === 'https://api.github.com/user/emails') return new Response(JSON.stringify(stub.emails), { status: 200 })
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

let relay: Relay | undefined
let dir = ''
let adminHash = ''
let clock = NOW

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-github-'))
  adminHash = await hashPassword('admin-password', FAST)
  clock = NOW
  stub.networkDown = false
  stub.refuseCode = false
  stub.user = { id: 1234501, login: 'octocat', email: null }
  stub.emails = [{ email: 'octo@example.com', primary: true, verified: true }]
})

afterEach(async () => {
  await relay?.close()
  relay = undefined
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    tokens: ['github-test-token'],
    trustProxy: true,
    maxTunnelsPerIp: 8,
    maxRooms: 100,
    maxBodyBytes: 1024 * 1024,
    maxMessageBytes: 1024 * 1024,
    maxClientsPerRoom: 8,
    requestTimeoutMs: 2000,
    tunnelIdleMs: 60_000,
    probePort: 0,
    apns: null,
    fcm: null,
    role: 1,
    accounts: {
      enabled: true,
      dataDir: dir,
      adminPasswordHash: adminHash,
      internalSecret: 'unit-test-internal-secret',
      reportTo: '',
      reportId: 'test-account-relay',
      gravatar: { enabled: false, baseURLs: [] },
      appleAudiences: ['me.shirazu.dshmizar'],
      appleKeysURL: 'https://appleid.apple.com/auth/keys',
      appstore: {
        bundleId: 'me.shirazu.dshmizar',
        productId: 'me.shirazu.dshmizar.paid.monthly',
        allowSandbox: true,
        notificationsEnabled: true,
      },
      publicBaseURL: 'https://accounts.test',
      paidGate: { mode: 'off', allowUnaccounted: false, cacheTtlMs: 60_000 },
      github: {
        enabled: true,
        clientId: 'TestClientID',
        clientSecret: 'unit-test-github-secret',
        callbackURL: 'https://accounts.test/account/v1/github/callback',
      },
    },
    ...overrides,
  }
}

async function boot(overrides: Partial<RelayConfig> = {}): Promise<string> {
  relay = await startRelay(config(overrides), () => undefined, {
    now: () => clock,
    fetchImpl: fakeFetch,
    passwordParams: FAST,
  })
  return `http://127.0.0.1:${relay.port}`
}

function device(id: string): Record<string, string> {
  return { id, name: `Pixel ${id}`, model: 'Pixel 9', platform: 'android', appVersion: '0.10.2' }
}

async function post(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function start(base: string, token?: string): Promise<{ state: string; authorizeUrl: string; expiresAt: number }> {
  const reply = await post(base, '/account/v1/github/start', { device: device('pixel-0001') }, token)
  expect(reply.status).toBe(200)
  return reply.body as unknown as { state: string; authorizeUrl: string; expiresAt: number }
}

async function callback(base: string, code: string, state: string): Promise<{ status: number; location: string; html: string }> {
  const response = await fetch(
    `${base}/account/v1/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' },
  )
  return { status: response.status, location: response.headers.get('location') ?? '', html: await response.text() }
}

const HANDOFF = /handoff=(MZ-[2-9A-Z]{4}-[2-9A-Z]{4})/

async function handoff(base: string, code: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return post(base, '/account/v1/github/handoff', { code, device: device('pixel-0001') })
}

async function seedUser(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const record = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'seeded',
    usernameKey: 'seeded',
    email: 'seeded@example.com',
    emailKey: 'seeded@example.com',
    emailVerified: true,
    passwordHash: await hashPassword('correct horse battery staple', FAST),
    appleSub: null,
    githubId: null,
    githubLogin: null,
    avatar: { kind: 'generated', colors: ['#112233', '#445566'], initials: 'S' },
    disabled: false,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    devices: [],
    entitlements: { grantedPaidUntil: null, appStore: null },
    ...overrides,
  }
  await writeFile(
    join(dir, 'accounts.json'),
    JSON.stringify({ version: 1, users: [record], sessions: [], appStoreBindings: [], processedAppStoreEvents: [] }),
  )
}

describe('the GitHub sign-in routes', () => {
  it('answers GITHUB_NOT_CONFIGURED when the feature is off', async () => {
    const accounts = { ...config().accounts, github: null }
    const base = await boot({ accounts })
    const reply = await post(base, '/account/v1/github/start', { device: device('pixel-0001') })
    expect(reply.status).toBe(404)
    expect(reply.body['error']).toBe('GITHUB_NOT_CONFIGURED')
  })

  it('hands out an authorize URL bound to this round-trip', async () => {
    const base = await boot()
    const started = await start(base)
    expect(started.authorizeUrl).toContain('https://github.com/login/oauth/authorize')
    expect(started.authorizeUrl).toContain('client_id=TestClientID')
    expect(started.authorizeUrl).toContain(encodeURIComponent('https://accounts.test/account/v1/github/callback'))
    expect(started.authorizeUrl).toContain(encodeURIComponent('read:user user:email'))
    expect(started.expiresAt).toBeGreaterThan(NOW)
  })

  it('signs a new GitHub identity up and hands off a session', async () => {
    const base = await boot()
    const started = await start(base)
    const done = await callback(base, 'good-code', started.state)
    expect(done.status).toBe(303)
    const match = HANDOFF.exec(done.location)
    expect(match).not.toBeNull()
    const claim = await handoff(base, match![1]!)
    expect(claim.status).toBe(200)
    const token = String(claim.body['token'])
    expect(token.startsWith('mza_')).toBe(true)
    const user = claim.body['user'] as Record<string, unknown>
    expect(user['github']).toBe(true)
    expect(user['githubLogin']).toBe('octocat')
    expect(user['username']).toBe('octocat')
    const me = await fetch(`${base}/account/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
  })

  it('consumes a state once', async () => {
    const base = await boot()
    const started = await start(base)
    const first = await callback(base, 'good-code', started.state)
    expect(first.status).toBe(303)
    const replay = await callback(base, 'good-code', started.state)
    expect(replay.status).toBe(400)
    expect(replay.html).toContain('GITHUB_INVALID_STATE')
  })

  it('links an existing account through a verified email', async () => {
    await seedUser(dir, { email: 'octo@example.com', emailKey: 'octo@example.com' })
    const base = await boot()
    const started = await start(base)
    const done = await callback(base, 'good-code', started.state)
    expect(done.status).toBe(303)
    const claim = await handoff(base, HANDOFF.exec(done.location)![1]!)
    expect(claim.status).toBe(200)
    const user = claim.body['user'] as Record<string, unknown>
    expect(user['username']).toBe('seeded')
    expect(user['github']).toBe(true)
    expect(user['githubLogin']).toBe('octocat')
  })

  it('refuses to auto-link an unverified email account', async () => {
    const base = await boot()
    const registered = await post(base, '/account/v1/register', {
      username: 'someone',
      email: 'octo@example.com',
      password: 'a-strong-password-1',
      device: device('pixel-0002'),
    })
    expect(registered.status).toBe(200)
    const started = await start(base)
    const done = await callback(base, 'good-code', started.state)
    expect(done.status).toBe(409)
    expect(done.html).toContain('GITHUB_EMAIL_CONFLICT')
  })

  it('binds GitHub to the signed-in account', async () => {
    const base = await boot()
    const registered = await post(base, '/account/v1/register', {
      username: 'someone',
      email: 'someone@example.com',
      password: 'a-strong-password-1',
      device: device('pixel-0002'),
    })
    expect(registered.status).toBe(200)
    const started = await start(base, String(registered.body['token']))
    const done = await callback(base, 'good-code', started.state)
    expect(done.status).toBe(303)
    expect(done.location).toContain('bound=1')
    const me = await fetch(`${base}/account/v1/me`, { headers: { authorization: `Bearer ${String(registered.body['token'])}` } })
    const body = (await me.json()) as { user: Record<string, unknown> }
    expect(body.user['github']).toBe(true)
    expect(body.user['githubLogin']).toBe('octocat')
  })

  it('refuses binding an identity that another account already wears', async () => {
    const base = await boot()
    const firstStart = await start(base)
    await callback(base, 'good-code', firstStart.state)
    const second = await post(base, '/account/v1/register', {
      username: 'someone',
      email: 'someone@example.com',
      password: 'a-strong-password-1',
      device: device('pixel-0002'),
    })
    expect(second.status).toBe(200)
    const started = await start(base, String(second.body['token']))
    const done = await callback(base, 'good-code', started.state)
    expect(done.status).toBe(409)
    expect(done.html).toContain('GITHUB_IDENTITY_TAKEN')
  })

  it('renders the exchange failure the manual documents', async () => {
    const base = await boot()
    stub.refuseCode = true
    const started = await start(base)
    const done = await callback(base, 'good-code', started.state)
    expect(done.status).toBe(502)
    expect(done.html).toContain('GITHUB_EXCHANGE_FAILED')
  })

  it('answers GITHUB_UNAVAILABLE when GitHub cannot be reached', async () => {
    const base = await boot()
    stub.networkDown = true
    const started = await start(base)
    const done = await callback(base, 'good-code', started.state)
    expect(done.status).toBe(503)
    expect(done.html).toContain('GITHUB_UNAVAILABLE')
  })

  it('consumes a handoff code once and refuses unknown ones', async () => {
    const base = await boot()
    const started = await start(base)
    const done = await callback(base, 'good-code', started.state)
    const code = HANDOFF.exec(done.location)![1]!
    expect((await handoff(base, code)).status).toBe(200)
    const second = await handoff(base, code)
    expect(second.status).toBe(400)
    expect(second.body['error']).toBe('GITHUB_HANDOFF_INVALID')
    expect((await handoff(base, 'MZ-AAAA-BBBB')).status).toBe(400)
  })

  it('expires the handoff with the clock', async () => {
    const base = await boot()
    const started = await start(base)
    const done = await callback(base, 'good-code', started.state)
    const code = HANDOFF.exec(done.location)![1]!
    clock += 11 * 60_000
    expect((await handoff(base, code)).status).toBe(400)
  })
})

describe('the github config gate', () => {
  it('refuses to start with the feature enabled but incomplete', async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), 'mizar-github-cfg-'))
    const path = join(cfgDir, 'relay.config.json')
    await writeFile(path, JSON.stringify({ accounts: { enabled: true, github: { enabled: true } } }))
    expect(() => loadConfig(path, {})).toThrow(/accounts\.github needs clientId, clientSecret and callbackURL/)
    await rm(cfgDir, { recursive: true, force: true })
  })
})
