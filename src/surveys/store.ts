/**
 * Questionnaires, and the answers to them.
 *
 * The origin relay (主力0) owns both halves: `definitions.json` is what the
 * operator dispatched, `responses.jsonl` is what came back. The account relay
 * (主力1) never stores an answer -- it forwards one here and records only
 * "this account has been paid for this survey", which is the one fact the
 * reward needs.
 *
 * Two files rather than one because they are written by different people at
 * different times: a definition is edited by hand or by the operator's command
 * line, an answer arrives every time somebody finishes a form. Appending one
 * JSON line per answer keeps that write small and keeps the file readable with
 * `cat`, which is the whole point of a store this size.
 *
 * @module dsh-mizar-relay/surveys/store
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  backupFile,
  ensurePrivateDir,
  MutationQueue,
  readJsonFile,
  writeJsonAtomic,
} from '../accounts/state.js'

/** The three question shapes the phone knows how to draw. */
export type SurveyQuestionType = 'single' | 'multi' | 'text'

/** One choice in a single- or multi-select question. */
export interface SurveyOption {
  readonly id: string
  readonly label: string
}

/** One question. */
export interface SurveyQuestion {
  readonly id: string
  readonly type: SurveyQuestionType
  readonly prompt: string
  /** Choices for `single`/`multi`; empty for `text`. */
  readonly options: readonly SurveyOption[]
  /** Whether an answer is required to submit. */
  readonly required: boolean
  /** Longest accepted text answer; ignored for the choice types. */
  readonly maxLength?: number
}

/** One questionnaire. */
export interface Survey {
  readonly id: string
  readonly title: string
  readonly summary: string
  /** Paid days granted once. The operator's rate is 7. */
  readonly rewardDays: number
  readonly questions: readonly SurveyQuestion[]
  readonly active: boolean
  readonly createdAt: number
  readonly expiresAt: number | null
}

/** One answer inside a submission. */
export interface SurveyAnswer {
  readonly questionId: string
  /** A single option id, a list of them, or the text. */
  readonly value: string | readonly string[]
}

/** One submitted questionnaire. */
export interface SurveyResponse {
  readonly surveyId: string
  /** The account that submitted it. The origin relay has no accounts of its own. */
  readonly userId: string
  /** SHA-256 of the session token, for the account relay's audit trail. */
  readonly accountHash: string
  readonly submittedAt: number
  readonly answers: readonly SurveyAnswer[]
}

/** The persisted definitions file. */
interface DefinitionFile {
  version: 1
  surveys: Survey[]
}

/** A draft the operator creates. */
export interface SurveyDraft {
  readonly id?: string
  readonly title: string
  readonly summary?: string
  readonly rewardDays?: number
  readonly questions: readonly SurveyQuestion[]
  readonly minutes?: number | null
}

/** Refusals the API can return to the phone. */
export type SurveyRejection =
  | 'SURVEY_NOT_FOUND'
  | 'SURVEY_CLOSED'
  | 'SURVEY_ALREADY_DONE'
  | 'SURVEY_INVALID_ANSWERS'

/** A refusal, with the sentence the admin page or the client shows. */
export class SurveyError extends Error {
  constructor(
    readonly code: SurveyRejection,
    message: string,
  ) {
    super(message)
    this.name = 'SurveyError'
  }
}

/** Limits the store enforces, exported so tests and the CLI agree. */
export const SURVEY_LIMITS = {
  title: 120,
  summary: 300,
  prompt: 300,
  optionLabel: 80,
  text: 2000,
  questions: 40,
  options: 20,
  rewardDays: 365,
} as const

