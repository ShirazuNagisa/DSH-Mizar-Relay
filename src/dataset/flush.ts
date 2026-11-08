/**
 * The 04:00 flush: package one day of cached batches, ship them, then delete.
 *
 * Run by a systemd timer on the account relay (role 1). The order matters and is
 * the contract: build the archive, POST it, verify the receiver's sha256, and
 * only then unlink the batches that went into it. A failed transfer leaves the
 * cache exactly as it was, so the next run is a retry rather than a loss.
 *
 * @module dsh-mizar-relay/dataset/flush
 */
import { createHash, createHmac } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'

export interface FlushOptions {
  readonly dataDir: string
  readonly receiveURL: string
  readonly secret: string
  readonly now?: () => number
  readonly log?: (message: string) => void
  readonly fetchImpl?: typeof fetch
}

export interface FlushResult {
  readonly archives: number
  readonly turns: number
  readonly bytes: number
  readonly archive: string | null
}

interface Batch {
  readonly path: string
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

/**
 * One flush. Exported so a test can run it without a timer or a server.
 */
export async function flushOnce(options: FlushOptions): Promise<FlushResult> {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  if (options.receiveURL === '' || options.secret === '') {
    throw new Error('dataset.receiveURL and dataset.secret are required to flush')
  }

  const incoming = join(options.dataDir, 'dataset', 'incoming')
  const batches = await findBatches(incoming)
  if (batches.length === 0) {
    log('dataset: nothing to flush')
    return { archives: 0, turns: 0, bytes: 0, archive: null }
  }

  const staging = await mkdtemp(join(tmpdir(), 'mizar-dataset-'))
  try {
    await mkdir(join(staging, 'batches'), { recursive: true, mode: 0o700 })
    let turns = 0
    const rows: Array<Record<string, unknown>> = []
    for (const batch of batches) {
      const name = relative(incoming, batch.path).replaceAll('\\', '/')
      const target = join(staging, 'batches', name.replaceAll('/', '__'))
      await copyFile(batch.path, target)
      const metaPath = batch.path.replace(/\.ndjson$/, '.meta.json')
      let meta: Record<string, unknown> = {}
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
      } catch {
        // A batch without meta is still usable; the turn count is only a
        // manifest convenience.
      }
      const count = typeof meta['turns'] === 'number' ? meta['turns'] : 0
      turns += count
      rows.push({
        batchId: typeof meta['batchId'] === 'string' ? meta['batchId'] : batch.name,
        turns: count,
        bytes: batch.bytes,
        sha256: batch.sha256,
      })
    }

    const manifest = {
      v: 1,
      generatedAt: new Date(now()).toISOString(),
      turns,
      bytes: batches.reduce((sum, batch) => sum + batch.bytes, 0),
      batches: rows,
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })

    const iso = new Date(now()).toISOString()
    const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
    const archive = join(staging, `dataset-${stamp}.tar.gz`)
    await tar(archive, staging)
    const bytes = (await stat(archive)).size
    const sha256 = await fileSha(archive)

    const signed = new Date(now()).toISOString()
    // One clock read for the header and the signature: reading it twice can
    // straddle a second boundary, and the receiver would refuse a request the
    // sender believed it had signed correctly.
    const stampSeconds = Math.floor(now() / 1000)
    const signature = hmac(`${stampSeconds}.${sha256}`, options.secret)
    const fetchImpl = options.fetchImpl ?? fetch
    const response = await fetchImpl(options.receiveURL, {
      method: 'POST',
      headers: {
        'content-type': 'application/gzip',
        'x-mizar-timestamp': String(stampSeconds),
        'x-mizar-signature': `sha256=${signature}`,
        'x-mizar-archive': `dataset-${stamp}.tar.gz`,
        'x-mizar-sha256': sha256,
      },
      body: Readable.toWeb(createReadStream(archive)) as unknown as NonNullable<RequestInit['body']>,
      // Node's fetch needs this for a streaming body; TypeScript's DOM type does
      // not know it yet.
      duplex: 'half',
      signal: AbortSignal.timeout(10 * 60_000),
    } as RequestInit)

    let answer: Record<string, unknown> = {}
    try {
      answer = (await response.json()) as Record<string, unknown>
    } catch {
      // A 2xx without a JSON body is still an acknowledgement from a receiver
      // that said what it was; the hash was verified before it answered.
    }
    if (!response.ok) {
      throw new Error(`receiver answered ${response.status}`)
    }
    if (typeof answer['sha256'] === 'string' && answer['sha256'] !== sha256) {
      throw new Error('receiver acknowledged a different sha256')
    }

    await removeBatches(incoming, batches)
    log(
      `dataset: flushed ${batches.length} batches / ${turns} turns / ${bytes} bytes at ${signed}`,
    )
    return { archives: 1, turns, bytes, archive }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function findBatches(dir: string): Promise<Batch[]> {
  const out: Batch[] = []
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.ndjson')) {
        const info = await stat(path)
        out.push({ path, name: entry.name, bytes: info.size, sha256: await fileSha(path) })
      }
    }
  }
  await walk(dir)
  out.sort((left, right) => (left.path < right.path ? -1 : 1))
  return out
}

async function removeBatches(incoming: string, batches: readonly Batch[]): Promise<void> {
  const days = new Set<string>()
  for (const batch of batches) {
    days.add(dirname(batch.path))
    await unlink(batch.path).catch(() => undefined)
    await unlink(batch.path.replace(/\.ndjson$/, '.meta.json')).catch(() => undefined)
  }
  for (const day of days) {
    try {
      const left = await readdir(day)
      if (left.length === 0) {
        await rm(day, { recursive: false, force: true })
        // The date directory's parent (`incoming`) is left in place.
      }
    } catch {
      // Another flush or an operator may have removed it; nothing to do.
    }
  }
  // Keep the root itself even when the last day went, so the next ingest has a
  // directory to write into without a race.
  await mkdir(incoming, { recursive: true, mode: 0o700 }).catch(() => undefined)
}

function tar(archive: string, staging: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Run tar inside the staging directory and name the archive relatively.
    // GNU tar (Git Bash on Windows) reads the drive letter in an absolute
    // `D:\\...` path as an rsh host — "tar: Cannot connect to D: resolve
    // failed", exit 2 — so the flush fails before it ever reaches the receiver.
    // A bare file name is unambiguous for both GNU tar and bsdtar.
    const child = spawn('tar', ['-czf', basename(archive), 'manifest.json', 'batches'], {
      cwd: staging,
      stdio: 'ignore',
      timeout: 120_000,
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)),
    )
  })
}

function fileSha(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function hmac(text: string, secret: string): string {
  // Kept in one place so the sender and receiver cannot disagree about what the
  // signature covers.
  return createHmac('sha256', secret).update(text).digest('hex')
}

/** Run when invoked by the timer, not when imported by a test. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--config')
  const path = index >= 0 ? args[index + 1] : undefined
  void (async () => {
    const config = loadConfig(path)
    const dataset = config.dataset ?? null
    if (dataset === null || !dataset.enabled) {
      console.error('dataset: not configured or disabled')
      process.exit(1)
    }
    if (config.role !== 1) {
      console.error('dataset: flush runs on the account relay (role 1)')
      process.exit(1)
    }
    try {
      const result = await flushOnce({
        dataDir: dataset.dataDir,
        receiveURL: dataset.receiveURL,
        secret: dataset.secret,
        log: (message) => console.log(message),
      })
      if (result.archives === 0) process.exit(0)
    } catch (error) {
      console.error(`dataset: flush failed: ${(error as Error).message}`)
      process.exit(1)
    }
  })()
}
