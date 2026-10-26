/**
 * Relay configuration, and the FCM half of it in particular.
 *
 * The failure this guards against is the one that takes the tunnel down with it:
 * a relay that refuses to boot because a *notification* credential is missing or
 * malformed. Everything about push is optional, so every incomplete FCM
 * configuration has to mean `null` — and the service-account JSON has three
 * shapes it can arrive in, each of which is a chance to read the wrong field.
 *
 * @module dsh-mizar-relay/test/config
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gateStartupChecks, loadConfig, resolveAbuse, DEFAULT_ABUSE } from '../src/config.js'

let dir = ''
afterEach(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

/** A temporary directory to keep config files in. */
async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'mizar-relay-config-'))
  return dir
}

/** A service-account JSON, as the Firebase console downloads it. */
function serviceAccount(privateKey = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n'): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'mizar-test',
    private_key_id: 'key-1',
    private_key: privateKey,
    client_email: 'relay@mizar-test.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  })
}

describe('the FCM configuration', () => {
  it('is null by default, and the rest of the config still loads', async () => {
    const home = await scratch()
    const config = loadConfig(join(home, 'relay.config.json'), {})
    // No file, no environment: everything else has a default and push is off.
    // A relay that refused to start here would be a relay that cannot run
    // without a notification credential it does not need.
    expect(config.fcm).toBeNull()
    expect(config.apns).toBeNull()
    expect(config.port).toBe(8787)
  })

  it('reads the three fields out of an inline service account', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({ fcm: { serviceAccount: serviceAccount(), channelId: 'mizar-alerts' } }),
      'utf8',
    )

    const config = loadConfig(path, {})
    expect(config.fcm).toMatchObject({
      projectId: 'mizar-test',
      clientEmail: 'relay@mizar-test.iam.gserviceaccount.com',
      channelId: 'mizar-alerts',
    })
    // The PEM arrives with real newlines, because JSON's `\n` is a newline.
    expect(config.fcm?.privateKey).toContain('\nMIIabc\n')
  })

  it('reads them out of a service-account file instead', async () => {
    const home = await scratch()
    const account = join(home, 'firebase.json')
    await writeFile(account, serviceAccount(), 'utf8')
    const path = join(home, 'relay.config.json')
    await writeFile(path, JSON.stringify({ fcm: { serviceAccountFile: account } }), 'utf8')

    expect(loadConfig(path, {}).fcm).toMatchObject({ projectId: 'mizar-test' })
  })

  it('takes the fields apart when there is no service account at all', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({
        fcm: {
          projectId: 'p',
          clientEmail: 'c@example.test',
          privateKey: '-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n',
        },
      }),
      'utf8',
    )

    const config = loadConfig(path, {})
    expect(config.fcm).toMatchObject({ projectId: 'p', clientEmail: 'c@example.test' })
    // The `\n` unescaping, which is the whole reason a key pasted into an
    // environment variable is not a startup failure about PEM parsing.
    expect(config.fcm?.privateKey).toContain('\nMIIabc\n')
    // Unset rather than present-and-empty: `buildMessage` branches on absence.
    expect(config.fcm?.channelId).toBeUndefined()
    expect(config.fcm?.authority).toBeUndefined()
  })

  it('lets the environment override the file, field by field', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({ fcm: { serviceAccount: serviceAccount(), channelId: 'from-file' } }),
      'utf8',
    )

    const config = loadConfig(path, {
      MIZAR_FCM_PROJECT_ID: 'from-env',
      MIZAR_FCM_CHANNEL_ID: 'from-env',
    })
    expect(config.fcm).toMatchObject({ projectId: 'from-env', channelId: 'from-env' })
    expect(config.fcm?.clientEmail).toBe('relay@mizar-test.iam.gserviceaccount.com')
  })

  it('is null rather than fatal when the credential is unusable', async () => {
    const home = await scratch()
    for (const fcm of [
      // A file that is not there.
      { serviceAccountFile: join(home, 'missing.json') },
      // A file that is not JSON.
      { serviceAccount: 'not json at all' },
      // A JSON body with no private key, which cannot sign anything.
      { serviceAccount: JSON.stringify({ project_id: 'p', client_email: 'c' }) },
      // The fields, one of them missing.
      { projectId: 'p', clientEmail: 'c@example.test' },
    ]) {
      const path = join(home, `relay-${Math.random().toString(36).slice(2)}.json`)
      await writeFile(path, JSON.stringify({ fcm, port: 9000 }), 'utf8')
      const config = loadConfig(path, {})
      expect(config.fcm).toBeNull()
      // And the tunnel's own settings were read on the way past, which is the
      // point: a broken notification credential costs notifications and nothing
      // else.
      expect(config.port).toBe(9000)
    }
  })

  it('leaves APNs and FCM independent in both directions', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({
        apns: { keyId: 'K', teamId: 'T', topic: 'me.shirazu.dshmizar', key: 'unused' },
        fcm: { serviceAccount: serviceAccount() },
      }),
      'utf8',
    )

    const config = loadConfig(path, {})
    expect(config.apns).not.toBeNull()
    expect(config.fcm).not.toBeNull()
    // Neither key is required for the other to load, so a relay serving only
    // iPhones does not need a Google account and vice versa.
    expect(loadConfig(path, { MIZAR_FCM_SERVICE_ACCOUNT: 'broken' }).apns).not.toBeNull()
  })
})

