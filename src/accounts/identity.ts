/**
 * Who is making a relayed request, for accounting.
 *
 * The phone sends two headers: its installation id and the SHA-256 of its
 * account token. The hash -- not the token -- is the point: the relay needs a
 * stable pseudonym for traffic statistics, and a relay that can authenticate as
 * the user would be a second trust boundary the design does not want. The host
 * plugin never sees either header; they are stripped before replay.
 *
 * The paid relay is the one place that does need the token itself, so a third
 * header carries it: {@link SESSION_HEADER}. It is read by the paid gate, used
 * for nothing else, stripped before replay, and never written to a log or a
 * traffic file -- which is why the ledger still buckets by the hash.
 *
 * @module dsh-mizar-relay/accounts/identity
 */
import { createHash } from 'node:crypto'

/** The installation id header. */
export const CLIENT_ID_HEADER = 'x-mizar-client-id'

/** The account-token-hash header. */
export const ACCOUNT_HEADER = 'x-mizar-account'

/**
 * The account session token, presented to the paid relay.
 *
 * Only ever sent to a relay that owns the account store -- the free relay never
 * needs it, and giving a token to a host that does not verify it is handing out
 * a credential for nothing. Unlike {@link ACCOUNT_HEADER} this one is a real
 * secret, so it is stripped before the request reaches the computer and it is
 * never logged.
 */
export const SESSION_HEADER = 'x-mizar-session'

/** The headers the relay consumes and never forwards. */
export const PRIVATE_HEADERS: readonly string[] = [CLIENT_ID_HEADER, ACCOUNT_HEADER, SESSION_HEADER]

/** The identity of one request. */
export type RelayIdentity =
  | { readonly kind: 'account'; readonly hash: string; readonly key: string }
  | { readonly kind: 'guest'; readonly clientId: string; readonly key: string }
  | { readonly kind: 'anon'; readonly hash: string; readonly key: string }

/**
 * Read the account hash and client id from headers.
 *
 * @param headers - request or upgrade headers, lower-cased by Node.
 * @returns the two optional identifiers.
 */
export function readRelayIdentity(headers: Record<string, string | string[] | undefined>): {
  accountHash: string | null
  clientId: string | null
} {
  const account = first(headers[ACCOUNT_HEADER])
  const client = first(headers[CLIENT_ID_HEADER])
  return {
    accountHash: account !== null && /^[0-9a-f]{64}$/.test(account.toLowerCase()) ? account.toLowerCase() : null,
    clientId: client !== null && /^[A-Za-z0-9._-]{8,64}$/.test(client) ? client : null,
  }
}

/**
 * Build the identity key for one request.
 *
 * The fallback is a hash of the room, peer, and user agent: an old client that
 * sends neither header still gets one stable "default account" per room/peer
 * rather than a new row per request, and the value contains no raw address.
 *
 * @param headers - request headers.
 * @param context - room, peer, and user agent for the fallback.
 * @returns the identity.
 */
export function identityFor(
  headers: Record<string, string | string[] | undefined>,
  context: { readonly room: string; readonly peer: string; readonly userAgent: string },
): RelayIdentity {
  const { accountHash, clientId } = readRelayIdentity(headers)
  if (accountHash !== null) {
    return { kind: 'account', hash: accountHash, key: `account:${accountHash}` }
  }
  if (clientId !== null) {
    return { kind: 'guest', clientId, key: `guest:${clientId}` }
  }
  const hash = createHash('sha256')
    .update(`${context.room}\n${context.peer}\n${context.userAgent}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
  return { kind: 'anon', hash, key: `anon:${hash}` }
}

/**
 * Remove the relay-private headers from a header record before forwarding it.
 *
 * @param headers - a source header record.
 * @returns a copy without the two private headers.
 */
export function withoutPrivateHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (PRIVATE_HEADERS.includes(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/** Whether a header name is one the relay consumes. */
export function isPrivateHeader(name: string): boolean {
  return PRIVATE_HEADERS.includes(name.toLowerCase())
}

/** First string value of a possibly repeated header. */
function first(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return null
}
