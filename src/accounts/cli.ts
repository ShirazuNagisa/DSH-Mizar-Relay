/**
 * Account-service command line helpers for the installer and an operator.
 *
 * Three jobs, and all three exist because the alternative is asking somebody to
 * hand-write a scrypt hash into JSON:
 *
 *   - `hash-password <password>` prints an encoded hash.
 *   - `admin-secret` generates a random admin password and its hash.
 *   - `configure` merges role/account fields into an existing relay.config.json
 *     without touching tokens, APNs, or FCM.
 *
 * Nothing here prints a tunnel token or an existing APNs key.
 *
 * @module dsh-mizar-relay/accounts/cli
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { loadConfig } from '../config.js'
import { hashPassword } from './passwords.js'
import { writeJsonAtomic } from './state.js'
import { AccountStore } from './store.js'

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'hash-password': {
      const password = rest[0]
      if (password === undefined || password === '') throw new Error('usage: hash-password <password>')
      process.stdout.write(`${await hashPassword(password)}\n`)
      return
    }
    case 'admin-secret': {
      const password = randomBytes(18).toString('base64url').slice(0, 20)
      const hash = await hashPassword(password)
      process.stdout.write(`${JSON.stringify({ password, hash })}\n`)
      return
    }
    case 'generate-code': {
      process.stdout.write(`${generateCode()}\n`)
      return
    }
    case 'configure': {
      await configure(rest)
      return
    }
    case 'create-user': {
      await createUser(rest)
      return
    }
    default:
      throw new Error(
        'usage: cli.js <hash-password|admin-secret|generate-code|configure|create-user> ...',
      )
  }
}

/**
 * Create one verified account, for App Review and for support.
 *
 * The password reset flow needs a mailbox; a reviewer does not have one, so the
 * demo account is made here with `emailVerified: true` and never goes through
 * the code path.
 */
async function createUser(args: readonly string[]): Promise<void> {
  const options = parseFlags(args)
  const configPath = options.get('config')
  const username = options.get('username')
  const email = options.get('email')
  const password = options.get('password')
  if (configPath === undefined || username === undefined || email === undefined || password === undefined) {
    throw new Error('usage: create-user --config <relay.config.json> --username <name> --email <address> --password <password>')
  }
  const config = loadConfig(configPath)
  const accounts = config.accounts
  if (accounts === null) throw new Error('accounts are not enabled in that config')
  const store = await AccountStore.open({
    dataDir: accounts.dataDir,
    gravatar: accounts.gravatar,
    apple: { audiences: accounts.appleAudiences, keysURL: accounts.appleKeysURL },
    appstore: {
      bundleId: accounts.appstore.bundleId,
      productId: accounts.appstore.productId,
      allowSandbox: accounts.appstore.allowSandbox,
    },
    log: (message) => process.stderr.write(`${message}\n`),
  })
  try {
    const result = await store.register({
      username,
      email,
      password,
      emailVerified: true,
      device: {
        id: 'review-demo-01',
        name: 'App Review',
        model: 'iPhone',
        platform: 'ios',
        appVersion: '0.9.5',
      },
    })
    process.stdout.write(`${JSON.stringify({ userId: result.user.id, username: result.user.username })}\n`)
  } finally {
    await store.close()
  }
}

/** Merge account/role fields into an existing config file. */
async function configure(args: readonly string[]): Promise<void> {
  const options = parseFlags(args)
  const path = options.get('config')
  if (path === undefined || path === '') throw new Error('configure needs --config <path>')
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (options.has('role')) {
    const role = Number(options.get('role'))
    if (role !== 0 && role !== 1) throw new Error('--role must be 0 or 1')
    current['role'] = role
  }
  if (options.has('enable-accounts') || options.has('disable-accounts') || options.has('report-to') || options.has('report-id') || options.has('internal-secret') || options.has('data-dir') || options.has('admin-password-hash') || options.has('product-id') || options.has('public-base-url') || options.has('appstore-bundle-id') || options.has('appstore-allow-sandbox') || options.has('gravatar-base-urls') || options.has('apple-audiences') || options.has('apple-keys-url')) {
    const existing = typeof current['accounts'] === 'object' && current['accounts'] !== null
      ? (current['accounts'] as Record<string, unknown>)
      : {}
    const accounts: Record<string, unknown> = { ...existing }
    if (options.has('enable-accounts')) accounts['enabled'] = true
    if (options.has('disable-accounts')) accounts['enabled'] = false
    for (const [flag, key] of [
      ['data-dir', 'dataDir'],
      ['admin-password-hash', 'adminPasswordHash'],
      ['internal-secret', 'internalSecret'],
      ['report-to', 'reportTo'],
      ['report-id', 'reportId'],
      ['public-base-url', 'publicBaseURL'],
    ] as const) {
      const value = options.get(flag)
      if (value !== undefined) accounts[key] = value
    }
    const productId = options.get('product-id')
    const bundleId = options.get('appstore-bundle-id')
    const allowSandbox = options.get('appstore-allow-sandbox')
    if (productId !== undefined || bundleId !== undefined || allowSandbox !== undefined) {
      const appstore = {
        ...(typeof accounts['appstore'] === 'object' && accounts['appstore'] !== null
          ? (accounts['appstore'] as Record<string, unknown>)
          : {}),
        ...(productId === undefined ? {} : { productId }),
        ...(bundleId === undefined ? {} : { bundleId }),
        ...(allowSandbox === undefined ? {} : { allowSandbox: allowSandbox === '1' || allowSandbox === 'true' }),
      }
      accounts['appstore'] = appstore
    }
    const gravatarURLs = options.get('gravatar-base-urls')
    if (gravatarURLs !== undefined) {
      accounts['gravatar'] = {
        enabled: true,
        baseURLs: gravatarURLs.split(',').map((value) => value.trim()).filter((value) => value !== ''),
      }
    }
    const appleAudiences = options.get('apple-audiences')
    if (appleAudiences !== undefined) {
      accounts['appleAudiences'] = appleAudiences.split(',').map((value) => value.trim()).filter((value) => value !== '')
    }
    const appleKeysURL = options.get('apple-keys-url')
    if (appleKeysURL !== undefined) accounts['appleKeysURL'] = appleKeysURL
    current['accounts'] = accounts
  }
  await writeJsonAtomic(path, current)
  process.stdout.write(`${path} updated\n`)
}

/** Parse `--key value` and `--flag` pairs. */
function parseFlags(args: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined || !arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, '')
    }
  }
  return out
}

/** A readable code in the same shape as the store's generated codes. */
function generateCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = randomBytes(12)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return `MZ-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
