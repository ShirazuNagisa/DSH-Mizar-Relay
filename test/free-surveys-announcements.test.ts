/**
 * The 0.9.9 features, end to end over HTTP and sockets.
 *
 * Four things are pinned here, each one the thing that would silently break:
 *
 *   1. a free account is carried by the account relay when the flag is on, and
 *      refused when it is off -- the paywall is still a paywall, it just has a
 *      second lane;
 *   2. an announcement created through the private endpoint reaches a phone's
 *      socket immediately, and the polling twin answers the same objects;
 *   3. a survey submitted through the account relay is stored on the origin
 *      relay first, paid for exactly once, and refused the second time;
 *   4. an invite with `oncePerAccount` is refused the second time for the same
 *      account while still being usable by somebody else.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { hashPassword } from '../src/accounts/passwords.js'
import type { RelayConfig } from '../src/config.js'
import { PaidGate } from '../src/accounts/gate.js'
import { DataQuota } from '../src/accounts/quota.js'
import { startRelay, type Relay } from '../src/index.js'
import { APPSTORE_NOW, APPSTORE_TEST_ROOT } from './appstore-helpers.js'

const FAST = { N: 1024, r: 8, p: 1 }
const SECRET = 'internal-test-secret'

let relays: Relay[] = []
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-099-'))
})

afterEach(async () => {
  for (const relay of relays) await relay.close()
  relays = []
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

/** An account-relay config, with the free lane configurable. */
function accountConfig(overrides: {
  allowFree?: boolean
  surveysUpstream?: string
  internal?: RelayConfig['internal']
} = {}): RelayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    tokens: [],
    trustProxy: true,
    maxTunnelsPerIp: 8,
    maxRooms: 100,
    maxBodyBytes: 1024 * 1024,
    maxMessageBytes: 1024 * 1024,
    maxClientsPerRoom: 8,
    requestTimeoutMs: 2000,
    tunnelIdleMs: 60_000,
    probePort: 0,
    stunPort: 0,
    apns: null,
    fcm: null,
    role: 1,
    abuse: {
      requestsPerMinute: 300,
      burst: 0,
      bytesPerDay: 5 * 1024 * 1024 * 1024,
      bytesPerDayFree: 500 * 1024 * 1024,
      requestsPerMinutePerIp: 1200,
      bytesPerDayPerIp: 2 * 1024 * 1024 * 1024,
      probeRepliesPerSecond: 200,
      probeRepliesPerSecondPerSource: 5,
      trafficAlertBytesPerDay: 500 * 1024 * 1024,
      trafficAlertBytesPerDayPaid: 5 * 1024 * 1024 * 1024,
      trafficAlertGrowthFactor: 8,
    },
    accounts: {
      enabled: true,
      dataDir: join(dir, 'accounts'),
      adminPasswordHash: '',
      internalSecret: SECRET,
      reportTo: '',
      reportId: 'test-account',
      gravatar: { enabled: false, baseURLs: [] },
      appleAudiences: ['me.shirazu.dshmizar'],
      appleKeysURL: 'https://appleid.test/auth/keys',
      appstore: {
        bundleId: 'me.shirazu.dshmizar',
        productId: 'me.shirazu.dshmizar.paid.monthly',
        allowSandbox: true,
        notificationsEnabled: true,
      },
      publicBaseURL: 'https://accounts.test',
      paidGate: { mode: 'enforce', allowUnaccounted: false, allowFreeAccounts: overrides.allowFree === true, cacheTtlMs: 60_000 },
    },
    ...(overrides.surveysUpstream === undefined
      ? {}
      : { surveys: { enabled: false, dataDir: '', upstreamURL: overrides.surveysUpstream } }),
    ...(overrides.internal === undefined ? {} : { internal: overrides.internal }),
  }
}