describe('the proxy trust setting', () => {
  // The documented deployment is nginx on loopback, so the default has to be
  // on: without it the per-address tunnel limit counts the proxy and four
  // computers fill an otherwise open relay.
  it('defaults to on', () => {
    expect(loadConfig('/nonexistent-relay-config.json', {}).trustProxy).toBe(true)
  })

  it('can be turned off from the environment, in the spellings a container uses', () => {
    const path = '/nonexistent-relay-config.json'
    // `MIZAR_RELAY_TRUST_PROXY=false` must not be read as a truthy string.
    for (const value of ['false', '0', 'no', 'off', 'FALSE']) {
      expect(loadConfig(path, { MIZAR_RELAY_TRUST_PROXY: value }).trustProxy).toBe(false)
    }
    expect(loadConfig(path, { MIZAR_RELAY_TRUST_PROXY: 'true' }).trustProxy).toBe(true)
    expect(loadConfig(path, { MIZAR_RELAY_TRUST_PROXY: '1' }).trustProxy).toBe(true)
  })

  it('reads the file value when the environment does not override it', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(path, JSON.stringify({ trustProxy: false }), 'utf8')
    expect(loadConfig(path, {}).trustProxy).toBe(false)
  })
})

describe('the relay role and account service', () => {
  it('defaults to a free relay with no account service', async () => {
    const home = await scratch()
    const config = loadConfig(join(home, 'relay.config.json'), {})
    expect(config.role).toBe(0)
    expect(config.accounts).toBeNull()
  })

  it('reads the role and rejects anything that is not 0 or 1', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(path, JSON.stringify({ role: 1 }), 'utf8')
    expect(loadConfig(path, {}).role).toBe(1)
    expect(loadConfig(path, { MIZAR_RELAY_ROLE: '0' }).role).toBe(0)
    expect(() => loadConfig(path, { MIZAR_RELAY_ROLE: '2' })).toThrow(/role/)
    expect(() => loadConfig(path, { MIZAR_RELAY_ROLE: 'paid' })).toThrow(/role/)
  })

  it('reads the accounts block with defaults and environment overrides', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({
        role: 1,
        accounts: {
          enabled: true,
          dataDir: './state',
          adminPasswordHash: 'scrypt$1$1$1$c2FsdA==$aGFzaA==',
          gravatar: { enabled: false, baseURLs: ['https://mirror.test'] },
          appstore: { productId: 'me.shirazu.dshmizar.paid.monthly' },
        },
      }),
      'utf8',
    )
    const config = loadConfig(path, { MIZAR_ACCOUNT_REPORT_ID: 'from-env' })
    expect(config.role).toBe(1)
    expect(config.accounts).toMatchObject({
      enabled: true,
      dataDir: './state',
      reportId: 'from-env',
      gravatar: { enabled: false, baseURLs: ['https://mirror.test'] },
      appleAudiences: ['me.shirazu.dshmizar'],
      appstore: {
        bundleId: 'me.shirazu.dshmizar',
        productId: 'me.shirazu.dshmizar.paid.monthly',
        allowSandbox: true,
        notificationsEnabled: true,
      },
    })
    // A paid relay that owns the account store gates by default: the whole
    // point of naming a relay the paid one is that it carries paying accounts.
    expect(config.accounts?.paidGate).toEqual({
      mode: 'enforce',
      allowUnaccounted: false,
      cacheTtlMs: 60_000,
      strict: false,
    })
    const env = loadConfig(path, {
      MIZAR_ACCOUNTS_ENABLED: 'false',
      MIZAR_GRAVATAR_BASE_URLS: 'https://a.test, https://b.test',
      MIZAR_APPLE_AUDIENCES: 'me.shirazu.dshmizar,com.example.other',
      MIZAR_APPSTORE_ALLOW_SANDBOX: '0',
    })
    expect(env.accounts?.enabled).toBe(false)
    expect(env.accounts?.gravatar.baseURLs).toEqual(['https://a.test', 'https://b.test'])
    expect(env.accounts?.appleAudiences).toEqual(['me.shirazu.dshmizar', 'com.example.other'])
    expect(env.accounts?.appstore.allowSandbox).toBe(false)
    // No store, no gate: it must not report itself as enforcing.
    expect(env.accounts?.paidGate.mode).toBe('off')
  })
})

