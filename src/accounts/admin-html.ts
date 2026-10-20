/**
 * The admin UI's HTML.
 *
 * Server-rendered, one stylesheet, no JavaScript. The page is a diagnostic and
 * configuration surface for one operator; a framework would be more code to
 * deploy than the feature. Every value that comes from a user or a request is
 * escaped by the caller (`h`) before it reaches these templates.
 *
 * @module dsh-mizar-relay/accounts/admin-html
 */
import { escapeHtml as h } from '../http.js'

/** Common page chrome. */
function layout(title: string, body: string, options: { readonly signedIn: boolean; readonly notice?: string }): string {
  const nav = options.signedIn
    ? `<nav>
        <a href="/admin">总览</a>
        <a href="/admin/users">用户</a>
        <a href="/admin/guests">未注册客户端</a>
        <a href="/admin/invites">邀请码</a>
        <a href="/admin/traffic">流量</a>
        <a href="/admin/settings">设置</a>
        <form method="post" action="/admin/logout" class="inline"><button type="submit">退出</button></form>
      </nav>`
    : ''
  const notice =
    options.notice === undefined || options.notice === ''
      ? ''
      : `<p class="notice">${h(options.notice)}</p>`
  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${h(title)} · DSH-Mizar</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --ink:#e6edf3; --muted:#8b949e; --line:#30363d; --accent:#3b82f6; --ok:#3fb950; --warn:#d29922; --bad:#f85149; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:24px; flex-wrap:wrap; }
    header h1 { margin:0; font-size:18px; }
    nav { display:flex; gap:14px; flex-wrap:wrap; align-items:center; }
    nav a { color:var(--muted); text-decoration:none; }
    nav a:hover { color:var(--ink); }
    nav form.inline { margin:0 0 0 auto; }
    main { padding:24px; max-width:1200px; margin:0 auto; }
    h2 { font-size:16px; margin:0 0 14px; }
    table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
    th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    tr:last-child td { border-bottom:0; }
    .muted { color:var(--muted); }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:24px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
    .card .label { color:var(--muted); font-size:12px; }
    .card .value { font-size:22px; font-weight:650; margin-top:4px; }
    .pill { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; color:var(--muted); }
    .pill.paid { color:var(--ok); border-color:color-mix(in srgb,var(--ok) 45%,transparent); }
    .pill.free { color:var(--muted); }
    .pill.bad { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 45%,transparent); }
    form.stack { display:grid; gap:10px; max-width:420px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
    label { display:grid; gap:4px; color:var(--muted); font-size:12px; }
    input, select { background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:7px; padding:8px 10px; font:inherit; }
    button { background:var(--accent); color:white; border:0; border-radius:7px; padding:7px 12px; font:inherit; cursor:pointer; }
    button.ghost { background:transparent; border:1px solid var(--line); color:var(--ink); }
    button.danger { background:transparent; border:1px solid color-mix(in srgb,var(--bad) 50%,transparent); color:var(--bad); }
    .notice { background:color-mix(in srgb,var(--ok) 12%,transparent); border:1px solid color-mix(in srgb,var(--ok) 35%,transparent); padding:8px 12px; border-radius:8px; }
    .warning { background:color-mix(in srgb,var(--warn) 12%,transparent); border:1px solid color-mix(in srgb,var(--warn) 35%,transparent); padding:8px 12px; border-radius:8px; }
    .error { color:var(--bad); }
    .login { max-width:360px; margin:12vh auto; }
    .login h1 { text-align:center; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .search { display:flex; gap:8px; margin-bottom:14px; max-width:520px; }
    .search input { flex:1; }
    .pager { display:flex; gap:10px; align-items:center; margin-top:14px; }
    a { color:var(--accent); }
  </style>
</head>
<body>
  <header><h1>DSH-Mizar 中继后台</h1>${nav}</header>
  <main>${notice}${body}</main>
</body>
</html>`
}

/** Format epoch ms as a compact date-time. */
export function formatTime(value: number | null): string {
  if (value === null) return '—'
  return new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

/** Format bytes. */
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit] ?? 'B'}`
}

/** A plan pill. */
export function planPill(plan: 'free' | 'paid', disabled = false): string {
  if (disabled) return '<span class="pill bad">已停用</span>'
  return plan === 'paid'
    ? '<span class="pill paid">付费账户</span>'
    : '<span class="pill free">免费账户</span>'
}

/** The login page. */
export function loginPage(error?: string): string {
  return layout(
    '登录',
    `<section class="login">
      <h1>DSH-Mizar 中继后台</h1>
      ${error === undefined ? '' : `<p class="error">${h(error)}</p>`}
      <form method="post" action="/admin/login" class="stack">
        <label>管理员密码<input type="password" name="password" autocomplete="current-password" required autofocus></label>
        <button type="submit">登录</button>
      </form>
    </section>`,
    { signedIn: false },
  )
}

/** Dashboard data. */
export interface DashboardData {
  readonly userCount: number
  readonly paidCount: number
  readonly guestCount: number
  readonly todayIn: number
  readonly todayOut: number
  readonly relays: ReadonlyArray<{ readonly id: string; readonly role: 0 | 1; readonly lastReportAt: number }>
  readonly productId: string
}

/** The dashboard. */
export function dashboardPage(data: DashboardData, notice?: string): string {
  const relays = data.relays
    .map(
      (relay) => `<tr>
        <td class="mono">${h(relay.id)}</td>
        <td>${relay.role === 1 ? '付费服务器 (1)' : '免费服务器 (0)'}</td>
        <td class="muted">${h(formatTime(relay.lastReportAt))}</td>
      </tr>`,
    )
    .join('')
  return layout(
    '总览',
    `<h2>总览</h2>
     <div class="grid">
       <div class="card"><div class="label">账户</div><div class="value">${data.userCount}</div></div>
       <div class="card"><div class="label">付费账户</div><div class="value">${data.paidCount}</div></div>
       <div class="card"><div class="label">未注册客户端</div><div class="value">${data.guestCount}</div></div>
       <div class="card"><div class="label">今日流量</div><div class="value">${h(formatBytes(data.todayIn + data.todayOut))}</div></div>
     </div>
     <h2>中继</h2>
     <table><thead><tr><th>中继 ID</th><th>角色</th><th>最近上报</th></tr></thead><tbody>${relays || '<tr><td colspan="3" class="muted">还没有中继上报</td></tr>'}</tbody></table>
     <p class="muted" style="margin-top:16px">App Store 产品：<span class="mono">${h(data.productId)}</span>（价格以 App Store Connect 为准）</p>`,
    { signedIn: true, ...(notice === undefined ? {} : { notice }) },
  )
}

/** One row in the users table. */
export interface AdminUserRow {
  readonly id: string
  readonly username: string
  readonly email: string | null
  readonly plan: 'free' | 'paid'
  readonly disabled: boolean
  readonly paidUntil: number | null
  readonly paidSources: readonly string[]
  readonly devices: number
  readonly lastSeenAt: number
  readonly todayIn: number
  readonly todayOut: number
}

/** The users list. */
export function usersPage(data: {
  readonly rows: readonly AdminUserRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly query: string
}, notice?: string): string {
  const rows = data.rows
    .map(
      (row) => `<tr>
        <td><a href="/admin/users/${encodeURIComponent(row.id)}">${h(row.username)}</a></td>
        <td class="mono">${h(row.email ?? '—')}</td>
        <td>${planPill(row.plan, row.disabled)} ${row.paidSources.length > 0 ? `<span class="muted">${h(row.paidSources.join(' + '))}</span>` : ''}</td>
        <td>${row.paidUntil === null ? '—' : h(formatTime(row.paidUntil))}</td>
        <td>${row.devices}</td>
        <td class="muted">${h(formatTime(row.lastSeenAt))}</td>
        <td>${h(formatBytes(row.todayIn + row.todayOut))}</td>
      </tr>`,
    )
    .join('')
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize))
  return layout(
    '用户',
    `<h2>用户 <span class="muted">(${data.total})</span></h2>
     <form class="search" method="get" action="/admin/users">
       <input name="q" value="${h(data.query)}" placeholder="搜索用户名 / 邮箱 / ID">
       <button type="submit">搜索</button>
     </form>
     <table><thead><tr><th>用户名</th><th>邮箱</th><th>状态</th><th>付费至</th><th>设备</th><th>最近出现</th><th>今日流量</th></tr></thead>
     <tbody>${rows || '<tr><td colspan="7" class="muted">没有匹配的账户</td></tr>'}</tbody></table>
     <div class="pager"><span class="muted">第 ${data.page} / ${pages} 页</span>
       ${data.page > 1 ? `<a href="/admin/users?q=${encodeURIComponent(data.query)}&page=${data.page - 1}">上一页</a>` : ''}
       ${data.page < pages ? `<a href="/admin/users?q=${encodeURIComponent(data.query)}&page=${data.page + 1}">下一页</a>` : ''}
     </div>`,
    { signedIn: true, ...(notice === undefined ? {} : { notice }) },
  )
}

