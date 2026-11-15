/**
 * The setup page a self-hosted relay serves at `/`.
 *
 * Served from the relay itself, not from the project's website: the page has to
 * work on a server whose operator is debugging exactly the thing that would make
 * an external page unreachable. It is one HTML file with no external assets, so
 * `curl -k https://<domain>/` shows the same thing a browser does.
 *
 * @module dsh-mizar-relay/setup
 */
import { readFileSync } from 'node:fs'
import type { SelfHostConfig } from './config.js'
import { RELAY_VERSION } from './version.js'

/** The page, read once and reused. */
let template: string | null = null

/**
 * The page's content-security policy.
 *
 * The one departure from the admin UI's policy is `script-src 'unsafe-inline'`:
 * this page is a single file with no routes and no templating at request time, so
 * a nonce would buy a header instead of a boundary. Everything it talks to is
 * this origin, which `connect-src 'self'` keeps.
 */
export const SETUP_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src https: data:; base-uri 'none'; form-action 'self'"

/** Read the template beside this module, in `src/` or in `lib/`. */
function templateText(): string {
  if (template === null) {
    template = readFileSync(new URL('./setup.html', import.meta.url), 'utf8')
  }
  return template
}

/**
 * Fill the template for one relay.
 *
 * Everything variable is injected either as escaped text or as a JSON blob that
 * the page reads; no operator value is interpolated into a script unescaped.
 *
 * @param config - the self-hosting block.
 * @returns the page.
 */
export function renderSetupPage(config: SelfHostConfig): string {
  const values = {
    version: RELAY_VERSION,
    publicURL: config.publicURL,
    pinRequired: config.pinHash !== '',
    updateEnabled: config.updateTokenHash !== '',
    autoUpdate: config.autoUpdate,
    repo: config.githubRepo,
  }
  const json = JSON.stringify(values).replace(/</g, '\\u003c')
  return templateText()
    .replaceAll('__SETUP_JSON__', json)
    .replaceAll('__VERSION_TEXT__', escapeHtml(RELAY_VERSION))
    .replaceAll('__PUBLIC_URL_TEXT__', escapeHtml(config.publicURL))
    .replaceAll('__PIN_NOTE__', config.pinHash === '' ? 'off' : 'on')
}

/** Escape text for HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
