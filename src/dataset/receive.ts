/**
 * `POST /dataset/v1/receive` — the free relay's archive door.
 *
 * The account relay sends one signed `tar.gz` a day. There is no account and no
 * session token on this path: the only credential is an HMAC over the body,
 * shared out of band, plus a timestamp that makes a captured request useless
 * after five minutes. The archive is streamed to disk while it is hashed, so a
 * 500 MB day never sits in memory.
 *
 * @module dsh-mizar-relay/dataset/receive
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { writeJson } from '../http.js'

/** How far a signed request's clock may be from this machine's. */
const SKEW_SECONDS = 300

/** The daily archive's name, which is also the path-traversal guard. */
const ARCHIVE = /^[A-Za-z0-9._-]{1,120}\.tar\.gz$/

export interface ReceiveOptions {
  readonly dataDir: string
  readonly secret: string
  readonly maxArchiveBytes: number
  readonly now?: () => number
  readonly log?: (message: string) => void
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  return typeof value === 'string' ? value : ''
}

/**
 * Handle one archive. The caller has already decided this relay serves the
 * endpoint (role 0, dataset enabled).
 */
export async function handleDatasetReceive(
  request: IncomingMessage,
  response: ServerResponse,
  options: ReceiveOptions,
): Promise<void> {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)

  if (options.secret === '') {
    writeJson(response, 503, { error: 'NOT_CONFIGURED' })
    return
  }

  const stamp = header(request, 'x-mizar-timestamp')
  const signature = header(request, 'x-mizar-signature')
  const archive = header(request, 'x-mizar-archive')
  const claimed = header(request, 'x-mizar-sha256')
  const seconds = Number(stamp)
  if (!Number.isFinite(seconds) || Math.abs(now() / 1000 - seconds) > SKEW_SECONDS) {
    writeJson(response, 401, { error: 'STALE' })
    return
  }
  if (!ARCHIVE.test(archive)) {
    writeJson(response, 400, { error: 'BAD_ARCHIVE' })
    return
  }
  if (!/^[0-9a-f]{64}$/.test(claimed)) {
    writeJson(response, 400, { error: 'BAD_HASH' })
    return
  }
  if (signature === '') {
    writeJson(response, 401, { error: 'BAD_SIGNATURE' })
    return
  }
  const declared = Number(header(request, 'content-length'))
  if (Number.isFinite(declared) && declared > options.maxArchiveBytes) {
    writeJson(response, 413, { error: 'TOO_LARGE' })
    return
  }

  const root = join(options.dataDir, 'dataset')
  const tempDir = join(root, 'receive')
  await mkdir(tempDir, { recursive: true, mode: 0o700 })
  const temp = join(tempDir, `${process.pid}-${now()}.part`)

  const hash = createHash('sha256')
  const sink = createWriteStream(temp, { mode: 0o600 })
  let bytes = 0
  let overflow = false
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer
      bytes += buffer.length
      if (bytes > options.maxArchiveBytes) {
        overflow = true
        break
      }
      hash.update(buffer)
      if (!sink.write(buffer)) {
        await new Promise<void>((resolve) => sink.once('drain', resolve))
      }
    }
  } catch {
    await new Promise<void>((resolve) => sink.end(resolve))
    await rm(temp, { force: true })
    writeJson(response, 400, { error: 'BODY_INCOMPLETE' })
    return
  }
  await new Promise<void>((resolve) => sink.end(resolve))
  if (overflow) {
    await rm(temp, { force: true })
    writeJson(response, 413, { error: 'TOO_LARGE' })
    return
  }

  const digest = hash.digest('hex')
  const expected = createHmac('sha256', options.secret)
    .update(`${stamp}.${digest}`)
    .digest('hex')
  if (!safeEqual(signature.replace(/^sha256=/, ''), expected)) {
    await rm(temp, { force: true })
    writeJson(response, 401, { error: 'BAD_SIGNATURE' })
    return
  }
  if (digest !== claimed) {
    await rm(temp, { force: true })
    writeJson(response, 400, { error: 'BAD_HASH' })
    return
  }

  const day = new Date(now()).toISOString().slice(0, 10)
  const finalDir = join(root, 'archive', day)
  await mkdir(finalDir, { recursive: true, mode: 0o700 })
  const final = join(finalDir, archive)
  if (await exists(final)) {
    const previous = await fileSha(final)
    if (previous === digest) {
      await rm(temp, { force: true })
      writeJson(response, 200, { ok: true, duplicate: true, sha256: digest, bytes })
      return
    }
    await rm(final, { force: true })
  }
  await rename(temp, final)
  await mkdir(join(root, 'extracted', day), { recursive: true, mode: 0o700 })
  await extract(final, join(root, 'extracted', day, archive.replace(/\.tar\.gz$/, '')), log)
  writeJson(response, 200, { ok: true, sha256: digest, bytes })
  log(`dataset: archive ${archive} stored (${bytes} bytes)`)
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Extract next to the archive; a failure is convenience lost, not data lost. */
async function extract(
  archive: string,
  into: string,
  log: (message: string) => void,
): Promise<void> {
  await mkdir(into, { recursive: true, mode: 0o700 })
  await new Promise<void>((resolve) => {
    const child = spawn('tar', ['-xzf', archive, '--no-same-owner', '-C', into], {
      stdio: 'ignore',
      timeout: 120_000,
    })
    child.on('error', (error) => {
      log(`dataset: could not extract ${archive}: ${error.message}`)
      resolve()
    })
    child.on('close', (code) => {
      if (code !== 0) log(`dataset: tar exited ${code} for ${archive}`)
      resolve()
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function fileSha(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}