/** An origin-relay config that hosts the surveys. */
function originConfig(port: number): RelayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    tokens: [],
    trustProxy: true,
    maxTunnelsPerIp: 8,
    maxRooms: 100,
    maxBodyBytes: 1024 * 1024,
    maxMessageBytes: 1024 * 1024,
    maxClientsPerRoom: 8,
    requestTimeoutMs: 2000,
    tunnelIdleMs: 60_000,
    probePort: 0,
    stunPort: 0,
    apns: null,
    fcm: null,
    role: 0,
    accounts: null,
    mail: null,
    surveys: { enabled: true, dataDir: join(dir, 'surveys'), upstreamURL: '' },
    internal: { secret: SECRET, host: '127.0.0.1', port },
  }
}

async function boot(config: RelayConfig): Promise<{ relay: Relay; base: string }> {
  const accounts = config.accounts
  if (accounts !== null && accounts !== undefined && accounts.adminPasswordHash === '') {
    config = {
      ...config,
      accounts: { ...accounts, adminPasswordHash: await hashPassword('admin-password', FAST) },
    }
  }
  const relay = await startRelay(config, () => undefined, {
    now: () => APPSTORE_NOW,
    passwordParams: FAST,
    appstoreRoots: [APPSTORE_TEST_ROOT],
  })
  relays.push(relay)
  return { relay, base: `http://127.0.0.1:${relay.port}` }
}

function device(id = 'device-0001', platform = 'ios'): Record<string, unknown> {
  return { id, name: `iPhone ${id}`, model: 'iPhone18,1', platform, appVersion: '0.10.0' }
}

async function json(
  base: string,
  path: string,
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

async function adminLogin(base: string): Promise<string> {
  const response = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-password' }),
    redirect: 'manual',
  })
  expect(response.status).toBe(303)
  return String(response.headers.get('set-cookie')).split(';')[0] ?? ''
}

async function csrfFrom(base: string, cookie: string, path: string): Promise<string> {
  const html = await (await fetch(`${base}${path}`, { headers: { cookie } })).text()
  const match = /name="_csrf" value="([^"]+)"/.exec(html)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

async function register(base: string, username = 'shirazu'): Promise<{ token: string; user: Record<string, unknown> }> {
  const reply = await json(base, '/account/v1/register', {
    username,
    email: `${username}@example.com`,
    password: 'correct horse battery',
    device: device(),
  })
  expect(reply.status).toBe(200)
  return { token: String(reply.body['token']), user: reply.body['user'] as Record<string, unknown> }
}

it('carries a free account only when the free lane is on', async () => {
  // Unit: the gate's two answers for the same free account.
  const off = new PaidGate({
    store: {
      setEntitlementListener: () => undefined,
      tokenEntitlement: () => ({ ok: true, userId: 'u1', paid: false, paidUntil: null }),
    } as never,
    mode: 'enforce',
    allowUnaccounted: false,
    allowFreeAccounts: false,
    cacheTtlMs: 0,
  })
  expect(off.authorize({ 'x-mizar-session': 'mza_' + 'a'.repeat(40) })).toMatchObject({
    allowed: false,
    code: 'PAID_REQUIRED',
  })

  const on = new PaidGate({
    store: {
      setEntitlementListener: () => undefined,
      tokenEntitlement: () => ({ ok: true, userId: 'u1', paid: false, paidUntil: null }),
    } as never,
    mode: 'enforce',
    allowUnaccounted: false,
    allowFreeAccounts: true,
    cacheTtlMs: 60_000,
  })
  const first = on.authorize({ 'x-mizar-session': 'mza_' + 'a'.repeat(40) })
  expect(first).toMatchObject({ allowed: true, userId: 'u1', paidUntil: null, cached: false })
  const second = on.authorize({ 'x-mizar-session': 'mza_' + 'a'.repeat(40) })
  expect(second).toMatchObject({ allowed: true, userId: 'u1', cached: true })
})

