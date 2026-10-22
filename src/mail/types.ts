/**
 * The shapes the mail service and its clients share.
 *
 * A mail is described by its *kind* and its template variables, never by a
 * rendered body: the service may use Tencent's template API (where only the
 * template id and JSON variables travel) or plain SMTP (where this module
 * renders the body). Keeping the content out of the wire shape means a client
 * cannot ask the service to send arbitrary text.
 *
 * @module dsh-mizar-relay/mail/types
 */

/** The three transactional mails DSH-Mizar sends. */
export type MailKind = 'verification' | 'warning' | 'banned'

/** One queued mail, as it crosses the internal API. */
export interface MailMessage {
  readonly kind: MailKind
  readonly to: string
  readonly data: Readonly<Record<string, string>>
}

/** A fully rendered mail, handed to one transport. */
export interface OutgoingMail {
  readonly kind: MailKind
  readonly to: string
  readonly subject: string
  /** Tencent SES template id; `0` for a transport that renders locally. */
  readonly templateId: number
  readonly data: Readonly<Record<string, string>>
  readonly text: string
  readonly html: string
}

/** How one process actually transmits mail. */
export interface MailTransport {
  /** For logs and `/healthz`. */
  readonly name: string
  /**
   * Send one mail.
   *
   * @param mail - the rendered message.
   * @returns the provider's message id, when it has one.
   */
  send(mail: OutgoingMail): Promise<{ id: string }>
}
