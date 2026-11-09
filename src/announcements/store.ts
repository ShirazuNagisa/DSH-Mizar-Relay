/**
 * Announcements: the banners the operator pushes to every online phone.
 *
 * One JSON file, one list. This is deliberately the same shape the account
 * store uses for invites -- a versioned file an operator can copy, edit or
 * restore, written atomically and serialized through one mutation queue -- and
 * not a database, because the things being stored are a handful of sentences
 * that should be readable from a shell.
 *
 * The relay is a broadcaster, not a mailbox: an announcement is delivered to
 * phones that are connected while it is live, and a phone that was offline
 * misses it. The client keeps the ids it has shown so a reconnect does not show
 * the same banner twice; nothing here tracks per-device delivery, because that
 * would be a second account database for a feature that has none.
 *
 * @module dsh-mizar-relay/announcements/store
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  backupFile,
  ensurePrivateDir,
  MutationQueue,
  readJsonFile,
  writeJsonAtomic,
} from '../accounts/state.js'

/**
 * Where a banner's button may send the app.
 *
 * A closed set rather than a free-form string: the phone opens a settings page
 * by name, and a typo must be refused at creation rather than discovered by
 * every user tapping a button that does nothing. The names are the settings
 * directory's topic ids (`iOS/DSH-Mizar/Views/Settings/SettingsTopic.swift`),
 * plus `account`, which is the row above the directory.
 */
export const ANNOUNCEMENT_TARGETS = [
  'account',
  'notifications',
  'sending',
  'transfer',
  'localAgent',
  'files',
  'community',
  'logs',
  'about',
] as const

/** One settings page a banner may open. */
export type AnnouncementTarget = (typeof ANNOUNCEMENT_TARGETS)[number]

/** The optional call to action. */
export interface AnnouncementButton {
  /** What the button says, 1-24 characters. */
  readonly label: string
  /** Which settings page it opens. */
  readonly target: AnnouncementTarget
}

/** One banner. */
export interface Announcement {
  readonly id: string
  readonly title: string
  readonly body: string
  /** SF Symbol name; the phone draws it if it resolves. */
  readonly symbol: string
  /** `info` is the app's accent, `notice` its waiting colour. */
  readonly tone: 'info' | 'notice'
  readonly button: AnnouncementButton | null
  readonly createdAt: number
  /** When it stops being shown; `null` until the operator turns it off. */
  readonly expiresAt: number | null
  active: boolean
}

/** The persisted file. */
interface AnnouncementFile {
  version: 1
  announcements: Announcement[]
}

/** What creating one needs. */
export interface AnnouncementDraft {
  readonly title: string
  readonly body: string
  readonly symbol?: string
  readonly tone?: 'info' | 'notice'
  readonly buttonLabel?: string | null
  readonly buttonTarget?: string | null
  /** Minutes from now until it stops; `null` means "until stopped". */
  readonly minutes?: number | null
}

/** Limits the API enforces, exported so the admin page and tests agree. */
export const ANNOUNCEMENT_LIMITS = {
  title: 120,
  body: 600,
  label: 24,
  symbol: 60,
  /** How many are kept; the oldest inactive ones go first. */
  kept: 200,
} as const

/** A human-readable refusal, which the admin page shows verbatim. */
export class AnnouncementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnnouncementError'
  }
}

/** The announcements store. */
export class AnnouncementStore {
  static async open(options: {
    readonly dataDir: string
    readonly now?: () => number
    readonly log?: (message: string) => void
  }): Promise<AnnouncementStore> {
    const store = new AnnouncementStore(options)
    await ensurePrivateDir(options.dataDir)
    await backupFile(store.#path)
    const file = await readJsonFile<AnnouncementFile | null>(store.#path, null).catch((error) => {
      options.log?.(`announcements: ${(error as Error).message}; starting empty`)
      return null
    })
    if (file?.version === 1 && Array.isArray(file.announcements)) {
      for (const announcement of file.announcements) store.#announcements.push(announcement)
    }
    return store
  }

  readonly #path: string
  readonly #now: () => number
  readonly #queue = new MutationQueue()
  readonly #announcements: Announcement[] = []
  /** Called after a new one is stored, so the live sockets can hear it. */
  onCreated: ((announcement: Announcement) => void) | null = null

  private constructor(options: { readonly dataDir: string; readonly now?: () => number }) {
    this.#path = join(options.dataDir, 'announcements.json')
    this.#now = options.now ?? Date.now
  }

