/**
 * The installer's companion: generate and store the self-hosting secrets.
 *
 * The installer is a shell script, and the two things it must write into
 * `relay.config.json` are scrypt hashes it cannot compute. Rather than teach the
 * shell half of Node's crypto, every secret goes through this CLI: it generates
 * the plaintext, hashes it, merges the block into the config without touching
 * tokens, APNs or accounts, and prints the plaintext exactly once for the
 * installer to show.
 *
 * Nothing here reads a secret back out. `show` reports whether a secret is set,
 * which is what a re-run of the installer needs in order to decide between
 * "keep it" and "there was never one".
 *
 * Usage:
 *   selfhost-cli.js init --config <path> --domain <url> [--data-dir <dir>]
 *                        [--update-script <path>] [--auto-update true|false]
 *                        [--pin <value>] [--update-token <value>]
 *   selfhost-cli.js rotate --config <path> --pin | --update-token
 *   selfhost-cli.js show --config <path>
 *
 * @module dsh-mizar-relay/selfhost/cli
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hashPassword } from '../accounts/passwords.js'
import { DEFAULT_GITHUB_REPO } from '../config.js'

/** Crockford base32: no I, L, O or U, so a PIN cannot be misread as another. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Characters in one half of a PIN. */
const PIN_HALF = 4

/** Bytes in an update token. Thirty-two hex characters cannot be guessed. */
const TOKEN_BYTES = 16

/** The self-hosting block as this CLI writes it. */
interface StoredSelfHost {
  pinHash?: string
  updateTokenHash?: string
  publicURL?: string
  autoUpdate?: boolean
  updateScript?: string
  githubRepo?: string
  dataDir?: string
}

/** A config file this CLI is allowed to edit. */
interface EditableConfig {
  selfHost?: StoredSelfHost
  [key: string]: unknown
}

/** Parse `--key value` and `--flag` arguments. */
function parseFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined || !argument.startsWith('--')) continue
    const name = argument.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
    } else {
      flags.set(name, '')
    }
  }
  return flags
}

/** Read one flag, requiring a value. */
function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined || value === '') throw new Error(`--${name} is required`)
  return value
}

/** Generate a PIN such as `K7QP-3M2X`. */
function generatePin(): string {
  const bytes = randomBytes(PIN_HALF * 2)
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) {
    // 256 is an exact multiple of 32, so the modulo introduces no bias.
    const byte = bytes[index] ?? 0
    out += ALPHABET[byte % 32] ?? '0'
    if (index === PIN_HALF - 1) out += '-'
  }
  return out
}

/** Generate a 32-character lowercase hex token. */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/** Read a config, tolerating a missing file. */
function readConfig(path: string): EditableConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as EditableConfig
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return {}
    throw error
  }
}

/** Write a config atomically, root-only. */
function writeConfig(path: string, config: EditableConfig): void {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

/** Normalise a public origin: https only, no trailing slash. */
function normaliseOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s]+$/.test(trimmed)) {
    throw new Error(`--domain must be an origin such as https://relay.example.com, got "${value}"`)
  }
  return trimmed
}

/** Create or refresh the block. Newly generated secrets are printed once. */
async function init(flags: Map<string, string>): Promise<void> {
  const path = required(flags, 'config')
  const origin = normaliseOrigin(required(flags, 'domain'))
  const config = readConfig(path)
  const existing = config.selfHost ?? {}
  const dataDir = flags.get('data-dir') ?? existing.dataDir ?? './data'
  const updateScript = flags.get('update-script') ?? existing.updateScript ?? ''
  const autoUpdate = (flags.get('auto-update') ?? String(existing.autoUpdate ?? true)) !== 'false'

  const askedPin = flags.get('pin')
  const askedToken = flags.get('update-token')
  const pinRotated = existing.pinHash === undefined || existing.pinHash === '' || askedPin !== undefined
  const tokenRotated =
    existing.updateTokenHash === undefined || existing.updateTokenHash === '' || askedToken !== undefined

  const pin = pinRotated ? (askedPin !== undefined && askedPin !== '' ? askedPin : generatePin()) : null
  const updateToken =
    tokenRotated ? (askedToken !== undefined && askedToken !== '' ? askedToken : generateToken()) : null

  config.selfHost = {
    ...existing,
    ...(pin === null ? {} : { pinHash: await hashPassword(pin) }),
    ...(updateToken === null ? {} : { updateTokenHash: await hashPassword(updateToken) }),
    publicURL: origin,
    autoUpdate,
    updateScript,
    githubRepo: existing.githubRepo ?? DEFAULT_GITHUB_REPO,
    dataDir,
  }
  writeConfig(path, config)
  process.stdout.write(
    `${JSON.stringify({ pin, updateToken, pinRotated, updateTokenRotated: tokenRotated, origin })}\n`,
  )
}

/** Replace one secret. */
async function rotate(flags: Map<string, string>): Promise<void> {
  const path = required(flags, 'config')
  const config = readConfig(path)
  const existing = config.selfHost
  if (existing === undefined) throw new Error('this config has no selfHost block; run init first')
  if (flags.has('pin')) {
    const pin = generatePin()
    config.selfHost = { ...existing, pinHash: await hashPassword(pin) }
    writeConfig(path, config)
    process.stdout.write(`${JSON.stringify({ pin, updateToken: null })}\n`)
    return
  }
  if (flags.has('update-token')) {
    const updateToken = generateToken()
    config.selfHost = { ...existing, updateTokenHash: await hashPassword(updateToken) }
    writeConfig(path, config)
    process.stdout.write(`${JSON.stringify({ pin: null, updateToken })}\n`)
    return
  }
  throw new Error('rotate needs --pin or --update-token')
}

/** Report what is set, never what it is. */
function show(flags: Map<string, string>): void {
  const path = required(flags, 'config')
  const config = readConfig(path)
  const existing = config.selfHost
  process.stdout.write(
    `${JSON.stringify({
      configured: existing !== undefined,
      pinSet: (existing?.pinHash ?? '') !== '',
      updateTokenSet: (existing?.updateTokenHash ?? '') !== '',
      publicURL: existing?.publicURL ?? '',
      autoUpdate: existing?.autoUpdate ?? false,
      githubRepo: existing?.githubRepo ?? DEFAULT_GITHUB_REPO,
      dataDir: existing?.dataDir ?? './data',
      updateScript: existing?.updateScript ?? '',
    })}\n`,
  )
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  switch (command) {
    case 'init':
      await init(flags)
      return
    case 'rotate':
      await rotate(flags)
      return
    case 'show':
      show(flags)
      return
    default:
      throw new Error('usage: selfhost-cli.js <init|rotate|show> --config <path> ...')
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