/** User detail data. */
export interface AdminUserDetail {
  readonly row: AdminUserRow
  readonly emailVerified: boolean
  readonly apple: boolean
  readonly createdAt: number
  readonly grantedPaidUntil: number | null
  readonly appStore: {
    readonly paidUntil: number | null
    readonly environment: string
    readonly autoRenew: boolean
    readonly revokedAt: number | null
    readonly lastVerifiedAt: number
    readonly originalTransactionId: string
  } | null
  readonly devices: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly model: string
    readonly platform: string
    readonly loginAt: number
    readonly lastSeenAt: number
    readonly revokedAt: number | null
  }>
  readonly traffic: { readonly totalIn: number; readonly totalOut: number; readonly todayIn: number; readonly todayOut: number }
  readonly sessionCount: number
}

/** The user detail page. */
export function userPage(user: AdminUserDetail, csrf: string, notice?: string): string {
  const devices = user.devices
    .map(
      (device) => `<tr>
        <td>${h(device.name)} <span class="muted mono">${h(device.id)}</span></td>
        <td class="mono">${h(device.model)} / ${h(device.platform)}</td>
        <td class="muted">${h(formatTime(device.loginAt))}</td>
        <td class="muted">${h(formatTime(device.lastSeenAt))}</td>
        <td>${device.revokedAt === null ? '<span class="pill paid">活动</span>' : `<span class="pill bad">${h(formatTime(device.revokedAt))}</span>`}</td>
        <td>${device.revokedAt === null ? `<form method="post" action="/admin/users/${encodeURIComponent(user.row.id)}/devices/${encodeURIComponent(device.id)}/revoke"><input type="hidden" name="_csrf" value="${h(csrf)}"><button class="danger" type="submit">吊销</button></form>` : ''}</td>
      </tr>`,
    )
    .join('')
  const appStore = user.appStore === null
    ? '<p class="muted">没有 App Store 订阅记录。</p>'
    : `<table><tbody>
        <tr><th>订阅至</th><td>${h(formatTime(user.appStore.paidUntil))}</td></tr>
        <tr><th>环境</th><td>${h(user.appStore.environment)}</td></tr>
        <tr><th>自动续期</th><td>${user.appStore.autoRenew ? '是' : '否'}</td></tr>
        <tr><th>撤销于</th><td>${h(formatTime(user.appStore.revokedAt))}</td></tr>
        <tr><th>最近校验</th><td>${h(formatTime(user.appStore.lastVerifiedAt))}</td></tr>
        <tr><th>原始交易</th><td class="mono">…${h(user.appStore.originalTransactionId.slice(-6))}</td></tr>
      </tbody></table>`
  return layout(
    '用户详情',
    `<p><a href="/admin/users">← 返回用户列表</a></p>
     <h2>${h(user.row.username)} ${planPill(user.row.plan, user.row.disabled)}</h2>
     <div class="grid">
       <div class="card"><div class="label">邮箱</div><div class="mono">${h(user.row.email ?? '—')}</div><div class="muted">${user.emailVerified ? '已验证' : '未验证'}</div></div>
       <div class="card"><div class="label">登录方式</div><div>${user.apple ? 'Apple + 密码' : '邮箱密码'}</div></div>
       <div class="card"><div class="label">创建时间</div><div class="muted">${h(formatTime(user.createdAt))}</div></div>
       <div class="card"><div class="label">今日流量</div><div>${h(formatBytes(user.traffic.todayIn + user.traffic.todayOut))}</div></div>
       <div class="card"><div class="label">累计流量</div><div>${h(formatBytes(user.traffic.totalIn + user.traffic.totalOut))}</div></div>
     </div>
     <h2>权益</h2>
     <table><tbody>
       <tr><th>人工权益至</th><td>${h(formatTime(user.grantedPaidUntil))}</td></tr>
       <tr><th>有效付费至</th><td>${h(formatTime(user.row.paidUntil))}</td></tr>
       <tr><th>来源</th><td>${user.row.paidSources.length === 0 ? '—' : h(user.row.paidSources.join(' + '))}</td></tr>
     </tbody></table>
     <h2 style="margin-top:24px">App Store</h2>
     ${appStore}
     <h2 style="margin-top:24px">操作</h2>
     <div class="actions">
       <form method="post" action="/admin/users/${encodeURIComponent(user.row.id)}/plan" class="search">
         <input type="hidden" name="_csrf" value="${h(csrf)}">
         <input name="days" type="number" min="0" max="3650" placeholder="增加天数，0 = 清除" required>
         <button type="submit">调整人工权益</button>
       </form>
       <form method="post" action="/admin/users/${encodeURIComponent(user.row.id)}/disable">
         <input type="hidden" name="_csrf" value="${h(csrf)}">
         <input type="hidden" name="disabled" value="${user.row.disabled ? '0' : '1'}">
         <button class="${user.row.disabled ? 'ghost' : 'danger'}" type="submit">${user.row.disabled ? '启用账户' : '停用账户'}</button>
       </form>
     </div>
     <h2 style="margin-top:24px">设备 <span class="muted">(${user.devices.length})</span></h2>
     <table><thead><tr><th>设备</th><th>型号</th><th>登录</th><th>最近</th><th>状态</th><th></th></tr></thead><tbody>${devices || '<tr><td colspan="6" class="muted">没有设备</td></tr>'}</tbody></table>
     <p class="muted" style="margin-top:12px">该账户有 ${user.sessionCount} 条历史会话令牌映射；页面不显示令牌或密码。</p>`,
    { signedIn: true, ...(notice === undefined ? {} : { notice }) },
  )
}

