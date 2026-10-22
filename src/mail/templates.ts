/**
 * The three mail templates, rendered twice: once for Tencent's template API and
 * once as text/HTML for SMTP.
 *
 * The HTML here is the same layout as `mail-templates/*.html` in the repository;
 * the Tencent console copy is the source of truth for the API route, and this
 * copy is what an SMTP deployment sends. Keep the variable names identical
 * (`code`, `minutes`, `day`, `bytes`, `count`, `contact`).
 *
 * @module dsh-mizar-relay/mail/templates
 */
import type { MailKind, MailMessage, OutgoingMail } from './types.js'

/** What one kind is called and which template id it uses. */
interface TemplateSpec {
  readonly subject: (data: Readonly<Record<string, string>>) => string
  readonly templateId: number
}

/** The two things a renderer needs. */
export interface TemplateIds {
  readonly verification: number
  readonly warning: number
  readonly banned: number
}

/**
 * Render one mail.
 *
 * @param message - kind, recipient and variables.
 * @param ids - Tencent template ids from the config.
 * @returns the rendered mail.
 */
export function renderMail(message: MailMessage, ids: TemplateIds): OutgoingMail {
  const data = normalize(message.kind, message.data)
  const spec = specFor(message.kind, data, ids)
  return {
    kind: message.kind,
    to: message.to,
    subject: spec.subject(data),
    templateId: spec.templateId,
    data,
    text: textFor(message.kind, data),
    html: htmlFor(message.kind, data),
  }
}

/** Fill the variables a template needs, so a malformed request cannot send `{{code}}`. */
function normalize(kind: MailKind, input: Readonly<Record<string, string>>): Record<string, string> {
  const clean = (value: unknown, max: number, fallback: string): string => {
    const text = typeof value === 'string' ? value.trim() : ''
    return (text === '' ? fallback : text).slice(0, max)
  }
  switch (kind) {
    case 'verification':
      return {
        code: clean(input['code'], 6, '------'),
        minutes: clean(input['minutes'], 3, '10'),
      }
    case 'warning':
      return {
        day: clean(input['day'], 10, '----/--/--'),
        bytes: clean(input['bytes'], 24, '—'),
        count: clean(input['count'], 1, '1'),
      }
    case 'banned':
      return { contact: clean(input['contact'], 120, 'shirazunagisa@icloud.com') }
  }
}

/** The subject and template id for one kind. */
function specFor(kind: MailKind, data: Readonly<Record<string, string>>, ids: TemplateIds): TemplateSpec {
  switch (kind) {
    case 'verification':
      return { templateId: ids.verification, subject: () => '【DSH-Mizar】注册验证码' }
    case 'warning':
      return {
        templateId: ids.warning,
        subject: () => `【DSH-Mizar】流量异常提醒（第 ${data['count'] ?? '1'} 次）`,
      }
    case 'banned':
      return { templateId: ids.banned, subject: () => '【DSH-Mizar】账户已被停用' }
  }
}

/** The plain-text body. */
function textFor(kind: MailKind, data: Readonly<Record<string, string>>): string {
  const footer = '\n\n此邮件由系统发出，请勿回复。\nDSH-Mizar · noreply@shirazu-nagisa.com'
  switch (kind) {
    case 'verification':
      return (
        `你正在注册 DSH-Mizar 账户。验证码：${data['code']}\n` +
        `验证码在 ${data['minutes']} 分钟内有效，只能使用一次。请勿把它告诉任何人。\n` +
        '如果这不是你本人的操作，忽略这封邮件即可。' +
        footer
      )
    case 'warning':
      return (
        `你的账户在 ${data['day']}（UTC）通过中继服务器传输了 ${data['bytes']}，` +
        `超过了你所在套餐的每日阈值。\n` +
        `这是 30 天内的第 ${data['count']} 次提醒（最多 3 次）。再次触发将自动停用账户。\n` +
        '如果手机和电脑在同一个 Wi-Fi，打开「设置 → 传输 → 局域网优先」可以不消耗中继流量。' +
        footer
      )
    case 'banned':
      return (
        '你的账户在 30 天内多次触发流量异常提醒，已被自动停用，当前登录的设备已全部退出。\n' +
        `如果你认为这是误判，请写信到 ${data['contact']}，附上用户名和大致使用情况。\n` +
        '核实之后可以恢复账户；恢复时警告次数会清零。' +
        footer
      )
  }
}

