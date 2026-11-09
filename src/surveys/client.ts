/**
 * The account relay's side of the survey store.
 *
 * Answers and definitions live on the origin relay (主力0); the account relay
 * (主力1) is the only one that knows who is asking, so it is the one that
 * decides. This class is the wire between them, over the private listener --
 * there is no public URL in it, and the secret is the internal one.
 *
 * Definitions are cached for a minute because the phone asks for the list every
 * time the settings page opens: a round trip to the other machine per open is
 * cheap, but a round trip per row is not. Answers are never cached: the one
 * thing that must be current is whether the store accepted this submission.
 *
 * @module dsh-mizar-relay/surveys/client
 */
import type { Survey, SurveyAnswer, SurveyRejection } from './store.js'

/** How long a list of definitions is reused. */
const CACHE_TTL_MS = 60_000

export interface SurveyClientOptions {
  /** The origin relay's internal base, e.g. `http://10.0.0.12:8790`. */
  readonly upstreamURL: string
  /** The shared internal secret. */
  readonly secret: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly log?: (message: string) => void
}

/** Answer from the origin store. */
export type SubmitResult =
  | { readonly ok: true; readonly submittedAt: number }
  | { readonly ok: false; readonly code: SurveyRejection; readonly message: string }

/** The survey service, as the account relay sees it. */
export class SurveyClient {
  readonly #base: string
  readonly #secret: string
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #log: (message: string) => void
  #cache: { surveys: readonly Survey[]; at: number } | null = null

  constructor(options: SurveyClientOptions) {
    this.#base = options.upstreamURL.replace(/\/+$/, '')
    this.#secret = options.secret
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => undefined)
  }

  /** Whether this client is pointed anywhere. */
  get configured(): boolean {
    return this.#base !== '' && this.#secret !== ''
  }

  /**
   * The open surveys, newest definitions last.
   *
   * @param fresh - skip the cache (the submit path wants the current state).
   * @returns the definitions, or `null` when the origin did not answer.
   */
  async list(fresh = false): Promise<readonly Survey[] | null> {
    if (!this.configured) return null
    const now = this.#now()
    if (!fresh && this.#cache !== null && now - this.#cache.at < CACHE_TTL_MS) {
      return this.#cache.surveys
    }
    try {
      const response = await this.#fetch(`${this.#base}/internal/v1/surveys`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#secret}` },
      })
      if (!response.ok) {
        this.#log(`surveys: the origin answered ${response.status} for the list`)
        return null
      }
      const body = (await response.json()) as { surveys?: Survey[] }
      const surveys = Array.isArray(body.surveys) ? body.surveys : []
      this.#cache = { surveys, at: now }
      return surveys
    } catch (error) {
      this.#log(`surveys: the origin did not answer (${(error as Error).message})`)
      return null
    }
  }

  /**
   * How many answers each survey has, for the admin page.
   *
   * @returns counts and the raw answers (the page shows the counts; the
   *   answers are there for an operator reading the JSON), or `null` when the
   *   origin did not answer.
   */
  async summary(): Promise<{
    readonly counts: ReadonlyArray<{ readonly id: string; readonly title: string; readonly answers: number }>
  } | null> {
    if (!this.configured) return null
    try {
      const response = await this.#fetch(`${this.#base}/internal/v1/surveys/responses`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#secret}` },
      })
      if (!response.ok) return null
      const body = (await response.json()) as {
        counts?: Array<{ id: string; title: string; answers: number }>
      }
      return { counts: Array.isArray(body.counts) ? body.counts : [] }
    } catch (error) {
      this.#log(`surveys: the origin did not answer the counts (${(error as Error).message})`)
      return null
    }
  }

  /** One definition by id, read fresh. */
  async find(surveyId: string): Promise<Survey | null> {
    const surveys = await this.list(true)
    if (surveys === null) return null
    return surveys.find((survey) => survey.id === surveyId) ?? null
  }

  /**
   * Store one answer on the origin relay.
   *
   * @param input - the survey, the account and the answers.
   * @returns the origin's verdict; a refused submission is not an error here,
   *   it is a sentence the phone should read.
   */
  async submit(input: {
    readonly surveyId: string
    readonly userId: string
    readonly accountHash: string
    readonly answers: readonly SurveyAnswer[]
  }): Promise<SubmitResult> {
    if (!this.configured) {
      return { ok: false, code: 'SURVEY_NOT_FOUND', message: 'surveys are not configured here' }
    }
    try {
      const response = await this.#fetch(`${this.#base}/internal/v1/surveys/answers`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      })
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        submittedAt?: number
        error?: SurveyRejection
        message?: string
      }
      if (response.ok && body.ok === true) {
        this.#cache = null
        return { ok: true, submittedAt: typeof body.submittedAt === 'number' ? body.submittedAt : this.#now() }
      }
      const code = body.error ?? 'SURVEY_INVALID_ANSWERS'
      return {
        ok: false,
        code,
        message: body.message ?? 'the survey store refused that answer',
      }
    } catch (error) {
      this.#log(`surveys: the origin did not answer (${(error as Error).message})`)
      return {
        ok: false,
        code: 'SURVEY_NOT_FOUND',
        message: 'the survey server could not be reached',
      }
    }
  }
}
