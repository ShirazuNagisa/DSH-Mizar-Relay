/**
 * The relay's own version, read from the package it ships in.
 *
 * There used to be a hand-written constant in `index.ts`, and it drifted: the
 * admin page said 0.3.5 while `package.json` said 0.4.2, which is the version the
 * bundle and the GitHub release were cut at. An update check compares the
 * installed version with the published tag, so a constant that is edited by hand
 * once per release is a check that answers the wrong question.
 *
 * Read from `package.json` beside the running file: `src/version.ts` finds it in
 * the source tree, `lib/version.js` finds the copy the bundle stages at the app
 * root. A missing or unreadable file is reported as `0.0.0` rather than thrown,
 * because a version is a diagnostic, not a reason for the tunnel to be down.
 *
 * @module dsh-mizar-relay/version
 */
import { readFileSync } from 'node:fs'

/** The version every other module reports. */
export const RELAY_VERSION: string = readPackageVersion()

/** Read `version` from the `package.json` one directory up from this file. */
function readPackageVersion(): string {
  try {
    const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