/** Guest row. */
export interface AdminGuestRow {
  readonly identity: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly totalIn: number
  readonly totalOut: number
  readonly todayIn: number
  readonly todayOut: number
}

/** The guests page. */
export function guestsPage(rows: readonly AdminGuestRow[]): string {
  const body = rows
    .map(
      (row) => `<tr>
        <td class="mono">${h(row.identity)}</td>
        <td class="muted">${h(formatTime(row.firstSeenAt))}</td>
        <td class="muted">${h(formatTime(row.lastSeenAt))}</td>
        <td>${h(formatBytes(row.totalIn + row.totalOut))}</td>
        <td>${h(formatBytes(row.todayIn + row.todayOut))}</td>
      </tr>`,
    )
    .join('')
  return layout(
    '未注册客户端',
    `<h2>未注册客户端</h2>
     <p class="muted">这些是未登录账户的安装 ID（guest）或无法识别的旧客户端（anon）。它们各自是一个唯一标识符，不与其他账户合并。</p>
     <table><thead><tr><th>标识符</th><th>首次出现</th><th>最近出现</th><th>累计流量</th><th>今日流量</th></tr></thead>
     <tbody>${body || '<tr><td colspan="5" class="muted">还没有游客流量</td></tr>'}</tbody></table>`,
    { signedIn: true },
  )
}

