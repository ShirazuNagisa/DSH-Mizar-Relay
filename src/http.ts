/**
 * Small HTTP helpers shared by the tunnel and the account/admin surfaces.
 *
 * The relay had these inline in `index.ts` when it only served tunnels. The
 * account service added several more JSON endpoints and a server-rendered admin
 * UI, and two copies of a body reader is exactly the kind of drift that ends
 * with one path enforcing a different limit than the other. One copy, one
 * limit, one escaping rule.
 *
 * @module dsh-mizar-relay/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Read a request body, refusing anything past the cap. */
export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limit) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Read a UTF-8 request body, refusing anything past the cap. */
export async function readText(request: IncomingMessage, limit: number): Promise<string | null> {
  const body = await readBody(request, limit)
  return body === null ? null : body.toString('utf8')
}

/** Write a JSON response. */
export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Write an HTML response with the headers the admin UI needs. */
export function writeHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  })
  response.end(html)
}

/** Redirect, used by the admin forms after a POST. */
export function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, 'cache-control': 'no-store' })
  response.end()
}

/**
 * Escape text for HTML.
 *
 * Every admin page is server-rendered from operator data (user names, emails,
 * guest ids), so every interpolation goes through this. The one exception is
 * a value that is already HTML produced by a template function.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Parse a JSON body as an object, or `null`. */
export function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Read one string field, or `undefined`. */
export function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** Read one number field, or `undefined`. */
export function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read one boolean field, or `undefined`. */
export function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}