it('gives a free identity the free ceiling and a paid one the paid ceiling', () => {
  const quota = new DataQuota({
    requestsPerMinute: 0,
    bytesPerDay: 5000,
    bytesPerDayFor: (identity) => (identity === 'account:paid' ? 5000 : 1000),
  })
  // A free identity spends the free allowance and is refused past it.
  expect(quota.admit('account:free', 900).allowed).toBe(true)
  expect(quota.admit('account:free', 200)).toMatchObject({ allowed: false, reason: 'budget' })
  // The paid identity on the same meter still has its own allowance.
  expect(quota.admit('account:paid', 4900).allowed).toBe(true)
  expect(quota.admit('account:paid', 200)).toMatchObject({ allowed: false, reason: 'budget' })
  // Frames and post-hoc charges use the same ceiling.
  const fresh = new DataQuota({
    requestsPerMinute: 0,
    bytesPerDay: 5000,
    bytesPerDayFor: (identity) => (identity === 'account:paid' ? 5000 : 1000),
  })
  expect(fresh.carry('account:free', 900).allowed).toBe(true)
  fresh.charge('account:free', 200)
  expect(fresh.carry('account:free', 1)).toMatchObject({ allowed: false, reason: 'budget' })
})

it('broadcasts an announcement to a phone socket and answers the polling twin', async () => {
  const { relay, base } = await boot(accountConfig({ internal: { secret: SECRET, host: '127.0.0.1', port: 0 } }))
  const { token } = await register(base)

  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/app/v1/announcements`, {
    headers: { 'x-mizar-session': token },
  })
  const frames: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  socket.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>)
    for (const waiter of waiters.splice(0)) waiter()
  })
  const waitFor = async (type: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 4000
    for (;;) {
      const found = frames.find((frame) => frame['type'] === type)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`no ${type} frame arrived`)
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 100)
      })
    }
  }
  expect((await waitFor('snapshot'))['type']).toBe('snapshot')

  const created = await json(
    `http://127.0.0.1:${relay.internalPort}`,
    '/internal/v1/announcements',
    {
      title: '0.9.9 is out',
      body: 'Update from TestFlight.',
      buttonLabel: 'Open settings',
      buttonTarget: 'notifications',
      minutes: 60,
    },
    undefined,
    { authorization: `Bearer ${SECRET}` },
  )
  expect(created.status).toBe(200)

  const broadcast = await waitFor('announcement')
  expect((broadcast['announcement'] as Record<string, unknown>)['title']).toBe('0.9.9 is out')
  socket.close()

  const listed = await fetch(`${base}/account/v1/announcements`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(listed.status).toBe(200)
  const body = (await listed.json()) as { announcements?: Array<Record<string, unknown>> }
  expect(body.announcements?.length).toBe(1)
  expect(body.announcements?.[0]?.['button']).toEqual({ label: 'Open settings', target: 'notifications' })
})