/** Invite row. */
export interface AdminInviteRow {
  readonly code: string
  readonly days: number
  readonly uses: number
  readonly maxUses: number
  readonly expiresAt: number | null
  readonly disabled: boolean
  readonly createdAt: number
}

/** The invites page. */
export function invitesPage(rows: readonly AdminInviteRow[], csrf: string, notice?: string): string {
  const body = rows
    .map(
      (row) => `<tr>
        <td class="mono">${h(row.code)}</td>
        <td>${row.days} 天</td>
        <td>${row.uses} / ${row.maxUses}</td>
        <td>${row.expiresAt === null ? '—' : h(formatTime(row.expiresAt))}</td>
        <td>${row.disabled ? '<span class="pill bad">已停用</span>' : '<span class="pill paid">可用</span>'}</td>
        <td class="actions">
          <form method="post" action="/admin/invites/${encodeURIComponent(row.code)}/${row.disabled ? 'enable' : 'disable'}"><input type="hidden" name="_csrf" value="${h(csrf)}"><button class="ghost" type="submit">${row.disabled ? '启用' : '停用'}</button></form>
          <form method="post" action="/admin/invites/${encodeURIComponent(row.code)}/delete"><input type="hidden" name="_csrf" value="${h(csrf)}"><button class="danger" type="submit">删除</button></form>
        </td>
      </tr>`,
    )
    .join('')
  return layout(
    '邀请码',
    `<h2>邀请码</h2>
     <form method="post" action="/admin/invites" class="stack" style="margin-bottom:20px">
       <input type="hidden" name="_csrf" value="${h(csrf)}">
       <label>自定义码（留空自动生成）<input name="code" maxlength="64" placeholder="MZ-XXXX-XXXX-XXXX"></label>
       <label>天数<input name="days" type="number" min="1" max="3650" value="30" required></label>
       <label>最大使用次数<input name="maxUses" type="number" min="1" max="1000" value="1" required></label>
       <label>过期天数（留空永不过期）<input name="expiresDays" type="number" min="1" max="3650"></label>
       <button type="submit">创建邀请码</button>
     </form>
     <table><thead><tr><th>码</th><th>天数</th><th>已用</th><th>过期</th><th>状态</th><th></th></tr></thead><tbody>${body || '<tr><td colspan="6" class="muted">还没有邀请码</td></tr>'}</tbody></table>`,
    { signedIn: true, ...(notice === undefined ? {} : { notice }) },
  )
}

