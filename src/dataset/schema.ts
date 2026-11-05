/**
 * The turn record the desktop uploads.
 *
 * Deliberately the same shape the training pipeline calls an *input*: one line
 * per finished turn, with the user's instruction, the tool names, the failed
 * calls and the last few replies. The relay does not interpret the content; it
 * validates the shape so a broken or hostile client cannot fill the archive
 * with rows no trainer can parse.
 *
 * @module dsh-mizar-relay/dataset/schema
 */

/** One anonymous turn, as it crosses the wire. */
export interface TurnRecord {
  readonly v: 1
  /** `<session>:<turn>` with the session a 32-hex pseudonym. */
  readonly id: string
  readonly session: string
  readonly turn: number
  readonly engine: 'dsh' | 'claude' | 'codex'
  readonly minutes: number
  readonly reason: 'completed' | 'error' | 'aborted'
  readonly steps: number
  readonly replyCount: number
  readonly endsWithQuestion: boolean
  readonly user: string
  readonly tools: string
  readonly failures: readonly string[]
  readonly subagents: readonly string[]
  readonly jobs: readonly string[]
  readonly texts: readonly string[]
  /** `YYYY-MM-DD`; the only time fact kept. */
  readonly day: string
}

const SESSION = /^[0-9a-f]{32}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ENGINES = new Set(['dsh', 'claude', 'codex'])
const REASONS = new Set(['completed', 'error', 'aborted'])

/** Largest values the relay accepts. Over a cap the whole line is dropped. */
export const LIMITS = {
  user: 20_000,
  tools: 4_000,
  failures: 40,
  failure: 4_000,
  list: 40,
  item: 2_000,
  texts: 12,
  text: 12_000,
} as const

const isString = (value: unknown): value is string => typeof value === 'string'
const isInt = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
const isNumber = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max

function isList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isString(item) && item.length <= maxLength)
  )
}

/**
 * Whether one parsed JSON line is a turn this relay will store.
 *
 * Extra keys are accepted: a newer desktop may send a field this relay does not
 * know yet, and dropping the whole turn over it would lose training data that
 * the trainer can still read.
 */
export function validateTurn(value: unknown): value is TurnRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const turn = value as Record<string, unknown>
  if (turn['v'] !== 1) return false
  if (!isString(turn['session']) || !SESSION.test(turn['session'])) return false
  if (!isInt(turn['turn'], 1_000_000)) return false
  if (!isString(turn['id']) || turn['id'] !== `${turn['session']}:${turn['turn']}`) return false
  if (!isString(turn['engine']) || !ENGINES.has(turn['engine'])) return false
  if (!isNumber(turn['minutes'], 1_000_000)) return false
  if (!isString(turn['reason']) || !REASONS.has(turn['reason'])) return false
  if (!isInt(turn['steps'], 1_000_000)) return false
  if (!isInt(turn['replyCount'], 10_000)) return false
  if (typeof turn['endsWithQuestion'] !== 'boolean') return false
  if (!isString(turn['user']) || turn['user'].length > LIMITS.user) return false
  if (!isString(turn['tools']) || turn['tools'].length > LIMITS.tools) return false
  if (!isList(turn['failures'], LIMITS.failures, LIMITS.failure)) return false
  if (!isList(turn['subagents'], LIMITS.list, LIMITS.item)) return false
  if (!isList(turn['jobs'], LIMITS.list, LIMITS.item)) return false
  if (!isList(turn['texts'], LIMITS.texts, LIMITS.text)) return false
  if (!isString(turn['day']) || !DAY.test(turn['day'])) return false
  return true
}

/** Parse one NDJSON line, or `null` when it is not a valid turn. */
export function parseTurn(line: string): TurnRecord | null {
  try {
    const value: unknown = JSON.parse(line)
    return validateTurn(value) ? value : null
  } catch {
    return null
  }
}
