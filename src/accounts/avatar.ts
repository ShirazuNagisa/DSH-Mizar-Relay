/**
 * Avatars: Gravatar when it exists, a deterministic gradient when it does not.
 *
 * Both halves are computed at registration and stored, so the answer does not
 * change between two logins and the account service does not depend on the
 * network at read time. The generated colours are stored even when Gravatar
 * answered, because the phone may be on a network where the image host is
 * blocked -- the fallback has to be local to the record, not a second lookup.
 *
 * Gravatar itself is unreachable from the account server in China. The lookup
 * therefore takes an ordered list of base URLs and treats 404, timeout, and
 * network failure the same way: try the next one, then generate.
 *
 * @module dsh-mizar-relay/accounts/avatar
 */
import { createHash } from 'node:crypto'
import type { AvatarSpec } from './types.js'

/** A Gravatar mirror that supports the `d=404` "tell me if there is no avatar"
 * contract. The official host is last on the account server because the probe
 * there would only ever time out. */
export const DEFAULT_GRAVATAR_BASE_URLS: readonly string[] = ['https://www.gravatar.com']

/** The hash Gravatar addresses an avatar by. */
export function gravatarHash(email: string): string {
  return createHash('md5').update(normalizeEmail(email), 'utf8').digest('hex')
}

/** Normalize an email once, in one place. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Pick the two initials shown on a generated avatar. */
export function initialsFor(name: string, fallback = '?'): string {
  const letters = Array.from(name.trim()).filter((character) => /\p{L}|\p{N}/u.test(character))
  const picked = letters.slice(0, 2).join('')
  return picked === '' ? fallback : picked.toUpperCase()
}

/**
 * Build the deterministic gradient avatar for an email (or Apple subject).
 *
 * The seed is hashed; the three colours are HSL triples with a fixed
 * saturation/lightness band, so every avatar is legible under white initials and
 * two different seeds are visibly different. No image library, no randomness.
 *
 * @param seed - email or Apple subject.
 * @param name - the display name used for initials.
 * @returns the generated avatar.
 */
export function generatedAvatar(seed: string, name: string): AvatarSpec {
  const digest = createHash('sha256').update(seed, 'utf8').digest()
  const hue = (digest[0] ?? 0) * 360 / 256
  const second = (hue + 38 + ((digest[1] ?? 0) % 48)) % 360
  const third = (hue + 196 + ((digest[2] ?? 0) % 42)) % 360
  return {
    kind: 'generated',
    colors: [
      hslToHex(hue, 68, 56),
      hslToHex(second, 64, 48),
      hslToHex(third, 58, 38),
    ],
    initials: initialsFor(name || seed.split('@')[0] || '?'),
  }
}

/**
 * Look up Gravatar and fall back to a generated avatar.
 *
 * Never throws: a registration must not fail because a third-party image host
 * is down. Each base URL gets 1.5 seconds; a 200 wins, a 404 means "this email
 * has no avatar", and everything else means "try the next one".
 *
 * @param email - the account email, or `null` for an Apple-only account.
 * @param name - display name for initials.
 * @param options - enabled flag, base URLs, fetch implementation.
 * @returns the stored avatar.
 */
export async function avatarFor(
  email: string | null,
  name: string,
  options: {
    readonly enabled: boolean
    readonly baseURLs: readonly string[]
    readonly fetchImpl?: typeof fetch
    readonly seed?: string
    readonly timeoutMs?: number
  },
): Promise<AvatarSpec> {
  const seed = options.seed ?? email ?? name
  const fallback = generatedAvatar(seed, name)
  if (!options.enabled || email === null || email.trim() === '') return fallback
  const hash = gravatarHash(email)
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 1_500
  for (const base of options.baseURLs) {
    const trimmed = base.replace(/\/+$/, '')
    const url = `${trimmed}/${hash}?d=404&s=256`
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 200) {
        // Do not download the image; this request only asks whether it exists.
        await response.body?.cancel().catch(() => undefined)
        return { ...fallback, kind: 'gravatar', url }
      }
      await response.body?.cancel().catch(() => undefined)
    } catch {
      // Timeout, DNS failure, blocked host: try the next base URL.
    }
  }
  return fallback
}

/** Convert an HSL triple to a `#rrggbb` colour. */
export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360
  const s = Math.min(100, Math.max(0, saturation)) / 100
  const l = Math.min(100, Math.max(0, lightness)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const channel = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}
