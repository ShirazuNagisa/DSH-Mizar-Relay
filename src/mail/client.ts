/**
 * The account relay's side of the mail service.
 *
 * The account relay decides *whether* to mail somebody (a code was requested, a
 * threshold was crossed, an account was banned); the free relay owns the SMTP or
 * SES credentials and does the sending. This client is the one hop between them,
 * authenticated by a shared token and, at the nginx layer, by source address.
 *
 * @module dsh-mizar-relay/mail/client
 */
import type { MailKind, MailMessage } from './types.js'

/** What the client needs. */
export interface MailClientOptions {
  /** Origin of the relay that runs the service, e.g. `https://dshmizar.shirazu-nagisa.com`. */
  readonly url: string
  readonly token: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/** The mail service could not be reached, or refused the message. */
export class MailUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailUnavailableError'
  }
}

/** A client for the internal mail API. */
export class MailClient {
  readonly #options: MailClientOptions
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: MailClientOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch
    this.#timeoutMs = options.timeoutMs ?? 15_000
  }

  /**
   * Queue one mail on the service.
   *
   * @param message - kind, recipient and variables.
   * @throws MailUnavailableError when the service cannot be reached.
   */
  async send(message: MailMessage): Promise<void> {
    if (this.#options.url === '' || this.#options.token === '') {
      throw new MailUnavailableError('the mail service is not configured')
    }
    let response: Response
    try {
      response = await this.#fetch(`${this.#options.url}/internal/v1/mail`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#options.token}`,
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      throw new MailUnavailableError(
        `the mail service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as { error?: string; message?: string }
        detail = body.error ?? body.message ?? ''
      } catch {
        // A non-JSON answer is still a refusal; the status is enough.
      }
      throw new MailUnavailableError(
        `the mail service answered ${response.status}${detail === '' ? '' : `: ${detail}`}`,
      )
    }
  }

  /** Convenience: a registration or reset code. */
  async sendVerification(to: string, code: string, minutes: number): Promise<void> {
    await this.send({ kind: 'verification', to, data: { code, minutes: String(minutes) } })
  }

  /** Convenience: a traffic warning. */
  async sendWarning(to: string, data: { day: string; bytes: string; count: number }): Promise<void> {
    await this.send({
      kind: 'warning',
      to,
      data: { day: data.day, bytes: data.bytes, count: String(data.count) },
    })
  }

  /** Convenience: a ban notice. */
  async sendBanned(to: string, contact: string): Promise<void> {
    await this.send({ kind: 'banned', to, data: { contact } })
  }
}

/** The kinds the internal API accepts. */
export function isMailKind(value: unknown): value is MailKind {
  return value === 'verification' || value === 'warning' || value === 'banned'
}