/** The survey store. */
export class SurveyStore {
  /** Open (or create) the store in `dataDir`. */
  static async open(options: {
    readonly dataDir: string
    readonly now?: () => number
    readonly log?: (message: string) => void
  }): Promise<SurveyStore> {
    const store = new SurveyStore(options)
    await ensurePrivateDir(options.dataDir)
    await backupFile(store.#definitionsPath)
    const file = await readJsonFile<DefinitionFile | null>(store.#definitionsPath, null).catch((error) => {
      options.log?.(`surveys: ${(error as Error).message}; starting empty`)
      return null
    })
    if (file?.version === 1 && Array.isArray(file.surveys)) {
      store.#surveys.push(...file.surveys)
    }
    // The answered set is rebuilt from the file at startup: it is the only way
    // a second relay process (or a restart) knows what is already done. The
    // account relay's completion record is authoritative for the reward; this
    // is the origin store's own guard against a double append.
    try {
      const text = await readFile(store.#responsesPath, 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const response = JSON.parse(line) as SurveyResponse
          store.#responses.push(response)
          store.#answered.add(`${response.surveyId}:${response.userId}`)
        } catch {
          // One truncated line (a crash mid-append) does not discard the rest.
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') options.log?.(`surveys: ${(error as Error).message}`)
    }
    return store
  }

  readonly #definitionsPath: string
  readonly #responsesPath: string
  readonly #dataDir: string
  readonly #now: () => number
  readonly #queue = new MutationQueue()
  readonly #surveys: Survey[] = []
  readonly #responses: SurveyResponse[] = []
  readonly #answered = new Set<string>()

  private constructor(options: { readonly dataDir: string; readonly now?: () => number }) {
    this.#dataDir = options.dataDir
    this.#definitionsPath = join(options.dataDir, 'definitions.json')
    this.#responsesPath = join(options.dataDir, 'responses.jsonl')
    this.#now = options.now ?? Date.now
  }

  /** Every survey, newest first. */
  list(): readonly Survey[] {
    return [...this.#surveys].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** The ones open for filling now, oldest first. */
  active(): readonly Survey[] {
    const now = this.#now()
    return this.#surveys
      .filter((one) => one.active && (one.expiresAt === null || one.expiresAt > now))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** One by id, or `undefined`. */
  find(id: string): Survey | undefined {
    return this.#surveys.find((one) => one.id === id)
  }

  /** How many answers one survey has received. */
  countFor(surveyId: string): number {
    return this.#responses.filter((one) => one.surveyId === surveyId).length
  }

  /** Every answer, oldest first. The operator's export. */
  responses(surveyId?: string): readonly SurveyResponse[] {
    return surveyId === undefined
      ? [...this.#responses]
      : this.#responses.filter((one) => one.surveyId === surveyId)
  }

  /** Whether this account already answered this survey. */
  hasAnswered(surveyId: string, userId: string): boolean {
    return this.#answered.has(`${surveyId}:${userId}`)
  }

  /**
   * Store one answer.
   *
   * @param input - the survey, the account, and the answers.
   * @returns the stored response.
   * @throws {SurveyError} when the survey is gone or closed, the account
   *   already answered, or an answer does not fit its question.
   */
  async submit(input: {
    readonly surveyId: string
    readonly userId: string
    readonly accountHash: string
    readonly answers: readonly SurveyAnswer[]
  }): Promise<SurveyResponse> {
    const survey = this.find(input.surveyId)
    if (survey === undefined) throw new SurveyError('SURVEY_NOT_FOUND', 'that survey does not exist')
    const now = this.#now()
    if (!survey.active || (survey.expiresAt !== null && survey.expiresAt <= now)) {
      throw new SurveyError('SURVEY_CLOSED', 'that survey is closed')
    }
    if (this.hasAnswered(survey.id, input.userId)) {
      throw new SurveyError('SURVEY_ALREADY_DONE', 'this account has already answered that survey')
    }
    const answers = normalizeAnswers(survey, input.answers)
    const response: SurveyResponse = {
      surveyId: survey.id,
      userId: input.userId,
      accountHash: input.accountHash,
      submittedAt: now,
      answers,
    }
    return this.#queue.run(async () => {
      await mkdir(this.#dataDir, { recursive: true, mode: 0o700 })
      await appendFile(this.#responsesPath, `${JSON.stringify(response)}\n`, { mode: 0o600 })
      this.#responses.push(response)
      this.#answered.add(`${survey.id}:${input.userId}`)
      return response
    })
  }

  /** Create or replace one survey definition. */
  async create(draft: SurveyDraft): Promise<Survey> {
    const survey = buildSurvey(draft, this.#now())
    return this.#queue.run(async () => {
      const index = this.#surveys.findIndex((one) => one.id === survey.id)
      if (index >= 0) this.#surveys[index] = survey
      else this.#surveys.push(survey)
      await writeJsonAtomic(this.#definitionsPath, {
        version: 1,
        surveys: this.#surveys,
      } satisfies DefinitionFile)
      return survey
    })
  }

  /** Stop accepting answers. Definitions are kept, because answers point at them. */
  async close(id: string): Promise<boolean> {
    return this.#queue.run(async () => {
      const survey = this.#surveys.find((one) => one.id === id)
      if (survey === undefined) return false
      const closed: Survey = { ...survey, active: false }
      const index = this.#surveys.indexOf(survey)
      this.#surveys[index] = closed
      await writeJsonAtomic(this.#definitionsPath, {
        version: 1,
        surveys: this.#surveys,
      } satisfies DefinitionFile)
      return true
    })
  }
}

/**
 * Check a submission against its questions.
 *
 * Answers for questions the survey does not have are refused rather than
 * ignored: a client that sends them is a client that disagrees with the server
 * about the form, and quietly dropping the extra field would hide that.
 *
 * @param survey - the definition.
 * @param answers - what the phone sent.
 * @returns the answers in the survey's question order, trimmed.
 * @throws {SurveyError} when an answer is missing, unknown or malformed.
 */