  /** Every announcement, newest first. */
  list(): readonly Announcement[] {
    return [...this.#announcements].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** The ones a phone should show now, oldest first (the order to queue). */
  active(): readonly Announcement[] {
    const now = this.#now()
    return this.#announcements
      .filter((one) => one.active && (one.expiresAt === null || one.expiresAt > now))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** One by id, or `undefined`. */
  find(id: string): Announcement | undefined {
    return this.#announcements.find((one) => one.id === id)
  }

  /**
   * Store a new announcement and hand it to the broadcaster.
   *
   * @param draft - what the operator typed.
   * @returns the stored announcement.
   * @throws {AnnouncementError} when a field is out of range or the target is
   *   not one of the settings pages.
   */
  async create(draft: AnnouncementDraft): Promise<Announcement> {
    const announcement = this.#build(draft)
    return this.#queue.run(async () => {
      this.#announcements.push(announcement)
      this.#trim()
      await this.#save()
      this.onCreated?.(announcement)
      return announcement
    })
  }

  /** Stop showing one. Kept, so the record of what was sent survives. */
  async stop(id: string): Promise<boolean> {
    return this.#queue.run(async () => {
      const announcement = this.#announcements.find((one) => one.id === id)
      if (announcement === undefined) return false
      announcement.active = false
      await this.#save()
      return true
    })
  }

  /** Remove one entirely. */
  async remove(id: string): Promise<boolean> {
    return this.#queue.run(async () => {
      const index = this.#announcements.findIndex((one) => one.id === id)
      if (index < 0) return false
      this.#announcements.splice(index, 1)
      await this.#save()
      return true
    })
  }

  /** Validate a draft into an announcement. */
  #build(draft: AnnouncementDraft): Announcement {
    const title = String(draft.title ?? '').trim()
    const body = String(draft.body ?? '').trim()
    if (title === '') throw new AnnouncementError('the title is required')
    if (body === '') throw new AnnouncementError('the message is required')
    if (title.length > ANNOUNCEMENT_LIMITS.title) {
      throw new AnnouncementError(`the title is longer than ${ANNOUNCEMENT_LIMITS.title} characters`)
    }
    if (body.length > ANNOUNCEMENT_LIMITS.body) {
      throw new AnnouncementError(`the message is longer than ${ANNOUNCEMENT_LIMITS.body} characters`)
    }
    const symbol = String(draft.symbol ?? '').trim() || 'megaphone'
    if (symbol.length > ANNOUNCEMENT_LIMITS.symbol) {
      throw new AnnouncementError('that symbol name is too long')
    }
    const tone = draft.tone === 'notice' ? 'notice' : 'info'
    const label = String(draft.buttonLabel ?? '').trim()
    const target = String(draft.buttonTarget ?? '').trim()
    let button: AnnouncementButton | null = null
    if (label !== '' || target !== '') {
      if (label === '') throw new AnnouncementError('the button needs a label')
      if (target === '') throw new AnnouncementError('the button needs a destination')
      if (label.length > ANNOUNCEMENT_LIMITS.label) {
        throw new AnnouncementError(`the button label is longer than ${ANNOUNCEMENT_LIMITS.label} characters`)
      }
      if (!(ANNOUNCEMENT_TARGETS as readonly string[]).includes(target)) {
        throw new AnnouncementError(
          `buttonTarget must be one of ${ANNOUNCEMENT_TARGETS.join(', ')}`,
        )
      }
      button = { label, target: target as AnnouncementTarget }
    }
    const minutes = draft.minutes ?? null
    if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) {
      throw new AnnouncementError('minutes must be a positive number')
    }
    const now = this.#now()
    return {
      id: randomUUID(),
      title,
      body,
      symbol,
      tone,
      button,
      createdAt: now,
      expiresAt: minutes === null ? null : now + Math.round(minutes * 60_000),
      active: true,
    }
  }

  /** Keep the file bounded: the oldest inactive go first. */
  #trim(): void {
    if (this.#announcements.length <= ANNOUNCEMENT_LIMITS.kept) return
    const inactive = this.#announcements
      .filter((one) => !one.active || (one.expiresAt !== null && one.expiresAt <= this.#now()))
      .sort((a, b) => a.createdAt - b.createdAt)
    let excess = this.#announcements.length - ANNOUNCEMENT_LIMITS.kept
    for (const one of inactive) {
      if (excess <= 0) break
      const index = this.#announcements.indexOf(one)
      if (index >= 0) {
        this.#announcements.splice(index, 1)
        excess -= 1
      }
    }
  }

  /** Write the file atomically. */
  async #save(): Promise<void> {
    await writeJsonAtomic(this.#path, {
      version: 1,
      announcements: this.#announcements,
    } satisfies AnnouncementFile)
  }
}
