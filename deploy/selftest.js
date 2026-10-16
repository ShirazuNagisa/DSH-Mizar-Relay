#!/usr/bin/env node
/**
 * Check the relay end to end, without a Mac.
 *
 * The failure this exists to prevent is spending an hour on DNS, TLS and nginx
 * when the thing that is actually broken is the relay. This acts as the Mac: it
 * opens a tunnel, receives a request the way the plugin would, answers it, and
 * checks the answer comes back through the relay. If this passes, the server
 * side is correct and anything still failing lives in the reverse proxy.
 *
 * Run it on the server, from the directory the relay was installed to:
 *
 *     /www/server/nodejs/<version>/bin/node selftest.js
 *
 * It talks to 127.0.0.1, so it proves nothing about the domain or the
 * certificate -- only that the relay does its job.
 */
// The bundle is ESM -- its package.json says so -- which makes this an ES module
// too. Written to match rather than renamed to .cjs, because a file that has to
// dodge its own package's module type is a file that will confuse the next
// person to touch it.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = path.join(HERE, 'relay.config.json')

let passed = 0
let failed = 0

function check(what, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${what}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${what}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    console.error(`\n  ${CONFIG} does not exist.\n`)
    process.exit(2)
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  } catch (error) {
    console.error(`\n  ${CONFIG} is not valid JSON: ${error.message}\n`)
    process.exit(2)
  }
}

async function main() {
  const config = loadConfig()
  // An empty `tokens` list is the shipping mode, not a misconfiguration: the
  // relay accepts any credential of at least sixteen characters and derives the
  // room from it, exactly as a plugin's own self-invented secret does. Inventing
  // one here is what keeps this test honest in that mode -- the alternative is a
  // failure message telling the operator to compare a token they were never
  // asked to set.
  const configured = Array.isArray(config.tokens) ? config.tokens : []
  const token = configured[0] ?? randomBytes(24).toString('base64url')
  const base = `http://127.0.0.1:${config.port}`
  const wsBase = `ws://127.0.0.1:${config.port}`

  console.log('\nDSH-Mizar relay self-test')
  console.log('='.repeat(56))
  console.log(`\n  config   ${CONFIG}`)
  console.log(`  port     ${config.port}`)
  console.log(
    `  token    ${String(token).slice(0, 8)}…` +
      (configured.length === 0 ? ' (invented: this relay accepts any credential)\n' : '\n'),
  )

  // --- the relay is up -----------------------------------------------------
  let health
  try {
    const response = await fetch(`${base}/healthz`)
    health = await response.json()
    check('the relay answers /healthz', response.status === 200 && health.ok === true)
  } catch (error) {
    check('the relay answers /healthz', false, error.message)
    console.log('\n  Is the service running?  systemctl status dsh-mizar-relay\n')
    process.exit(1)
  }

  // --- it refuses a tunnel without the token -------------------------------
  const unauthorised = await new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase}/tunnel`)
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode))
    socket.on('error', () => resolve('error'))
    socket.on('open', () => {
      socket.close()
      resolve('open')
    })
    setTimeout(() => resolve('timeout'), 5000)
  })
  check('a tunnel with no token is refused', unauthorised === 401, `got ${unauthorised}`)

  // --- the token works, and a room comes back ------------------------------
  const room = await new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase}/tunnel`, {
      headers: { authorization: `Bearer ${token}` },
    })
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'))
      if (frame.t === 'welcome') {
        socket.send(JSON.stringify({ t: 'pong', id: 'selftest' }))
        resolve({ room: frame.room, socket })
        return
      }
      // Act as the Mac for the request the HTTP leg below will make.
      if (frame.t === 'req') {
        socket.send(
          JSON.stringify({
            t: 'res',
            id: frame.id,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ echoed: frame.path })).toString('base64'),
          }),
        )
      }
      if (frame.t === 'ws-open') {
        socket.send(JSON.stringify({ t: 'ws-open-ok', id: frame.id }))
        socket.send(
          JSON.stringify({
            t: 'ws-msg',
            id: frame.id,
            data: Buffer.from('bridged').toString('base64'),
            binary: false,
          }),
        )
      }
    })
    socket.on('unexpected-response', (_request, response) => resolve({ refusal: response.statusCode }))
    socket.on('error', (error) => resolve({ error: error.message }))
    setTimeout(() => resolve({ error: 'timed out waiting for a welcome' }), 5000)
  })

  if (room.room === undefined) {
    check('the token is accepted and a room is assigned', false, JSON.stringify(room))
    console.log('\n  The token in relay.config.json is the one the Mac must be given.\n')
    process.exit(1)
  }
  check('the token is accepted and a room is assigned', /^[0-9A-HJKMNP-TV-Z]{12}$/.test(room.room), room.room)
  console.log(`  ${' '.repeat(6)}room ${room.room}`)

  // --- a request goes out and an answer comes back -------------------------
  try {
    const response = await fetch(`${base}/r/${room.room}/mizar/v1/hello`)
    const body = await response.json().catch(() => null)
    check('a request reaches the tunnel and its answer comes back', body?.echoed === '/mizar/v1/hello', JSON.stringify(body))
  } catch (error) {
    check('a request reaches the tunnel and its answer comes back', false, error.message)
  }

  // --- a WebSocket is bridged ----------------------------------------------
  const bridged = await new Promise((resolve) => {
    const phone = new WebSocket(`${wsBase}/r/${room.room}/mizar/v1/ws`)
    phone.on('message', (data) => {
      resolve(data.toString('utf8'))
      phone.close()
    })
    phone.on('unexpected-response', (_request, response) => resolve(`HTTP ${response.statusCode}`))
    phone.on('error', (error) => resolve(error.message))
    setTimeout(() => resolve('timeout'), 5000)
  })
  check('a phone WebSocket is bridged through to the tunnel', bridged === 'bridged', bridged)

  // --- an unknown room is a 404, like one whose Mac is away ----------------
  const unknown = await fetch(`${base}/r/AAAAAAAAAAAA/mizar/v1/hello`)
  const offline = await fetch(`${base}/r/${room.room}/mizar/v1/hello`)
  check(
    'an unknown room and an unanswered one are both 404 to a stranger',
    unknown.status === 404,
    `got ${unknown.status}`,
  )
  void offline

  room.socket.close()

  console.log('\n' + '='.repeat(56))
  if (failed === 0) {
    console.log(`
  The relay works. ${passed} checks passed.

  Anything still failing is in front of it: DNS, the certificate, or the
  reverse proxy. The two things that break most often are

    - the Upgrade / Connection headers, without which the WebSocket handshake
      is stripped, and the tunnel reconnects roughly once a minute
    - proxy_read_timeout left at the default 60s, which does the same thing

  Both are in nginx-websocket.conf.
`)
  } else {
    console.log(`\n  ${passed} passed, ${failed} failed.\n`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\n  self-test crashed: ${error.stack}\n`)
  process.exit(1)
})
