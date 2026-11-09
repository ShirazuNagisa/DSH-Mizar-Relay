/**
 * The survey operator's command line.
 *
 * Runs on the origin relay (主力0) and talks to the *running* process over its
 * private listener rather than editing the store's files behind its back: a
 * definition written to disk by a second process would not exist in the
 * memory of the relay serving the phones, and the next save would erase it.
 *
 * Usage:
 *   node lib/survey-cli.js --config /www/wwwroot/dsh-mizar-relay/relay.config.json list
 *   node lib/survey-cli.js create survey.json
 *   node lib/survey-cli.js close <id>
 *   node lib/survey-cli.js responses [surveyId]
 *   node lib/survey-cli.js export answers.jsonl
 *
 * The JSON a survey is created from:
 *   {
 *     "id": "launch-feedback",            // optional; letters, digits, _ and -
 *     "title": "…", "summary": "…",
 *     "rewardDays": 7,                    // default 7
 *     "minutes": 10080,                   // optional: closes after a week
 *     "questions": [
 *       { "id": "useful", "type": "single", "prompt": "…", "required": true,
 *         "options": [{"id":"yes","label":"是"},{"id":"no","label":"否"}] },
 *       { "id": "more", "type": "text", "prompt": "…", "required": false, "maxLength": 500 }
 *     ]
 *   }
 *
 * @module dsh-mizar-relay/survey-cli
 */
import { readFile, writeFile } from 'node:fs/promises'
import { loadConfig } from './config.js'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let configPath = 'relay.config.json'
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--config' || argument === '-c') {
      configPath = argv[index + 1] ?? configPath
      index += 1
      continue
    }
    rest.push(argument ?? '')
  }
  const [command, ...args] = rest
  const config = loadConfig(configPath)
  const internal = config.internal ?? null
  const secret =
    internal?.secret !== undefined && internal.secret !== ''
      ? internal.secret
      : (config.accounts?.internalSecret ?? '')
  if (internal === null || secret === '') {
    throw new Error('this relay has no internal listener; surveys are reached through one')
  }
  const base = `http://${internal.host}:${internal.port}`
  const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    })
    const body = await response.json().catch(() => null)
    return { status: response.status, body }
  }

  switch (command) {
    case 'list': {
      const { status, body } = await call('/internal/v1/surveys')
      if (status !== 200) throw new Error(`the relay answered ${status}: ${JSON.stringify(body)}`)
      const surveys = (body as { surveys?: unknown[] }).surveys ?? []
      for (const survey of surveys as Array<{
        id: string
        title: string
        rewardDays: number
        questions: unknown[]
        expiresAt: number | null
      }>) {
        const until = survey.expiresAt === null ? 'until closed' : new Date(survey.expiresAt).toISOString()
        process.stdout.write(
          `${survey.id}  ${survey.title}  ${survey.rewardDays}d  ${survey.questions.length} questions  ${until}\n`,
        )
      }
      if (surveys.length === 0) process.stdout.write('(no surveys)\n')
      return
    }
    case 'create': {
      const path = args[0]
      if (path === undefined) throw new Error('usage: survey-cli create <file.json>')
      const draft = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      const { status, body } = await call('/internal/v1/surveys/definitions', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      if (status !== 200) throw new Error(`the relay answered ${status}: ${JSON.stringify(body)}`)
      process.stdout.write(`${JSON.stringify(body)}\n`)
      return
    }
    case 'close': {
      const id = args[0]
      if (id === undefined) throw new Error('usage: survey-cli close <id>')
      const { status, body } = await call('/internal/v1/surveys/close', {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
      if (status !== 200) throw new Error(`the relay answered ${status}: ${JSON.stringify(body)}`)
      process.stdout.write(`${JSON.stringify(body)}\n`)
      return
    }
    case 'responses': {
      const surveyId = args[0]
      const query = surveyId === undefined ? '' : `?surveyId=${encodeURIComponent(surveyId)}`
      const { status, body } = await call(`/internal/v1/surveys/responses${query}`)
      if (status !== 200) throw new Error(`the relay answered ${status}: ${JSON.stringify(body)}`)
      const responses = (body as { responses?: unknown[] }).responses ?? []
      for (const response of responses) process.stdout.write(`${JSON.stringify(response)}\n`)
      return
    }
    case 'export': {
      const path = args[0]
      if (path === undefined) throw new Error('usage: survey-cli export <file.jsonl>')
      const { status, body } = await call('/internal/v1/surveys/responses')
      if (status !== 200) throw new Error(`the relay answered ${status}: ${JSON.stringify(body)}`)
      const responses = (body as { responses?: unknown[] }).responses ?? []
      await writeFile(path, responses.map((one) => `${JSON.stringify(one)}\n`).join(''), 'utf8')
      process.stdout.write(`wrote ${responses.length} responses to ${path}\n`)
      return
    }
    default:
      throw new Error('usage: survey-cli [--config path] <list|create|close|responses|export> ...')
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
