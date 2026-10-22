/**
 * A small SMTP client, for deployments that are allowed to use it.
 *
 * Tencent's SMTP submission is closed to newly-opened individual accounts, but
 * enterprise accounts, older accounts and other providers (Aliyun DirectMail,
 * for one) still speak it. This client is deliberately narrow: implicit TLS on
 * 465 or STARTTLS on 587, `AUTH LOGIN`, one recipient, one UTF-8 HTML+text body.
 * It is not a general mail library and does not pretend to be.
 *
 * @module dsh-mizar-relay/mail/smtp
 */
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomBytes } from 'node:crypto'
import type { MailTransport, OutgoingMail } from './types.js'

/** What the SMTP transport needs. */
export interface SmtpMailOptions {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user: string
  readonly password: string
  readonly from: string
  readonly replyTo: string
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
}

/** One server reply. */
interface Reply {
  readonly code: number
  readonly lines: readonly string[]
}

/** A failed SMTP exchange. */
export class SmtpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SmtpError'
  }
}

/** The SMTP transport. */
export class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp'
  readonly #options: SmtpMailOptions
  readonly #timeoutMs: number

  constructor(options: SmtpMailOptions) {
    this.#options = options
    this.#timeoutMs = options.timeoutMs ?? 20_000
  }

  /**
   * Send one mail over a fresh connection.
   *
   * @param mail - the rendered mail.
   * @returns an id derived from the Message-ID.
   */
  async send(mail: OutgoingMail): Promise<{ id: string }> {
    const messageId = `<${randomBytes(12).toString('hex')}@shirazu-nagisa.com>`
    const connection = await Connection.open(this.#options, this.#timeoutMs)
    try {
      await connection.expect(220, 'greeting')
      await connection.command(`EHLO ${heloName()}`, 250)
      if (!this.#options.secure) {
        await connection.command('STARTTLS', 220)
        await connection.upgrade(this.#timeoutMs)
        await connection.command(`EHLO ${heloName()}`, 250)
      }
      await connection.command('AUTH LOGIN', 334)
      await connection.command(Buffer.from(this.#options.user, 'utf8').toString('base64'), 334)
      await connection.command(Buffer.from(this.#options.password, 'utf8').toString('base64'), 235)
      await connection.command(`MAIL FROM:<${this.#options.from}>`, 250)
      await connection.command(`RCPT TO:<${mail.to}>`, 250)
      await connection.command('DATA', 354)
      await connection.write(`${buildMessage(mail, this.#options, messageId)}\r\n.\r\n`)
      await connection.expect(250, 'message accepted')
      await connection.command('QUIT', 221).catch(() => undefined)
      return { id: messageId }
    } finally {
      connection.close()
    }
  }
}

/** One open SMTP conversation. */
class Connection {
  #socket: Socket | TLSSocket
  #buffer = ''
  #lines: string[] = []
  #waiter: (() => void) | null = null

  private constructor(socket: Socket | TLSSocket) {
    this.#socket = socket
    this.#attach(socket)
  }

  /** Attach the line splitter to whichever socket is current. */
  #attach(socket: Socket | TLSSocket): void {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk
      let index = this.#buffer.indexOf('\r\n')
      while (index >= 0) {
        this.#lines.push(this.#buffer.slice(0, index))
        this.#buffer = this.#buffer.slice(index + 2)
        index = this.#buffer.indexOf('\r\n')
      }
      const waiter = this.#waiter
      this.#waiter = null
      waiter?.()
    })
  }

  /** Connect, TLS-first when the port is 465. */
  static async open(options: SmtpMailOptions, timeoutMs: number): Promise<Connection> {
    const socket = options.secure
      ? tlsConnect({ host: options.host, port: options.port, servername: options.host })
      : netConnect({ host: options.host, port: options.port })
    socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError('SMTP connection timed out')))
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', () => resolve())
      socket.once('connect', () => {
        if (!options.secure) resolve()
      })
      socket.once('error', reject)
      socket.once('timeout', () => reject(new SmtpError('SMTP connection timed out')))
    })
    return new Connection(socket)
  }

  /** Read one reply, following `250-` continuation lines. */
  async readReply(): Promise<Reply> {
    const lines: string[] = []
    for (;;) {
      const line = await this.#readLine()
      lines.push(line)
      // `250-...` continues; `250 ...` ends. A three-digit code alone ends too.
      if (line.length < 4 || line[3] !== '-') {
        const code = Number(line.slice(0, 3))
        if (!Number.isFinite(code)) throw new SmtpError(`SMTP answered "${line}"`)
        return { code, lines }
      }
    }
  }

  /** Send a command and require one particular reply code. */
  async command(command: string, expected: number): Promise<Reply> {
    this.#socket.write(`${command}\r\n`)
    return this.expect(expected, command.split(' ')[0] ?? command)
  }

  /** Read and check one reply. */
  async expect(code: number, label: string): Promise<Reply> {
    const reply = await this.readReply()
    if (reply.code !== code) {
      throw new SmtpError(`SMTP ${label} expected ${code}, got ${reply.code}: ${reply.lines.join(' ')}`)
    }
    return reply
  }

  /** Write raw bytes (the DATA body). */
  async write(data: string): Promise<void> {
    this.#socket.write(data)
  }

  /** Upgrade a plaintext 587 connection. */
  async upgrade(timeoutMs: number): Promise<void> {
    const upgraded = tlsConnect({ socket: this.#socket, servername: '' })
    await new Promise<void>((resolve, reject) => {
      upgraded.once('secureConnect', () => resolve())
      upgraded.once('error', reject)
      upgraded.setTimeout(timeoutMs, () => upgraded.destroy(new SmtpError('SMTP TLS timed out')))
    })
    // The old socket is wrapped, not replaced, by TLS: its listeners would keep
    // reading ciphertext. Drop them and attach the splitter to the TLS socket.
    this.#socket.removeAllListeners('data')
    this.#socket = upgraded
    this.#attach(upgraded)
  }

  /** Close without ceremony. */
  close(): void {
    this.#socket.destroy()
  }

  /** Wait for one complete line. */
  async #readLine(): Promise<string> {
    for (;;) {
      const line = this.#lines.shift()
      if (line !== undefined) return line
      if (this.#socket.destroyed) throw new SmtpError('SMTP connection closed')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#waiter = null
          reject(new SmtpError('SMTP read timed out'))
        }, 20_000)
        this.#waiter = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }
}

/** The name this client announces. */
function heloName(): string {
  return 'dshmizar.shirazu-nagisa.com'
}

/** Build an RFC 5322 message with a UTF-8 HTML + text alternative. */
function buildMessage(mail: OutgoingMail, options: SmtpMailOptions, messageId: string): string {
  const boundary = `mizar-${randomBytes(8).toString('hex')}`
  const encode = (value: string): string => `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
  const body = (value: string): string =>
    Buffer.from(value, 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n')
  return [
    `From: ${encode('DSH-Mizar')} <${options.from}>`,
    `To: <${mail.to}>`,
    `Reply-To: <${options.replyTo}>`,
    `Subject: ${encode(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body(mail.html),
    `--${boundary}--`,
  ].join('\r\n')
}
