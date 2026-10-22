/**
 * The mail queue: accept a mail, persist it, and keep trying to deliver it.
 *
 * Registration must not fail because the provider had a bad second, and a ban
 * notice must not be lost because the process restarted between the decision
 * and the send. Both are the same requirement: the decision is written down
 * before the delivery is attempted, and delivery retries on its own.
 *
 * The queue is a JSON file next to the relay's config. It holds rendered
 * template ids and variables, never a password or a session token.
 *
 * @module dsh-mizar-relay/mail/service
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ensurePrivateDir, readJsonFile, writeJsonAtomic } from '../accounts/state.js'
import { renderMail, type TemplateIds } from './templates.js'
import type { MailMessage, MailTransport } from './types.js'

/** How many items one flush will attempt. */
const BATCH = 20

/** Backoff between attempts. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]

/** How long a recipient's send history is kept. */
const WINDOW_MS = 3_600_000

/** One queued mail. */
interface QueueItem {
  readonly id: string
  readonly message: MailMessage
  attempts: number
  nextAt: number
  readonly createdAt: number
  lastError?: string
}

/** The persisted file. */
interface QueueFile {
  version: 1
  items: QueueItem[]
}

/** What the service needs. */
export interface MailServiceOptions {
  readonly dataDir: string
  readonly transport: MailTransport
  readonly templateIds: TemplateIds
  readonly limits: { readonly perRecipientPerHour: number; readonly globalPerHour: number }
  readonly now?: () => number
  readonly log?: (message: string) => void
  /** For tests: do not start the retry timer. */
  readonly manual?: boolean
  /** For tests: do not attempt a send from `enqueue`. */
  readonly lazy?: boolean
}

/** The queue. */
export class MailService {
  readonly #path: string
  readonly #transport: MailTransport
  readonly #templateIds: TemplateIds
  readonly #limits: MailServiceOptions['limits']
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #lazy: boolean
  readonly #items: QueueItem[] = []
  readonly #sentByRecipient = new Map<string, number[]>()
  #sentGlobal: number[] = []
  #sent = 0
  #failed = 0
  #lastError: string | null = null
  #timer: NodeJS.Timeout | null = null
  #closed = false
  #flushing: Promise<void> | null = null

  private constructor(options: MailServiceOptions) {
    this.#path = join(options.dataDir, 'mail-queue.json')
    this.#transport = options.transport
    this.#templateIds = options.templateIds
    this.#limits = options.limits
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => undefined)
    this.#lazy = options.lazy === true
  }

  /** Open the queue and load anything left from the last process. */
  static async open(options: MailServiceOptions): Promise<MailService> {
    const service = new MailService(options)
    await ensurePrivateDir(options.dataDir)
    const file = await readJsonFile<QueueFile | null>(service.#path, null).catch((error: unknown) => {
      service.#log(`mail: queue file unreadable (${(error as Error).message}); starting empty`)
      return null
    })
    if (file !== null && file.version === 1) {
      for (const item of file.items ?? []) service.#items.push(item)
    }
    if (options.manual !== true) {
      service.#timer = setInterval(() => {
        void service.flush()
      }, 30_000)
      service.#timer.unref?.()
    }
    return service
  }

  /** Counters for `/healthz`. */
  get status(): { queued: number; sent: number; failed: number; lastError: string | null; transport: string } {
    return {
      queued: this.#items.length,
      sent: this.#sent,
      failed: this.#failed,
      lastError: this.#lastError,
      transport: this.#transport.name,
    }
  }

  /**
   * Accept one mail.
   *
   * @param message - kind, recipient and variables.
   * @returns the queue id.
   */
  async enqueue(message: MailMessage): Promise<{ id: string }> {
    const id = randomUUID()
    const item: QueueItem = {
      id,
      message,
      attempts: 0,
      nextAt: this.#now(),
      createdAt: this.#now(),
    }
    this.#items.push(item)
    await this.#save()
    if (!this.#lazy) void this.flush()
    return { id }
  }

  /**
   * Attempt every due item once.
   *
   * Serialized: two flushes at the same time would double-send an item that is
   * still in the queue while the first send is in flight.
   */
  async flush(): Promise<void> {
    if (this.#closed) return
    if (this.#flushing !== null) return this.#flushing
    this.#flushing = this.#flushOnce().finally(() => {
      this.#flushing = null
    })
    return this.#flushing
  }

  /** Close the timer and persist one last time. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    await this.#save()
  }

  /** The real flush. */
  async #flushOnce(): Promise<void> {
    const now = this.#now()
    this.#prune(now)
    let attempted = 0
    for (const item of [...this.#items]) {
      if (attempted >= BATCH) break
      if (item.nextAt > now) continue
      if (!this.#maySend(item.message.to, now)) {
        item.nextAt = now + 60_000
        continue
      }
      attempted += 1
      try {
        const mail = renderMail(item.message, this.#templateIds)
        await this.#transport.send(mail)
        this.#recordSent(item.message.to, now)
        this.#items.splice(this.#items.indexOf(item), 1)
        this.#sent += 1
      } catch (error) {
        item.attempts += 1
        item.lastError = error instanceof Error ? error.message : String(error)
        this.#lastError = item.lastError
        item.nextAt = now + (BACKOFF_MS[Math.min(item.attempts - 1, BACKOFF_MS.length - 1)] ?? 3_600_000)
        if (item.attempts >= BACKOFF_MS.length) {
          this.#items.splice(this.#items.indexOf(item), 1)
          this.#failed += 1
          this.#log(`mail: giving up on ${item.message.kind} to ${redact(item.message.to)}: ${item.lastError}`)
        } else {
          this.#log(`mail: ${item.message.kind} to ${redact(item.message.to)} failed: ${item.lastError}`)
        }
      }
    }
    await this.#save()
  }

  /** Whether the per-recipient and global hourly limits allow one more. */
  #maySend(recipient: string, now: number): boolean {
    const recent = (this.#sentByRecipient.get(recipient) ?? []).filter((at) => now - at < WINDOW_MS)
    this.#sentByRecipient.set(recipient, recent)
    if (recent.length >= this.#limits.perRecipientPerHour) return false
    this.#sentGlobal = this.#sentGlobal.filter((at) => now - at < WINDOW_MS)
    return this.#sentGlobal.length < this.#limits.globalPerHour
  }

  /** Remember one successful send. */
  #recordSent(recipient: string, now: number): void {
    const list = this.#sentByRecipient.get(recipient) ?? []
    list.push(now)
    this.#sentByRecipient.set(recipient, list)
    this.#sentGlobal.push(now)
  }

  /** Drop history outside the window. */
  #prune(now: number): void {
    this.#sentGlobal = this.#sentGlobal.filter((at) => now - at < WINDOW_MS)
    for (const [recipient, list] of this.#sentByRecipient) {
      const recent = list.filter((at) => now - at < WINDOW_MS)
      if (recent.length === 0) this.#sentByRecipient.delete(recipient)
      else this.#sentByRecipient.set(recipient, recent)
    }
  }

  /** Persist the queue. */
  async #save(): Promise<void> {
    try {
      await writeJsonAtomic(this.#path, { version: 1, items: this.#items } satisfies QueueFile)
    } catch (error) {
      this.#log(`mail: could not persist queue: ${(error as Error).message}`)
    }
  }
}

/** `a***@example.com`, for a log line. */
export function redact(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}