describe('the paid gate production posture', () => {
  /** A paid relay that owns the account store, as a full config. */
  async function paidRelay(paidGate: Record<string, unknown>): Promise<ReturnType<typeof loadConfig>> {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({
        role: 1,
        accounts: {
          enabled: true,
          adminPasswordHash: 'scrypt$1$1$1$c2FsdA==$aGFzaA==',
          paidGate,
        },
      }),
      'utf8',
    )
    return loadConfig(path, {})
  }

  it('is silent when the gate is enforcing and nothing is waved through', async () => {
    const config = await paidRelay({ mode: 'enforce', allowUnaccounted: false })
    expect(gateStartupChecks(config)).toEqual([])
  })

  it('names the two ways a paywall ships open', async () => {
    // `observe` counts instead of refusing, and `allowUnaccounted` waves callers
    // with no account through. Both give away the bandwidth the relay sells, so
    // each is named specifically enough to act on.
    expect(gateStartupChecks(await paidRelay({ mode: 'observe' }))).toHaveLength(1)
    expect(gateStartupChecks(await paidRelay({ mode: 'enforce', allowUnaccounted: true }))).toHaveLength(1)
    const both = gateStartupChecks(await paidRelay({ mode: 'off', allowUnaccounted: true }))
    expect(both).toHaveLength(2)
  })

  it('says nothing about a free relay, which is not supposed to gate', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(path, JSON.stringify({ role: 0 }), 'utf8')
    expect(gateStartupChecks(loadConfig(path, {}))).toEqual([])
  })
})

describe('the data-plane abuse limits', () => {
  it('enforce by default rather than waiting to be turned on', async () => {
    const home = await scratch()
    // No abuse block at all: the limits a deployment gets are the enforcing
    // ones, because a limit that defaults to off is a limit nobody turns on.
    const config = loadConfig(join(home, 'relay.config.json'), {})
    expect(config.abuse).toEqual(DEFAULT_ABUSE)
    expect(resolveAbuse(config).bytesPerDay).toBeGreaterThan(0)
  })

  it('take the environment over the file, and accept 0 as a real value', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(path, JSON.stringify({ abuse: { requestsPerMinute: 10, bytesPerDay: 1000 } }), 'utf8')
    expect(loadConfig(path, {}).abuse).toMatchObject({ requestsPerMinute: 10, bytesPerDay: 1000 })
    // `0` disables a limit and must survive the trip through the environment;
    // an empty string is still "unset".
    expect(loadConfig(path, { MIZAR_ABUSE_REQUESTS_PER_MINUTE: '0' }).abuse).toMatchObject({
      requestsPerMinute: 0,
    })
  })

  it('meter an address as well as an identity, each with its own limits', async () => {
    // The per-address pair is what survives an identity the caller invented.
    // It must default on, and it must be independently tunable: the address
    // budget stays well above the identity budget so one NAT household sharing
    // an address is never throttled for the sharing.
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({ abuse: { requestsPerMinutePerIp: 60, bytesPerDayPerIp: 4096 } }),
      'utf8',
    )
    expect(loadConfig(path, {}).abuse).toMatchObject({
      requestsPerMinutePerIp: 60,
      bytesPerDayPerIp: 4096,
    })
    expect(loadConfig(path, { MIZAR_ABUSE_BYTES_PER_DAY_PER_IP: '0' }).abuse).toMatchObject({
      bytesPerDayPerIp: 0,
    })
    // Defaults: on, and looser than the per-identity pair.
    expect(DEFAULT_ABUSE.requestsPerMinutePerIp).toBeGreaterThan(DEFAULT_ABUSE.requestsPerMinute)
    expect(DEFAULT_ABUSE.bytesPerDayPerIp).toBeGreaterThan(DEFAULT_ABUSE.bytesPerDay)
  })

  it('fall back to the defaults for a config built by hand', () => {
    // Tests and embedders construct RelayConfig literals without the block;
    // the meter asks through resolveAbuse and still gets enforcing limits.
    const bare = { abuse: undefined } as Parameters<typeof resolveAbuse>[0]
    expect(resolveAbuse(bare)).toEqual(DEFAULT_ABUSE)
  })
})
