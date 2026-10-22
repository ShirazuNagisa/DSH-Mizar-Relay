/**
 * Tencent Cloud SES, over its JSON API.
 *
 * SES's SMTP submission is closed to individually-verified accounts that opened
 * the service after 2026-03-02, and its API refuses free-form bodies unless the
 * account applied for that exception. Templates are therefore the only route
 * that works for everybody, and this client is built around them: a template id
 * plus a JSON object of variables.
 *
 * The signing is TC3-HMAC-SHA256, the same scheme every Tencent Cloud API uses.
 * It is implemented here rather than pulled in as an SDK because the relay
 * deploys as a bundle with no `npm install` step; `node:crypto` is enough.
 *
 * @module dsh-mizar-relay/mail/tencent
 */
import { createHash, createHmac } from 'node:crypto'
import type { MailTransport, OutgoingMail } from './types.js'

/** What the client needs. */
export interface TencentMailOptions {
  readonly secretId: string
  readonly secretKey: string
  /** `ap-hongkong` or `ap-guangzhou`; must match where the templates live. */
  readonly region: string
  /** `DSH-Mizar <noreply@shirazu-nagisa.com>`. */
  readonly from: string
  /** Where a reply goes; the ban template prints this too. */
  readonly replyTo: string
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/** The SES API version the templates were created under. */
const API_VERSION = '2020-10-02'

/** The one host that serves SES. */
const ENDPOINT = 'ses.tencentcloudapi.com'

/** A failed send, with the provider's own code kept for the log. */
export class TencentMailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string,
  ) {
    super(`${code}: ${message}${requestId === '' ? '' : ` (request ${requestId})`}`)
    this.name = 'TencentMailError'
  }
}

/** The SES transport. */
export class TencentMailTransport implements MailTransport {
  readonly name = 'tencent-ses'
  readonly #options: TencentMailOptions
  readonly #fetch: typeof fetch
  readonly #host: string
  readonly #timeoutMs: number

  constructor(options: TencentMailOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch
    this.#host = options.endpoint ?? ENDPOINT
    this.#timeoutMs = options.timeoutMs ?? 15_000
  }

  /**
   * Send one templated mail.
   *
   * @param mail - the rendered mail.
   * @returns the provider's message id.
   */
  async send(mail: OutgoingMail): Promise<{ id: string }> {
    const payload = JSON.stringify({
      FromEmailAddress: this.#options.from,
      ReplyToAddresses: this.#options.replyTo,
      Destination: [mail.to],
      Subject: mail.subject,
      Template: {
        TemplateID: mail.templateId,
        TemplateData: JSON.stringify(mail.data),
      },
      // 1 = transactional. Verification codes take the immediate lane.
      TriggerType: 1,
    })
    const response = await this.#call('SendEmail', payload)
    const body = response as {
      Response?: {
        MessageId?: string
        RequestId?: string
        Error?: { Code?: string; Message?: string }
      }
    }
    const result = body.Response ?? {}
    if (result.Error !== undefined) {
      throw new TencentMailError(
        result.Error.Code ?? 'UNKNOWN',
        result.Error.Message ?? 'the mail API refused the message',
        result.RequestId ?? '',
      )
    }
    return { id: result.MessageId ?? result.RequestId ?? '' }
  }

  /** Sign and POST one action. */
  async #call(action: string, payload: string): Promise<unknown> {
    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
    const contentType = 'application/json; charset=utf-8'
    const signedHeaders = 'content-type;host'
    const canonicalRequest = [
      'POST',
      '/',
      '',
      `content-type:${contentType}\nhost:${this.#host}\n`,
      signedHeaders,
      sha256(payload),
    ].join('\n')
    const scope = `${date}/ses/tc3_request`
    const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256(canonicalRequest)].join('\n')
    const kDate = hmac(`TC3${this.#options.secretKey}`, date)
    const kService = hmac(kDate, 'ses')
    const kSigning = hmac(kService, 'tc3_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    const response = await this.#fetch(`https://${this.#host}`, {
      method: 'POST',
      headers: {
        Authorization:
          `TC3-HMAC-SHA256 Credential=${this.#options.secretId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'Content-Type': contentType,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': API_VERSION,
        'X-TC-Region': this.#options.region,
      },
      body: payload,
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new TencentMailError('MALFORMED_RESPONSE', `the mail API answered ${response.status}`, '')
    }
    if (!response.ok) {
      throw new TencentMailError('HTTP_ERROR', `the mail API answered ${response.status}`, '')
    }
    return parsed
  }
}

/** SHA-256, lowercase hex. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** HMAC-SHA256 with a string or byte key, as raw bytes. */
function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}