/** The HTML body, matching the templates uploaded to Tencent. */
function htmlFor(kind: MailKind, data: Readonly<Record<string, string>>): string {
  const title =
    kind === 'verification' ? '注册验证码' : kind === 'warning' ? '流量异常提醒' : '账户已被停用'
  const body = htmlBody(kind, data)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2f3f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;padding:32px 28px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1e">
<tr><td style="font-size:13px;letter-spacing:.08em;color:#8a8f98;padding-bottom:18px">DSH-MIZAR</td></tr>
<tr><td style="font-size:22px;font-weight:700;padding-bottom:12px">${title}</td></tr>
${body}
<tr><td style="border-top:1px solid #eef0f3;padding-top:16px;font-size:12px;line-height:1.6;color:#9aa0a8">此邮件由系统发出，请勿回复。<br>DSH-Mizar · noreply@shirazu-nagisa.com</td></tr>
</table></td></tr></table></body></html>`
}

/** The middle rows, per kind. */
function htmlBody(kind: MailKind, data: Readonly<Record<string, string>>): string {
  switch (kind) {
    case 'verification':
      return `<tr><td style="font-size:15px;line-height:1.7;color:#3a3f47;padding-bottom:8px">你正在注册 DSH-Mizar 账户。请把这 6 位验证码填进 App：</td></tr>
<tr><td style="padding:18px 0 14px 0"><div style="display:inline-block;background:#f5f7fa;border:1px solid #e3e7ee;border-radius:10px;padding:16px 22px;font-size:32px;font-weight:700;letter-spacing:10px">${data['code']}</div></td></tr>
<tr><td style="font-size:14px;line-height:1.7;color:#6b7280;padding-bottom:18px">验证码在 ${data['minutes']} 分钟内有效，只能使用一次。请勿把它告诉任何人。</td></tr>
<tr><td style="font-size:14px;line-height:1.7;color:#6b7280;padding-bottom:22px">如果这不是你本人的操作，忽略这封邮件即可。</td></tr>`
    case 'warning':
      return `<tr><td style="font-size:15px;line-height:1.8;color:#3a3f47;padding-bottom:14px">你的账户在 ${data['day']}（UTC）通过中继服务器传输了 <strong>${data['bytes']}</strong>，超过了你所在套餐的每日阈值。</td></tr>
<tr><td style="background:#fff8e8;border:1px solid #f4e2b8;border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.75;color:#7a5a12">这是 30 天内的第 <strong>${data['count']}</strong> 次提醒（最多 3 次）。如果再次触发，账户会被自动停用。</td></tr>
<tr><td style="font-size:14px;line-height:1.9;color:#3a3f47;padding-top:18px;padding-bottom:20px">· 手机和电脑在同一个 Wi-Fi 时，打开「设置 → 传输 → 局域网优先」<br>· 关闭不必要的长会话同步，或把附件改到电脑上发送</td></tr>`
    case 'banned':
      return `<tr><td style="font-size:15px;line-height:1.8;color:#3a3f47;padding-bottom:14px">你的账户在 30 天内多次触发流量异常提醒，已被自动停用。这个账户当前登录的设备已经全部退出。</td></tr>
<tr><td style="background:#fdf0f0;border:1px solid #f3cfcf;border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.75;color:#8a2c2c">如果你认为这是误判，请写信到 <strong>${data['contact']}</strong>，附上用户名和大致的使用情况。</td></tr>
<tr><td style="font-size:14px;line-height:1.8;color:#6b7280;padding-top:18px;padding-bottom:22px">核实之后可以恢复账户；恢复时警告次数会清零。</td></tr>`
  }
}