/** Traffic page data. */
export interface AdminTrafficData {
  readonly todayIn: number
  readonly todayOut: number
  readonly totalIn: number
  readonly totalOut: number
  readonly identities: number
  readonly relays: ReadonlyArray<{ readonly id: string; readonly role: 0 | 1; readonly lastReportAt: number }>
  readonly rows: ReadonlyArray<{
    readonly identity: string
    readonly totalIn: number
    readonly totalOut: number
    readonly todayIn: number
    readonly todayOut: number
    readonly lastSeenAt: number
  }>
}

/** The traffic page. */
export function trafficPage(data: AdminTrafficData): string {
  const relays = data.relays
    .map(
      (relay) => `<tr><td class="mono">${h(relay.id)}</td><td>${relay.role === 1 ? '付费 (1)' : '免费 (0)'}</td><td class="muted">${h(formatTime(relay.lastReportAt))}</td></tr>`,
    )
    .join('')
  const rows = data.rows
    .map(
      (row) => `<tr><td class="mono">${h(row.identity)}</td><td>${h(formatBytes(row.todayIn + row.todayOut))}</td><td>${h(formatBytes(row.totalIn + row.totalOut))}</td><td class="muted">${h(formatTime(row.lastSeenAt))}</td></tr>`,
    )
    .join('')
  return layout(
    '流量',
    `<h2>流量</h2>
     <div class="grid">
       <div class="card"><div class="label">今日</div><div class="value">${h(formatBytes(data.todayIn + data.todayOut))}</div></div>
       <div class="card"><div class="label">累计</div><div class="value">${h(formatBytes(data.totalIn + data.totalOut))}</div></div>
       <div class="card"><div class="label">身份数</div><div class="value">${data.identities}</div></div>
     </div>
     <h2>中继</h2>
     <table><thead><tr><th>中继</th><th>角色</th><th>最近上报</th></tr></thead><tbody>${relays || '<tr><td colspan="3" class="muted">还没有上报</td></tr>'}</tbody></table>
     <h2 style="margin-top:24px">最近活跃身份</h2>
     <table><thead><tr><th>身份</th><th>今日</th><th>累计</th><th>最近</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">还没有流量</td></tr>'}</tbody></table>`,
    { signedIn: true },
  )
}

/** Settings page data. */
export interface AdminSettingsData {
  readonly role: 0 | 1
  readonly dataDir: string
  readonly publicBaseURL: string
  readonly bundleId: string
  readonly productId: string
  readonly version: string
  /** `off`, `observe` or `enforce`. */
  readonly paidGate: string
}

/** The settings page. */
export function settingsPage(data: AdminSettingsData): string {
  return layout(
    '设置',
    `<h2>设置</h2>
     <table><tbody>
       <tr><th>中继角色</th><td>${data.role === 1 ? '付费服务器 (1)' : '免费服务器 (0)'}</td></tr>
       <tr><th>数据目录</th><td class="mono">${h(data.dataDir)}</td></tr>
       <tr><th>公开地址</th><td class="mono">${h(data.publicBaseURL || '—')}</td></tr>
       <tr><th>App Bundle</th><td class="mono">${h(data.bundleId)}</td></tr>
       <tr><th>订阅 Product ID</th><td class="mono">${h(data.productId)}</td></tr>
       <tr><th>付费门禁</th><td>${
         data.paidGate === 'enforce'
           ? 'enforce（非付费账户拒绝接入）'
           : data.paidGate === 'observe'
             ? 'observe（只记录，不拦截）'
             : 'off（不校验付费状态）'
       }</td></tr>
       <tr><th>版本</th><td class="mono">${h(data.version)}</td></tr>
     </tbody></table>
     <p class="muted" style="margin-top:16px">端口、令牌、TLS 等底层配置在 <span class="mono">relay.config.json</span> 中，后台只读展示。</p>`,
    { signedIn: true },
  )
}
