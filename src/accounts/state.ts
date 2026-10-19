/**
 * The account service's tiny persistence layer.
 *
 * One JSON file per concern, written atomically and serialized through one
 * promise chain. This is deliberately not a database: the deployment serves one
 * operator and a few thousand accounts, and a file an operator can copy for a
 * backup is worth more here than a schema. The two rules that matter are:
 *
 *   1. a reader sees either the whole old file or the whole new one (rename),
 *   2. two concurrent mutations cannot both read-modify-write the same version
 *      (one queue).
 *
 * @module dsh-mizar-relay/accounts/state
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One serialized async queue. */
export class MutationQueue {
  #tail: Promise<unknown> = Promise.resolve()

  /**
   * Run one mutation after every mutation already queued.
   *
   * A rejected mutation does not poison the queue: the next caller still runs.
   *
   * @param work - the mutation.
   * @returns what the mutation returned.
   */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work)
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/**
 * Read a JSON file, returning `fallback` when it does not exist.
 *
 * An existing file that will not parse is an error, not a fallback: silently
 * replacing a corrupt account database with an empty one loses every login.
 *
 * @param path - the file.
 * @param fallback - the value for a missing file.
 * @returns the parsed value.
 */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`)
  }
}

/**
 * Write a JSON file atomically.
 *
 * The temp file lives in the same directory as the target so `rename` is a
 * same-filesystem move. `flush` is what makes the rename meaningful after a
 * power loss; on a small file its cost is noise.
 *
 * @param path - the file.
 * @param value - the JSON value.
 * @param mode - file mode; 0600 for account data.
 */
export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  )
  const text = `${JSON.stringify(value, null, 2)}\n`
  const handle = await open(temp, 'w', mode)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/**
 * Copy a file to a `.bak` sibling if it exists.
 *
 * Called once at startup, before the first write of the process. A rotation
 * number would be nicer; a single sibling copy is enough to survive the
 * mistake this is for (a bad manual edit or a half-written upgrade).
 *
 * @param path - the file to back up.
 */
export async function backupFile(path: string): Promise<void> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return
    throw error
  }
  await writeFile(`${path}.bak`, text, { mode: 0o600 })
}

/** Ensure a directory exists with the account service's private mode. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
}