it('stores a survey on the origin relay and pays for it exactly once', async () => {
  // The origin relay: no accounts, survey store, private listener.
  const origin = await boot(originConfig(0))
  const originInternal = `http://127.0.0.1:${origin.relay.internalPort}`
  const defined = await json(`${originInternal}/internal/v1/surveys/definitions`, '', {
    id: 'launch-feedback',
    title: 'How did the launch go?',
    summary: 'Two questions.',
    rewardDays: 7,
    questions: [
      {
        id: 'useful',
        type: 'single',
        prompt: 'Did it work?',
        required: true,
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
      { id: 'more', type: 'text', prompt: 'Anything else?', required: false, maxLength: 200 },
    ],
  }, undefined, { authorization: `Bearer ${SECRET}` })
  expect(defined.status).toBe(200)

  // The account relay reaches the origin over the private listener.
  const account = await boot(accountConfig({ surveysUpstream: originInternal }))
  const { token } = await register(account.base)

  const listed = await fetch(`${account.base}/account/v1/surveys`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(listed.status).toBe(200)
  const body = (await listed.json()) as { surveys?: Array<Record<string, unknown>> }
  expect(body.surveys?.length).toBe(1)
  expect(body.surveys?.[0]?.['completed']).toBe(false)

  const submitted = await json(
    account.base,
    '/account/v1/surveys/submit',
    {
      surveyId: 'launch-feedback',
      answers: [
        { questionId: 'useful', value: 'yes' },
        { questionId: 'more', value: 'Nothing.' },
      ],
    },
    token,
  )
  expect(submitted.status).toBe(200)
  const paidUntil = Number((submitted.body['user'] as Record<string, unknown>)['paidUntil'])
  expect(paidUntil).toBeGreaterThan(APPSTORE_NOW + 6.9 * 86_400_000)

  // The origin has the answer, under the account's id.
  const stored = await fetch(`${originInternal}/internal/v1/surveys/responses`, {
    headers: { authorization: `Bearer ${SECRET}` },
  })
  const storedBody = (await stored.json()) as { responses?: Array<Record<string, unknown>> }
  expect(storedBody.responses?.length).toBe(1)
  expect(storedBody.responses?.[0]?.['surveyId']).toBe('launch-feedback')

  // And the second submission is refused without paying twice.
  const again = await json(
    account.base,
    '/account/v1/surveys/submit',
    { surveyId: 'launch-feedback', answers: [{ questionId: 'useful', value: 'no' }] },
    token,
  )
  expect(again.status).toBe(409)
  expect(again.body['error']).toBe('SURVEY_ALREADY_DONE')

  const after = await fetch(`${account.base}/account/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  const afterBody = (await after.json()) as { user?: Record<string, unknown> }
  expect(Number(afterBody.user?.['paidUntil'])).toBe(paidUntil)
})

it('refuses a second redemption of a once-per-account invite, by the same account only', async () => {
  const { relay, base } = await boot(accountConfig({ internal: { secret: SECRET, host: '127.0.0.1', port: 0 } }))
  const invite = await json(
    `http://127.0.0.1:${relay.internalPort}/internal/v1/invites`,
    '',
    { code: 'TESTFLIGHT-30', days: 30, maxUses: 100, oncePerAccount: true },
    undefined,
    { authorization: `Bearer ${SECRET}` },
  )
  expect(invite.status).toBe(200)

  const first = await register(base, 'first-user')
  const redeemed = await json(base, '/account/v1/invite/redeem', { code: 'TESTFLIGHT-30' }, first.token)
  expect(redeemed.status).toBe(200)
  const again = await json(base, '/account/v1/invite/redeem', { code: 'TESTFLIGHT-30' }, first.token)
  expect(again.status).toBe(400)
  expect(again.body['error']).toBe('INVITE_ALREADY_USED')

  // Somebody else still can.
  const second = await register(base, 'second-user')
  const other = await json(base, '/account/v1/invite/redeem', { code: 'TESTFLIGHT-30' }, second.token)
  expect(other.status).toBe(200)
})

it('sends a banner from the admin page and lists it afterwards', async () => {
  const { base } = await boot(accountConfig({ internal: { secret: SECRET, host: '127.0.0.1', port: 0 } }))
  const cookie = await adminLogin(base)
  const csrf = await csrfFrom(base, cookie, '/admin/announcements')
  const sent = await fetch(`${base}/admin/announcements`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      _csrf: csrf,
      title: 'Admin banner',
      body: 'Sent from the panel.',
      symbol: 'megaphone.fill',
      tone: 'info',
      buttonLabel: 'Open logs',
      buttonTarget: 'logs',
      minutes: '30',
    }),
    redirect: 'manual',
  })
  expect(sent.status).toBe(303)
  const page = await fetch(`${base}/admin/announcements`, { headers: { cookie } })
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('Admin banner')
  expect(html).toContain('Open logs')
  expect(html).toContain('logs')
})

it('renders the questionnaires page even when no origin is configured', async () => {
  // The page exists on every account relay; without an upstream it says so
  // instead of failing the whole admin session.
  const { base } = await boot(accountConfig())
  const cookie = await adminLogin(base)
  const page = await fetch(`${base}/admin/surveys`, { headers: { cookie } })
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html.length).toBeGreaterThan(200)
})

it('refuses an announcement socket with no session', async () => {
  const { relay } = await boot(accountConfig({ internal: { secret: SECRET, host: '127.0.0.1', port: 0 } }))
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/app/v1/announcements`)
  const status = await new Promise<number>((resolve, reject) => {
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    socket.on('open', () => reject(new Error('the socket opened without a session')))
    socket.on('error', () => undefined)
    setTimeout(() => reject(new Error('no answer to the unauthenticated upgrade')), 3000)
  })
  expect(status).toBe(401)
  socket.terminate()
})