export function normalizeAnswers(
  survey: Survey,
  answers: readonly SurveyAnswer[],
): SurveyAnswer[] {
  const byId = new Map<string, SurveyAnswer>()
  for (const answer of answers) {
    if (!survey.questions.some((question) => question.id === answer.questionId)) {
      throw new SurveyError('SURVEY_INVALID_ANSWERS', `unknown question: ${answer.questionId}`)
    }
    byId.set(answer.questionId, answer)
  }
  const normalized: SurveyAnswer[] = []
  for (const question of survey.questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) {
      if (question.required) {
        throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${question.id} is required`)
      }
      continue
    }
    if (question.type === 'single') {
      const value = typeof answer.value === 'string' ? answer.value : ''
      if (!question.options.some((option) => option.id === value)) {
        throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${question.id} has an unknown choice`)
      }
      normalized.push({ questionId: question.id, value })
      continue
    }
    if (question.type === 'multi') {
      const value = Array.isArray(answer.value) ? answer.value : []
      if (value.length === 0 && question.required) {
        throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${question.id} needs a choice`)
      }
      const known = new Set(question.options.map((option) => option.id))
      for (const choice of value) {
        if (!known.has(choice)) {
          throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${question.id} has an unknown choice`)
        }
      }
      normalized.push({ questionId: question.id, value: [...new Set(value)] })
      continue
    }
    const text = (typeof answer.value === 'string' ? answer.value : '').trim()
    if (text === '' && question.required) {
      throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${question.id} is required`)
    }
    const max = Math.min(question.maxLength ?? SURVEY_LIMITS.text, SURVEY_LIMITS.text)
    if (text.length > max) {
      throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${question.id} is longer than ${max} characters`)
    }
    normalized.push({ questionId: question.id, value: text })
  }
  return normalized
}

/** Validate a draft and give it an id. */
function buildSurvey(draft: SurveyDraft, now: number): Survey {
  const title = String(draft.title ?? '').trim()
  if (title === '') throw new SurveyError('SURVEY_INVALID_ANSWERS', 'the title is required')
  if (title.length > SURVEY_LIMITS.title) {
    throw new SurveyError('SURVEY_INVALID_ANSWERS', `the title is longer than ${SURVEY_LIMITS.title}`)
  }
  const summary = String(draft.summary ?? '').trim()
  if (summary.length > SURVEY_LIMITS.summary) {
    throw new SurveyError('SURVEY_INVALID_ANSWERS', `the summary is longer than ${SURVEY_LIMITS.summary}`)
  }
  const rewardDays = draft.rewardDays ?? 7
  if (!Number.isInteger(rewardDays) || rewardDays < 1 || rewardDays > SURVEY_LIMITS.rewardDays) {
    throw new SurveyError('SURVEY_INVALID_ANSWERS', 'rewardDays must be between 1 and 365')
  }
  if (draft.questions.length === 0 || draft.questions.length > SURVEY_LIMITS.questions) {
    throw new SurveyError(
      'SURVEY_INVALID_ANSWERS',
      `a survey needs 1-${SURVEY_LIMITS.questions} questions`,
    )
  }
  const seen = new Set<string>()
  for (const question of draft.questions) {
    const id = String(question.id ?? '').trim()
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
      throw new SurveyError('SURVEY_INVALID_ANSWERS', `bad question id: ${id}`)
    }
    if (seen.has(id)) throw new SurveyError('SURVEY_INVALID_ANSWERS', `duplicate question id: ${id}`)
    seen.add(id)
    if (String(question.prompt ?? '').trim() === '' || question.prompt.length > SURVEY_LIMITS.prompt) {
      throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${id} needs a prompt (max ${SURVEY_LIMITS.prompt})`)
    }
    if (question.type !== 'single' && question.type !== 'multi' && question.type !== 'text') {
      throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${id} has an unknown type`)
    }
    if (question.type === 'text') continue
    if (question.options.length < 2 || question.options.length > SURVEY_LIMITS.options) {
      throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${id} needs 2-${SURVEY_LIMITS.options} options`)
    }
    const optionIds = new Set<string>()
    for (const option of question.options) {
      if (String(option.label ?? '').trim() === '' || option.label.length > SURVEY_LIMITS.optionLabel) {
        throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${id} has an empty or too-long option`)
      }
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(option.id)) {
        throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${id} has a bad option id: ${option.id}`)
      }
      if (optionIds.has(option.id)) {
        throw new SurveyError('SURVEY_INVALID_ANSWERS', `question ${id} has a duplicate option: ${option.id}`)
      }
      optionIds.add(option.id)
    }
  }
  const id = String(draft.id ?? '').trim() || randomUUID()
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
    throw new SurveyError('SURVEY_INVALID_ANSWERS', 'the survey id must be 4-64 letters, digits, _ or -')
  }
  const minutes = draft.minutes ?? null
  return {
    id,
    title,
    summary,
    rewardDays,
    questions: draft.questions.map((question) => ({
      ...question,
      options: question.options,
      prompt: question.prompt.trim(),
    })),
    active: true,
    createdAt: now,
    expiresAt: minutes === null ? null : now + Math.round(minutes * 60_000),
  }
}

/** A stable short hash for logs; not used as an identity. */
export function surveyDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}
