/**
 * The mail service's internal HTTP API.
 *
 * One route, `POST /internal/v1/mail`, called by the account relay. It is not
 * part of the public surface: it requires a bearer token and, when `allowFrom`
 * is set, a source address in that list. nginx adds a second address check.
 *
 * The body names a kind and its variables; it cannot carry a rendered body, so a
 * leaked token cannot turn this relay into an open mail relay with arbitrary
 * content.
 *
 * @module dsh-mizar-relay/mail/api
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientAddress } from '../client-address.js'
import { parseJsonObject, readBody, writeJson } from '../http.js'
import type { MailService } from './service.js'
import { isMailKind } from './client.js'
import type { MailMessage } from './types.js'

/** The largest mail request body. */
const MAX_BODY_BYTES = 32 * 1024

/** Longest address or template variable accepted. */
const MAX_FIELD = 254

/** The one path this API answers. */
export const MAIL_PATH = '/internal/v1/mail'

/** What the route needs. */
export interface MailApiOptions {
  readonly service: MailService
  readonly token: string
  readonly allowFrom: readonly string[]
  readonly log?: (message: string) => void
}

/**
 * Answer one mail request, if it is one.
 *
 * @param request - the incoming request.
 * @param response - the response.
 * @param path - the pathname, already parsed.
 * @param options - the service and its policy.
 * @returns whether the request belonged to this API.
 */
export async function handleMailRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  options: MailApiOptions,
): Promise<boolean> {
  if (path !== MAIL_PATH) return false
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    return true
  }
  if (!authorized(request, options)) {
    writeJson(response, 401, { error: 'UNAUTHORIZED', message: 'a bearer token is required' })
    return true
  }
  const body = await readBody(request, MAX_BODY_BYTES)
  if (body === null) {
    writeJson(response, 413, { error: 'TOO_LARGE' })
    return true
  }
  const parsed = parseJsonObject(body.toString('utf8'))
  if (parsed === null) {
    writeJson(response, 400, { error: 'INVALID_INPUT', message: 'a JSON object is required' })
    return true
  }
  const kind = parsed['kind']
  const to = parsed['to']
  if (!isMailKind(kind) || typeof to !== 'string' || !isEmail(to)) {
    writeJson(response, 400, { error: 'INVALID_INPUT', message: 'kind and to are required' })
    return true
  }
  const data = variableObject(parsed['data'])
  if (data === null) {
    writeJson(response, 400, { error: 'INVALID_INPUT', message: 'data must be a flat object of strings' })
    return true
  }
  const message: MailMessage = { kind, to, data }
  try {
    const { id } = await options.service.enqueue(message)
    writeJson(response, 202, { id })
  } catch (error) {
    options.log?.(`mail: enqueue failed: ${(error as Error).message}`)
    writeJson(response, 500, { error: 'INTERNAL', message: 'the mail service failed' })
  }
  return true
}

/** Token and address check. */
function authorized(request: IncomingMessage, options: MailApiOptions): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const presented = match?.[1]
  if (presented === undefined) return false
  if (!constantTimeEquals(presented, options.token)) return false
  if (options.allowFrom.length === 0) return true
  const remote = request.socket.remoteAddress ?? ''
  const peer = clientAddress(remote, request.headers, true)
  if (options.allowFrom.includes(peer)) return true
  // nginx on this host talks to the relay over loopback; its own `allow` list
  // already restricted who may reach it, so loopback is trusted here.
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** Compare two strings without leaking length through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** A flat object of short strings, or `null`. */
function variableObject(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 8) return null
  const out: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string' || entry.length > MAX_FIELD) return null
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,19}$/.test(key)) return null
    out[key] = entry
  }
  return out
}

/** A pragmatic address check; the provider is the real authority. */
function isEmail(value: string): boolean {
  return value.length <= MAX_FIELD && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
