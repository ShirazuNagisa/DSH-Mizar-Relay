# Deploying the DSH-Mizar relay

The relay is the third answer to "how does the phone reach the computer", after the two in
This document: a small Node service you run on a server with a public
address, which lets a computer that **cannot accept inbound connections at all** still be reachable.

This document is the operator's guide. It is written to be followed top to bottom on a fresh
server, with BaoTa Panel (宝塔面板) assumed for the web side because that is where the sharp edges
are.

> **Verified against the source, not against a server.** The relay has only ever been exercised by
> its own test suite, run locally (`npm test` in [`relay/`](../relay/)), plus the loopback runs the
> responses below were copied from. Nobody has deployed it to a real host and put a phone through
> it yet. Read this as reviewed-and-consistent-with-the-code rather than proven-in-production, and
> expect the first deployment to teach us something.

---

## 1. What this is, and why

A computer at home or in an office usually cannot be dialled from outside: consumer NAT drops unsolicited
inbound packets, and campus or corporate networks block them outright. The relay inverts the
problem. The computer opens **one outbound WebSocket** to the relay and holds it open; anything arriving
at the relay for that computer is replayed down that socket.

```text
 iPhone ──── HTTPS / WSS ────► nginx (TLS) ──► relay (127.0.0.1:8787) ──┐
                                                                       │ one outbound WSS
                                                                       │ the computer opened
 computer (plugin listener on 127.0.0.1:19390) ◄───────────────────────┘
```

The computer has no inbound port, no port forwarding, no VPN and no second network to join. It dials
`wss://mizar.example.com/tunnel` with `Authorization: Bearer <token>`, the relay derives a **room**
from that token, and the computer becomes reachable at `https://mizar.example.com/r/<room>/…`.

What the relay does and does not do:

| | |
|---|---|
| It **does** terminate a WebSocket with the computer and multiplex phone traffic over it | HTTP requests are replayed and their answers returned; phone WebSockets are bridged through |
| It **does not** understand the Mizar protocol | a request is a method, a path, headers and a body; the relay moves those and knows nothing about sessions, devices or approvals |
| It **does not** authenticate phones | the phone still pairs with the plugin's own pairing code and then speaks with a device token, over the tunnel, exactly as it would on a LAN |
| It **does** decide which computer a request reaches | and only from the token, never from anything the computer or the phone claims |

Two deliberate behaviours are worth knowing before you debug anything:

- **A room with no computer connected and a room that never existed answer the same 404.** Telling them
  apart would let anyone enumerate which computers are online.
- **A phone WebSocket is not accepted until the computer accepts it.** An unreachable computer produces an
  HTTP error rather than a socket that opens and immediately dies. The two look identical in a
  client's logs, and only one of them is diagnosable.

### The endpoints the relay serves

| Path | Who uses it | What happens |
|---|---|---|
| `/tunnel` | the computer | WebSocket upgrade, authenticated with `Authorization: Bearer <token>`; an unknown token gets `401` and a closed socket |
| `/r/<room>/…` | the phone | replayed over the tunnel; WebSocket upgrades are bridged; `404` when that room has no live tunnel |
| `/healthz` | you | `{"ok":true,"rooms":1,"inFlight":0,"version":1}` — `rooms` counts the computers currently attached (section 7) |
| `udp/<stunPort>` | peers | STUN responder (RFC 5389 binding requests): the address a peer appears from. Sized for hole punching; `0` disables |
| `udp/<probePort>` | peers | endpoint probe: any datagram gets JSON back containing the sender's public address and port |

---

## 2. Requirements

| | |
|---|---|
| **Server** | a public IPv4 address that does not change. Any small VPS is enough — a free relay stores nothing; the account relay stores JSON files under its data directory and runs the same one Node process |
| **Node** | 20 or newer, from [`relay/package.json`](../relay/package.json) `engines`. Node 24 LTS is recommended for the account relay. Check with `node --version` |
| **Domain** | one name with an `A` record pointing at the server, e.g. `mizar.example.com` |
| **TLS** | a certificate for that name. This guide uses Let's Encrypt through BaoTa; any certificate that nginx can load works |
| **Disk** | tens of megabytes for the tunnel; the account service stores JSON files under its data directory (accounts, invites, traffic) and needs a writable path |
| **Network** | inbound TCP 443 (and TCP 80 for the certificate), optionally inbound UDP 8788 for the probe |
| **On the computer** | the `dsh-mizar` plugin already installed and working, and the tunnel token in its own config (section 6) |

---

## 3. 快速开始

> 详细理由都在后面的章节里。这一节只给"从零到能用"的顺序。

1. 服务器要有**固定公网 IPv4**，域名 `mizar.example.com` 的 A 记录指向它。
2. 把仓库里的 `relay/` 整个目录传到服务器，建议放在 `/www/wwwroot/dsh-mizar-relay`。
3. 装依赖并构建（注意顺序，`tsc` 是 devDependency）：

   ```sh
   cd /www/wwwroot/dsh-mizar-relay
   npm ci                # 含编译器等开发依赖
   npm run build         # 产出 lib/
   npm ci --omit=dev     # 只留运行时依赖 ws
   ```

4. 生成隧道令牌：`openssl rand -base64 32`。**一个电脑一个令牌**，等同于"成为那台电脑"的
   凭证，不要外传、不要提交进 git。
5. 写配置：`cp relay.config.example.json relay.config.json`，把令牌填进 `tokens`，
   `chmod 600 relay.config.json`。默认 `port: 8787`、`host: 127.0.0.1`、`probePort: 8788`、`stunPort: 3478`。
6. 用 systemd 或宝塔的 **Node 项目** 跑起来，工作目录必须是该目录（配置文件是相对路径读的）。
7. 宝塔建站 → 申请 Let's Encrypt 证书 → 开 **强制 HTTPS** → 反向代理到
   `http://127.0.0.1:8787`（发送域名 `$host`）。
8. 在反向代理的配置文件里**至少**加上这几行（完整清单与逐条理由见 5.3），
   **否则 WebSocket 一定失败、隧道大约每分钟断一次**：

   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   ```

9. 安全组/防火墙放行 TCP 80、TCP 443；想要打洞探测再放行 **UDP 8788**。**绝不要**放行 8787。
10. 电脑插件配置里打开 `relay`（见第 6 节），重启 DSH，日志出现
    `relay: serving room …`，然后在面板里生成配对二维码给手机扫。
11. 验证：`curl https://mizar.example.com/healthz` 应返回
    `{"ok":true,"rooms":1,"inFlight":0,"version":1}`。

---

## 4. Step by step

### 4.1 Copy `relay/` to the server

The relay is the `relay/` directory of this repository and nothing else — it does not import the
plugin, and the plugin does not import it. Copy that one directory:

```sh
# from the repository root on the computer
rsync -av --exclude node_modules --exclude lib \
  relay/ root@203.0.113.10:/www/wwwroot/dsh-mizar-relay/
```

Two notes on what you get:

- `relay/lib/` is **git-ignored** (the plugin's `lib/` is committed, the relay's is not — see
  [.gitignore](../.gitignore)). A `git clone` therefore contains no build output; that is expected,
  and section 4.2 builds it. `rsync` above skips a local `lib/` for the same reason: shipping stale
  JavaScript from a laptop is worse than compiling on the server.
- `package-lock.json` **is** committed, which is what makes `npm ci` reproducible.

### 4.2 Install and build

```sh
cd /www/wwwroot/dsh-mizar-relay
node --version        # must print v20.x or newer
npm ci                # install everything, including the TypeScript compiler
npm run build         # tsc -p tsconfig.json  →  lib/
npm ci --omit=dev     # drop the compiler and the test runner; only ws remains
```

These are the script names exactly as declared in [`relay/package.json`](../relay/package.json):

| Script | Command | When you use it |
|---|---|---|
| `build` | `tsc -p tsconfig.json` | once per deployment; writes `lib/` |
| `start` | `node lib/index.js` | what the service runs, effectively |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | optional |
| `test` | `vitest run` | optional sanity check; needs devDependencies, so run it before the prune |

> **The order matters, and `npm ci --omit=dev` alone will not work.** The build script is `tsc`,
> and `typescript` is a **devDependency**. Prune first and `npm run build` fails with a missing
> compiler. Either build first and prune afterwards (above), or — if you would rather not install a
> compiler on the server at all — run `npm ci && npm run build` on the computer, copy `lib/`,
> `package.json` and `package-lock.json` across, and run `npm ci --omit=dev` there.
>
> `npm ci --omit=dev` deletes `node_modules` and reinstalls from the lockfile, which is why it is
> safe to run after the build: `lib/` is not inside `node_modules`. `npm prune --omit=dev` does the
> same job in place.

### 4.3 Generate the tunnel token

```sh
openssl rand -base64 32          # 44 characters, mixed case, may contain + / =
openssl rand -hex 32             # 64 characters, hex only — easier to paste into a config file
```

Either is fine. Use a separate token per computer: one token is one room, so the list is also your
inventory, and retiring a computer is deleting one line.

**A token is not a password for an account — it is the capability to *be* that computer.** Whoever holds
it can attach a process to the relay as your computer, receive every phone request, and answer as the
plugin would. That is a stronger position than holding a room id (section 9). So:

- generate it on the server, paste it into one file, and do not send it through chat, tickets or
  email;
- never commit it. `relay.config.json` is deliberately not in the repository — only
  `relay.config.example.json` is — and you should keep it that way in any deployment repo of your
  own;
- `chmod 600` the file (section 4.4), so it is unreadable to other local users.

#### Where the room comes from

You do not choose the room, and you do not configure it. The relay derives it:

```text
room = first 12 characters of Crockford base32( SHA-256( "dsh-mizar-relay/room:" + token )[0..8] )
```

The alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O` or `U`, so a room read off a
screen cannot be mistyped into a different valid one). The relay computes it and tells the computer in
its first frame; the computer never invents one, so a tunnel cannot claim a room that belongs to a
different token.

To cross-check the room for a token, on the server, from the relay directory:

```sh
node -e 'import("./lib/room.js").then(m => console.log(m.deriveRoom(process.argv[1])))' 'THE-TOKEN'
```

For the stand-in token used throughout this document that prints `GJ31NAZY4PRH`.

Two consequences worth internalising:

- The room is a **function of the token**, so the same token always yields the same room on every
  machine — and **rotating a token changes the room**. Every QR code and stored pairing against the
  old room stops working, and phones must re-pair.
- Whitespace *around* an entry is trimmed in both forms — the file's array is joined with commas and
  trimmed entry by entry, exactly like the environment list — but whitespace *inside* an entry is
  part of the token, and therefore part of the room. When a room looks wrong, suspect the token
  first.

### 4.4 Write `relay.config.json`

```sh
cd /www/wwwroot/dsh-mizar-relay
cp relay.config.example.json relay.config.json
chmod 600 relay.config.json
$EDITOR relay.config.json
```

With the token from step 4.3 (the string below is a **stand-in** — replace it with your own), the
file looks like this:

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "tokens": ["Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA"],
  "trustProxy": true,
  "maxBodyBytes": 4194304,
  "maxMessageBytes": 921600,
  "maxClientsPerRoom": 8,
  "requestTimeoutMs": 30000,
  "tunnelIdleMs": 90000,
  "probePort": 8788,
    "stunPort": 3478
}
```

Every key, its environment override and its default — the authoritative list, from
[`relay/src/config.ts`](../relay/src/config.ts):

| Key | Environment override | Default | What it does |
|---|---|---|---|
| `port` | `MIZAR_RELAY_PORT` | `8787` | TCP port for the plain-HTTP server. TLS is nginx's job, not this process's |
| `host` | `MIZAR_RELAY_HOST` | `127.0.0.1` | interface to bind. Leave it; see 5.4 |
| `tokens` | `MIZAR_RELAY_TOKENS` | `[]` — any credential is accepted | the bearer tokens a computer may present at `/tunnel`. One token = one computer = one room. Empty is the shipping mode: each plugin invents its own secret and the room is derived from it, so there is nothing to issue (see 4.3) |
| `trustProxy` | `MIZAR_RELAY_TRUST_PROXY` | `true` | whether `X-Real-IP` / `X-Forwarded-For` may name the computer the **tunnel address limit** counts. Only read when the TCP peer is loopback (the nginx deployment), so a relay exposed directly still counts the real peer. Set it to `false` if you front the relay with a proxy on another host |
| `maxBodyBytes` | `MIZAR_RELAY_MAX_BODY` | `4194304` (4 MiB) | largest body the relay carries, in either direction: a bigger request from the phone is answered `413`, a bigger answer from the computer is answered `502` |
| `maxMessageBytes` | `MIZAR_RELAY_MAX_MESSAGE` | `921600` (900 KiB) | largest single WebSocket message. Past it the bridge closes with code `1009`. Keep it under iOS's 1 MiB ceiling: exceeding that does not truncate the message, it closes the socket |
| `maxClientsPerRoom` | `MIZAR_RELAY_MAX_CLIENTS` | `8` | concurrent phone connections allowed per room. A resource guard, not authentication |
| `requestTimeoutMs` | `MIZAR_RELAY_REQUEST_TIMEOUT` | `30000` | how long a phone request waits for the computer before `502`, and how long a phone WebSocket waits for the computer to accept its upgrade before `504` |
| `tunnelIdleMs` | `MIZAR_RELAY_TUNNEL_IDLE` | `90000` | how long a tunnel may go without answering a ping before the relay drops it. The relay pings every `tunnelIdleMs / 3` (30 s at the default), never faster than 5 s |
| `maxRooms` | `MIZAR_RELAY_MAX_ROOMS` | `10000` | rooms served at once, and push rooms remembered. The only bound on either map |
| `maxTunnelsPerIp` | `MIZAR_RELAY_MAX_TUNNELS_PER_IP` | `4` | tunnels one source address may hold. A resource guard, not authentication. Behind the loopback reverse proxy the address is the client's, from `X-Real-IP` (see `trustProxy`); before 0.2.3 this counted the proxy and was effectively a global cap of four |
| `probePort` | `MIZAR_RELAY_PROBE_PORT` | `8788` | UDP port for the endpoint probe; `0` disables it |
| `stunPort` | `MIZAR_RELAY_STUN_PORT` | `3478` | UDP port for the STUN responder; `0` disables it and opens no socket at all |
| `role` | `MIZAR_RELAY_ROLE` | `0` | `0` = free relay, `1` = paid/account relay. A label used by the account service and traffic reports; it never rejects a connection |
| `accounts` | — | absent | Account service block. Only the account relay (主力1) enables it. Every field is optional; see section 11 |
| `accounts.enabled` | `MIZAR_ACCOUNTS_ENABLED` | `false` | Serve `/account/v1/*`, `/admin`, and aggregate traffic |
| `accounts.dataDir` | `MIZAR_ACCOUNTS_DATA_DIR` | `./data` | directory for accounts.json/invites.json/traffic.json/audit.log |
| `accounts.adminPasswordHash` | `MIZAR_ADMIN_PASSWORD_HASH` | — | scrypt hash printed by `lib/accounts/cli.js admin-secret`; required when enabled |
| `accounts.internalSecret` | `MIZAR_ACCOUNT_INTERNAL_SECRET` | — | shared secret for `/internal/v1/traffic` between relays |
| `accounts.reportTo` | `MIZAR_ACCOUNT_REPORT_TO` | — | free relay's account-relay origin (e.g. `https://dshmizar-1.shirazu-nagisa.com`) |
| `accounts.reportId` | `MIZAR_ACCOUNT_REPORT_ID` | — | this relay's id in traffic reports (`primary-0`/`primary-1`) |
| `accounts.gravatar.baseURLs` | `MIZAR_GRAVATAR_BASE_URLS` | official Gravatar | ordered mirrors; the account relay in China needs `https://gravatar.loli.net,https://cn.cravatar.com,https://www.gravatar.com` |
| `accounts.appstore.productId` | `MIZAR_APPSTORE_PRODUCT_ID` | `me.shirazu.dshmizar.paid.monthly` | auto-renewable subscription product id; must match App Store Connect and iOS |
| `accounts.appstore.allowSandbox` | `MIZAR_APPSTORE_ALLOW_SANDBOX` | `true` | accept Sandbox StoreKit transactions |
| `accounts.paidGate.mode` | `MIZAR_PAID_GATE` | `enforce` on a `role: 1` relay with accounts enabled, else `off` | `off` / `observe` / `enforce`. See 11.7 |
| `accounts.paidGate.allowUnaccounted` | `MIZAR_PAID_GATE_ALLOW_UNACCOUNTED` | `false` | let phones with no account at all through the paid relay |
| `accounts.paidGate.cacheTtlMs` | `MIZAR_PAID_GATE_CACHE_TTL` | `60000` | how long a verified paid entitlement is reused |
| `abuse` | — | absent (defaults apply) | data-plane meters per identity **and per source address**, plus the traffic-alert thresholds. All keys and their defaults are in 11.11 |

Rules that are easy to trip over:

- **Environment wins over the file.** A container or a unit file can override a mounted config
  without rewriting it. An **empty** value counts as *unset*, not as an empty string — that is what
  an undefined Docker variable looks like.
- In the file `tokens` is a JSON **array**; in the environment `MIZAR_RELAY_TOKENS` is a
  **comma-separated list**. Setting the environment variable replaces the file's list entirely, so
  a stale `MIZAR_RELAY_TOKENS` in a unit file will silently ignore an edit to `relay.config.json`.
- Numbers given through the environment arrive as strings and are parsed as numbers, so
  `MIZAR_RELAY_PORT=8787` behaves as written and `"probePort": 0` disables the probe. A value that is
  not a number at all is not rejected at load time: it becomes `NaN` and the process dies on start-up
  with `ERR_SOCKET_BAD_PORT` (see section 8).
- **An empty token list is a supported mode, not a failure.** The relay then accepts any credential
  of at least sixteen characters and derives the room from it, which is what makes "install the
  plugin and scan" possible: a room is sixty bits of a hash of a secret the computer generated locally, so
  knowing one room tells you nothing about any other, and a stranger who registers a room only gets
  their own. Set `tokens` when you would rather your relay served only your own computers — the check is a
  string comparison against a list, so it keeps a private relay private rather than stopping a
  determined attacker.

### 4.5 Run it under systemd

Port 8787 is above 1024, so nothing here needs root. Run the relay as its own unprivileged user:

```sh
useradd --system --home-dir /www/wwwroot/dsh-mizar-relay --shell /usr/sbin/nologin mizar-relay
chown -R mizar-relay:mizar-relay /www/wwwroot/dsh-mizar-relay
command -v node        # note the absolute path; the unit file needs it
```

Then `/etc/systemd/system/dsh-mizar-relay.service`:

```ini
[Unit]
Description=DSH-Mizar relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mizar-relay
Group=mizar-relay
WorkingDirectory=/www/wwwroot/dsh-mizar-relay
ExecStart=/usr/bin/node /www/wwwroot/dsh-mizar-relay/lib/index.js
Restart=always
RestartSec=2

# Optional. Any MIZAR_RELAY_* here overrides relay.config.json — including
# MIZAR_RELAY_TOKENS, which replaces the file's whole token list.
# Environment=MIZAR_RELAY_PORT=8787
# Environment=MIZAR_RELAY_HOST=127.0.0.1
# Environment="MIZAR_RELAY_TOKENS=Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA"
# Environment=MIZAR_RELAY_PROBE_PORT=8788

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Why each of the lines that matter:

- **`WorkingDirectory`** is not decoration. The config file is read from the path
  `relay.config.json` **relative to the process's working directory**. Start the process from
  anywhere else and it will find no file — which is legal, because everything may come from the
  environment — and then fail with "no tunnel token configured", or, worse, come up with a
  different configuration than you think.
- **`ExecStart`** points at `node` and the built entry directly rather than at `npm start`. The
  `start` script is exactly `node lib/index.js`, so the effect is the same, but this way systemd
  supervises Node itself instead of supervising npm supervising Node — one less process to signal
  on restart. Use the absolute `node` path from `command -v node`; systemd does not read your
  shell's `PATH`, and a Node installed by nvm or by BaoTa's Node manager is not in `/usr/bin`.
- **`Restart=always`** with a short `RestartSec` is what makes a relay restart invisible: the computer
  reconnects on its own with exponential backoff (section 6).
- **The `Environment=` lines** are shown quoted on purpose: base64 tokens can contain `/`, `+` and
  `=`, and quoting keeps systemd from splitting at a space. systemd performs no shell expansion
  here, so the value is taken literally.
- **If you would rather not put the secret in the unit file** (which is world-readable), move it to
  a file only root and the service user can read and point at it with
  `EnvironmentFile=/etc/dsh-mizar-relay.env` containing `MIZAR_RELAY_TOKENS=…`. Same semantics,
  different permissions.
- **`ProtectHome=true`** hides `/home`, `/root` and `/run/user`. It is fine with the install path
  used here, and wrong if you put the relay under `/root` or `/home` — drop that line in that case.

Enable and watch it:

```sh
systemctl daemon-reload
systemctl enable --now dsh-mizar-relay
systemctl status dsh-mizar-relay
journalctl -u dsh-mizar-relay -f
```

The relay logs to stdout, so journald holds everything and there is no log file to rotate.

#### Alternative: BaoTa's Node project manager

If you would rather keep it in the panel: **网站 → Node 项目 → 添加 Node 项目**, project directory
`/www/wwwroot/dsh-mizar-relay`, startup file `lib/index.js` (or the `start` script, which is the
same command), the port it listens on, and a user that can read the directory.

Two things the manager will not do for you:

- **Build.** `lib/index.js` does not exist until `npm run build` has run, and the manager starts the
  app rather than a build. Run the three commands from 4.2 in the project directory yourself, before
  you add the project.
- **Set the working directory for you.** Whatever the manager uses as the process's working
  directory is where `relay.config.json` must be. If it starts the process elsewhere, either move
  the config or override every key with `MIZAR_RELAY_*` environment variables in the project's
  settings.

Either way, verify with `curl` (section 7) rather than trusting the panel's green dot.

---

## 5. BaoTa Panel (宝塔面板)

This is the part that decides whether the deployment works. None of it is specific to BaoTa
beyond the menu names; any nginx front end needs the same six directives.

### 5.1 Site, certificate, forced HTTPS

1. **网站 → 添加站点.** Domain `mizar.example.com`. No database, no PHP — choose the "static"
   option (纯静态) and create it.
2. **站点设置 → SSL → Let's Encrypt.** Select the domain and apply. BaoTa writes the certificate,
   adds the `server` block for 443 and reloads nginx. The HTTP-01 challenge needs inbound **TCP 80**
   reachable at that moment; if the domain sits behind Cloudflare's proxy, use a DNS challenge or
   temporarily grey-cloud the record.
3. **Turn on 强制 HTTPS** (Force HTTPS) in the same panel. The certificate is not optional here:
   the tunnel token and every prompt travel through this hostname, and the relay itself speaks plain
   HTTP.

### 5.2 Reverse proxy to `http://127.0.0.1:8787`

**站点设置 → 反向代理 → 添加反向代理:**

| Field | Value |
|---|---|
| 代理名称 (name) | `mizar-relay` |
| 目标 URL (target) | `http://127.0.0.1:8787` |
| 发送域名 (Host) | `$host` |
| 缓存 (cache) | off |

Point the proxy at **`/`**, not at `/r/`. The relay serves three paths — `/healthz`, `/tunnel` and
`/r/…` — and proxying only one of them produces the worst kind of failure: the site answers on 443,
the certificate is valid, and the tunnel silently never comes up.

BaoTa keeps the generated snippet in its own file under `/www/server/panel/vhost/nginx/proxy/` and
includes it from the site's `server` block. The **配置文件** button on the reverse-proxy row opens
exactly the file you need to edit next.

### 5.3 The nginx directives that must be added

Add these inside the proxy's `location` block:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

| Directive | Why it is there |
|---|---|
| `proxy_http_version 1.1` | WebSocket upgrades exist in HTTP/1.1. nginx talks HTTP/1.0 to upstreams by default, where `Upgrade` is not a thing |
| `proxy_set_header Upgrade $http_upgrade` | forwards the client's `Upgrade: websocket` to the relay. Without it the relay never sees an upgrade request at all |
| `proxy_set_header Connection "upgrade"` | tells the relay this connection is an upgrade and not a keep-alive request. **This and the line above are a pair** — with only one of them the handshake is stripped and what the client gets back is a plain HTTP response instead of `101 Switching Protocols` |
| `proxy_set_header Host $host` | keeps the hostname the client used, rather than `127.0.0.1:8787`, in the request the computer eventually replays |
| `proxy_set_header X-Real-IP $remote_addr` | the client's real address. Two uses: on the **tunnel upgrade** it is the address `maxTunnelsPerIp` counts (otherwise every computer shares the proxy's `127.0.0.1` bucket — the relay now trusts it because the peer is loopback, see `trustProxy`); on phone requests the relay forwards it to the computer as an ordinary request header, which is the only way the computer can see who is calling — from the plugin's side the connection arrives from loopback |
| `proxy_read_timeout 3600s` | **the one people lose an evening to.** nginx's default is 60 s: a proxied socket that says nothing for 60 s is closed. The tunnel is exactly such a socket whenever it is quiet, and the symptom is a computer that reconnects roughly every minute, forever |
| `proxy_send_timeout 3600s` | the write-side equivalent, for a large answer being pushed to a slow phone |

What the two failure modes actually look like:

- **Missing `Upgrade`/`Connection`.** The computer's connection to `wss://…/tunnel` ends with a non-101
  response, so no tunnel ever registers; `/healthz` reports `"rooms":0` while answering perfectly
  over HTTPS, which is what makes this confusing. The phone's WebSocket fails the same way.
- **Short `proxy_read_timeout`.** The tunnel connects, `rooms` becomes `1`, and then it drops about
  every 60 seconds. The relay logs `relay: tunnel for room … disconnected` in a loop, the computer logs
  `relay: reconnecting in Ns`, and everything appears to work between drops. The relay pings its
  tunnel every 30 seconds, which usually keeps the computer's leg under the limit — but the phone's leg
  can be quiet for longer, a raised `tunnelIdleMs` widens the gap, and a 60-second window is far too
  close to a 30-second heartbeat to rely on.

Then:

```sh
nginx -t && nginx -s reload
```

> **A tidier variant.** Setting `Connection` to the literal `"upgrade"` means it is also sent on
> plain requests, like `/healthz` and the HTTP replay under `/r/…`. The relay strips `Connection`
> and `Upgrade` before forwarding anything to the computer, so this is tolerated. If you prefer the
> standard form, declare this once in the `http` context (for BaoTa that means the nginx main
> configuration, **not** inside the site's `server` block, where a `map` is invalid):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

> …and use `proxy_set_header Connection $connection_upgrade;` in the location instead.

> **Renewal note.** If Let's Encrypt renewal ever starts failing after this proxy is in place, check
> that `/.well-known/acme-challenge/` still resolves to files on disk rather than being proxied to
> the relay, which would answer its JSON `404` and fail the challenge.

### 5.4 Why the relay binds `127.0.0.1` only

`host` defaults to `127.0.0.1` and you should leave it there. nginx terminates TLS in front of the
relay, so the only thing that ever needs to reach the Node process is nginx, on the same machine.
The Node process speaks **plain HTTP**: no certificate, no encryption of its own.

That has two consequences:

- Exposing 8787 publicly would put the tunnel token on the wire in clear text as a bearer header,
  readable by anything between the computer and the server. TLS in front is not a nicety here; it is the
  only encryption the tunnel has.
- It would also expose `/r/<room>/…` unencrypted to the entire internet. The room is a weaker secret
  than the token (section 9), and it is not meant to be the thing standing between a stranger and
  your computer.

So: bind loopback, let nginx own 443, and **do not open 8787 in the security group or the host
firewall.** If you have a reason to bind something else — a container network, a second machine —
set `host` deliberately and put a firewall in front of it.

### 5.5 Firewall and security group

| Port | Protocol | Open? | Why |
|---|---|---|---|
| 443 | TCP | yes | phones and the computer's tunnel |
| 80 | TCP | yes | the HTTPS redirect and Let's Encrypt's HTTP-01 challenge |
| 8788 | UDP | only if you want the probe | endpoint discovery for peer-to-peer hole punching; the reply tells a peer how it looks from outside |
| 8787 | TCP | **never** | the relay's plain-HTTP port; nginx is the only client it should have |

Set this in both places that apply to you: the cloud provider's security group and the host firewall
(`ufw allow 80,443/tcp`, `ufw allow 8788/udp`) or BaoTa's own **安全** page.

The probe is the one thing that must be reachable from outside to be useful — it answers "what is my
public address and port" to whoever asks, which is the whole of STUN for this purpose — so it binds
`0.0.0.0` rather than loopback. If you do not want the endpoint discovery, set `probePort` to `0`:
the relay then opens no UDP socket at all and the firewall rule is unnecessary.

### 5.6 Rate limiting at the edge

Optional, and not a substitute for 11.11 — but on a public free relay it is the cheap half
of the defence, because it bounds a flood before it costs Node a connection. Two values matter:
concurrent connections and request rate, both per client address.

Declare the zones in the `http` context. BaoTa already defines a connection zone called `perip`
(`limit_conn_zone $binary_remote_addr zone=perip:10m;` in `nginx.conf`), so only the request-rate
zone is new. Put it in its own file that the `http` include picks up —
`/www/server/panel/vhost/nginx/mizar-limits.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=mizar_req:10m rate=30r/s;
```

Then, inside the site's `server` block (server context covers every `location`, including the ACME
challenge and `/healthz`):

```nginx
# ABUSE-GUARD-START
limit_conn perip 100;
limit_req zone=mizar_req burst=120 nodelay;
limit_conn_status 429;
limit_req_status 429;
# ABUSE-GUARD-END
```

| Directive | Why this value |
|---|---|
| `limit_conn perip 100` | one address may hold 100 concurrent connections. One computer is one tunnel, one phone is one socket, so 100 is a household with room to spare — and it is the only thing stopping one address from pinning tens of thousands of sockets |
| `limit_req ... rate=30r/s burst=120` | the relay's own address limit is 1200 requests/minute (20/s), so nginx must sit *above* it or it would become the practical ceiling for a NAT household. 30/s with a 120 burst absorbs a reconnect storm and still refuses a flood |
| `limit_*_status 429` | nginx's default is 503, which reads as "the server is down". A rate refusal is a 429, and it matches what the relay itself returns |

Verify it the honest way — from a second address, so the test does not spend the live relay's own
budget:

```sh
seq 1 200 | xargs -P 40 -I{} curl -sk --interface 127.0.0.2 https://127.0.0.1/healthz \
  -H 'Host: mizar.example.com' -o /dev/null -w '%{http_code}\n' | sort | uniq -c
#  55 429
# 145 200
```

Then watch it in production with `grep ' 429 ' /www/wwwlogs/mizar.example.com.log` and
`limit_req` / `limiting connections` in the nginx error log.

Two properties to know before deploying it:

- **It is not a bandwidth limit.** A single WebSocket carrying a large transfer is one connection and
  one request; the bytes are metered by the relay, not here (11.11). This bounds connection count
  and request rate, which is what a flood costs.
- **It lives in the vhost.** Regenerating the site's config from BaoTa (or reapplying a saved
  template) drops the `ABUSE-GUARD` block, and it fails silently — the site keeps working, just
  unprotected. The zone file survives, because BaoTa does not rewrite files it did not create.

---

## 6. Configuring the computer plugin

The computer side needs the relay's URL and the very same token. The plugin's `relay` block lives in the
DSH profile configuration — the row's `config`, which belongs to the profile's own patch layer
(`~/.dsh/profiles/<profile>/cordis.patch.yml`); the row itself is inserted by the plugin's bundle
patch, so two profiles can configure Mizar independently. Confirm what actually took effect with:

```sh
dsh --profile <profile> --dump-config | grep -A 10 mizar
```

A worked example:

```yaml
# the mizar row's config
relay:
  enabled: true
  url: https://mizar.example.com
  token: Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA
  publicUrl: ''
  preferLoopback: true
  reconnectBaseMs: 1000
  reconnectMaxMs: 60000
```

| Key | Default | What it means |
|---|---|---|
| `enabled` | `false` | off by default on purpose: turning it on means one machine's agent traffic flows through another machine. The tunnel only starts when this is `true` **and** `url` and `token` are both non-empty; otherwise the plugin logs `relay: enabled but url or token is empty — not connecting` |
| `url` | `''` | the relay's base URL, e.g. `https://mizar.example.com`. `https://` and `wss://` are both accepted — the client translates to `wss://` for the tunnel — so the value you copy out of a browser works as-is |
| `token` | `''` | the tunnel token, exactly the string in the relay's `tokens` list. It is sent as `Authorization: Bearer …` on the tunnel upgrade and never appears in a QR code |
| `publicUrl` | `''` | the base URL a **phone** should be given, when it differs from `url`. Empty means "the same host as `url`" |
| `preferLoopback` | `true` | while the tunnel is up, bind only `127.0.0.1` instead of the configured bind mode. With a tunnel the phone never needs to reach the computer directly, so the listener stops exporting itself onto whatever network the computer is on |
| `reconnectBaseMs` | `1000` | first reconnect delay after the tunnel drops; doubles, with jitter, up to the cap |
| `reconnectMaxMs` | `60000` | longest reconnect delay |

### `publicUrl`, and when you need it

`publicUrl` exists for one situation: **the computer reaches the relay by a different address than the
phone does.** A computer sitting on the same LAN as the relay can dial it privately, while phones on
mobile data cannot:

```yaml
relay:
  enabled: true
  url: http://192.168.1.10:8787        # the computer's path to the relay, over the LAN
  token: Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA
  publicUrl: https://mizar.example.com # what the QR code must carry for phones
```

With `publicUrl` empty, the phone is given the relay URL itself, with the scheme a phone needs
(`https` when `url` is `https` or `wss`, otherwise `http`). The room is derived from the token, not
from either URL, so both addresses lead to the same room. Note the trade-off in the example above:
the computer-to-relay leg is then plain `ws://` across the LAN, which is fine inside a trusted network and
not fine anywhere else — if it bothers you, point `url` at the public hostname too and keep the whole
path inside TLS.

### Sequence, and what the computer logs

1. Set `relay.enabled: true` with `url` and `token`, then **restart DSH** — the listener's bind mode
   and the tunnel are both decided at start-up.
2. Watch the DSH log for:

   ```text
   relay enabled: binding loopback instead of lan
   relay: connected to wss://mizar.example.com/tunnel
   relay: serving room GJ31NAZY4PRH (protocol 1, this build speaks 1)
   relay: phones should pair against https://mizar.example.com/r/GJ31NAZY4PRH
   ```

3. **Only now issue the pairing code.** The QR code's relay entry is the room, and the room is not
   known until the relay's welcome frame arrives. Generate the code before the tunnel is up and the
   QR has no relay address to carry — and with `preferLoopback` on, the only direct address is
   loopback, which is deliberately left out of a QR because a phone cannot reach it. The result is no
   QR at all, rather than one that scans and then fails.

The phone is then authenticated the same way it would be on a LAN: it pairs with a live, single-use
code, is issued a device token, and speaks the ordinary Mizar protocol at
`https://mizar.example.com/r/GJ31NAZY4PRH/mizar/v1/…`. Nothing about pairing, device tokens or
revocation changes because a relay is in the middle.

---

## 7. Verification

### The health endpoint

From the server, bypassing nginx and then through it:

```sh
curl -sS http://127.0.0.1:8787/healthz
curl -sS https://mizar.example.com/healthz
```

A healthy relay answers, with `content-type: application/json` and `cache-control: no-store`:

```json
{"ok":true,"rooms":1,"inFlight":0,"pushDevices":1,"push":true,"fcm":false,"version":1,
 "role":0,"accounts":false,"paidGate":"off","paidGateAllowUnaccounted":false,
 "gateEnforced":false,
 "quota":{"entries":34,"refusedRate":10,"refusedBudget":0,
          "ip":{"entries":31,"refusedRate":0,"refusedBudget":0}},
 "anomalies":0,"mail":{"role":"client"}}
```

The first four are the tunnel itself; everything after them is diagnostics that a
monitor can read without parsing the config. The body only ever grows — a field
is never repurposed — so a check written against an older relay keeps working.

| Field | Meaning |
|---|---|
| `ok` | the process is up and answering |
| `rooms` | how many computers currently have a tunnel attached. `0` with the computer's plugin enabled means the tunnel never established — the token, or the nginx directives in 5.3 |
| `inFlight` | phone requests and WebSocket streams waiting on a computer right now. A number that stays above zero while nothing is happening means a stuck computer or a stalled tunnel |
| `version` | the tunnel protocol version, `1`. It must match what the computer logs as "this build speaks" |
| `pushDevices`, `push`, `fcm` | registered push devices and whether this relay can reach APNs / FCM. See 10.4 |
| `role`, `accounts` | the configured relay role and whether the account service is served |
| `paidGate`, `paidGateAllowUnaccounted`, `gateEnforced` | the paywall's state. `gateEnforced` is the single boolean that is true only when the gate both enforces **and** lets no unaccounted caller through. See 11.7 |
| `quota` | the data-plane meters: `entries` is how many identities are being metered, `refusedRate` / `refusedBudget` count refusals by reason since start-up. `quota.ip` is the same three numbers for the **address** meter, which is what catches a caller rotating a self-reported identity — see 11.11 |
| `anomalies` | traffic anomalies the ledger has recorded (its last 200, all identities), so abuse can be alerted on without reading logs. On a free relay these are `guest:`/`anon:` callers, and this count plus `quota.ip` is the entire response — see 11.11 |
| `mail` | `null` when this relay neither sends nor asks the other one to; `{"role":"client"}` on a free relay reporting through 主力1; otherwise the mail service's queue and last error |

If the second command returns nginx's HTML error page instead of that JSON, nginx is not reaching
the relay: check that the proxy covers `/` and that `systemctl status dsh-mizar-relay` is happy.

### That the routing actually reaches Node

A plain `GET /tunnel` (no upgrade, no token) is not a tunnel handshake, so the relay answers its own
JSON `404`:

```sh
curl -i https://mizar.example.com/tunnel
# HTTP/1.1 404 Not Found
# content-type: application/json; charset=utf-8
# {"error":"not found"}
```

The useful part is the *shape* of the 404: JSON from the relay proves nginx forwarded the request,
while nginx's own HTML 404 proves it did not. The same trick works for a room:

```sh
curl -sS https://mizar.example.com/r/GJ31NAZY4PRH/mizar/v1/hello
```

With the computer connected this is the plugin's unauthenticated identity probe and answers
`200` with something like
`{"hostId":"…","hostName":"…","protocolVersion":1,"pairingOpen":false,"paired":true}`. With the computer
offline it is the relay's `404 {"error":"not found"}` — the same answer as a room that never
existed, by design.

### What the relay logs

On start-up, three lines (the third only when the probe is enabled):

```text
relay: listening on 127.0.0.1:8787
relay: serving 1 room(s)
relay: endpoint probe on udp/8788
```

Then, as things happen:

| Line | Meaning |
|---|---|
| `relay: tunnel for room <room> connected` | a computer authenticated and attached |
| `relay: tunnel for room <room> connected (replaced a stale one)` | the same computer reconnected before its old socket was noticed — normal after a network blip |
| `relay: tunnel for room <room> disconnected` | the tunnel closed. Repeating roughly every minute is the nginx timeout in 5.3 |
| `relay: tunnel refused — unknown token` | a computer presented a token that is not in the list |
| `relay: tunnel for room <room> stopped answering; dropping it` | no pong inside `tunnelIdleMs`; the relay is not routing to a half-open socket any more |
| `relay: stream refused for room <room>: <reason>` | a phone WebSocket the computer would not accept |
| `relay: probe socket error: <message>` | the UDP probe failed to bind — usually another process on 8788 |
| `relay: SIGTERM, shutting down` | systemd asked it to stop; it closes tunnels and exits `0` |

### The panel, and the computer's own view

The plugin's status payload carries a `relay` object:

```json
{"enabled":true,"connected":true,"room":"GJ31NAZY4PRH","pairBaseURL":"https://mizar.example.com/r/GJ31NAZY4PRH","lastError":null}
```

`connected` and `pairBaseURL` are separate on purpose: a relay that is enabled but unreachable is the
state you most need to distinguish from "no relay configured" — in the first case phones that used to
work have stopped, in the second they never would have. The bundled panel UI renders binding, the
pairing QR and the device roster; the relay fields are in the same payload
(`/api/mizar.status`) and the same facts appear in the DSH log lines quoted in section 6. The device
roster is still the authoritative answer to "who has access", relay or no relay.

> Nothing in this section has been run against a real server. The response bodies were reproduced by
> running the built relay on loopback, which exercises the code paths but not TLS, nginx, DNS or
> firewalls.

---

## 8. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| The computer's tunnel is refused with `401`, relay logs `tunnel refused — unknown token` | the computer's `relay.token` is not byte-for-byte one of the relay's `tokens` | compare the two strings; watch for a trailing newline from a copy-paste, a smart quote, or a token that was rotated on one side only. Check whether `MIZAR_RELAY_TOKENS` is set in the unit file — it **replaces** the file's list, so editing `relay.config.json` then has no effect |
| `/r/<room>/…` answers `404 {"error":"not found"}` even though the QR code scanned | the room in the URL is not the room the token derives (typo, whitespace in the token, or the token was rotated), **or** the computer is simply offline. The relay deliberately does not distinguish these | check `rooms` in `/healthz`: `1` means a computer is attached and the room is wrong; `0` means no computer is attached. Cross-check the room with the `deriveRoom` one-liner in 4.3, and re-issue the QR code after the tunnel is up |
| `/r/<room>/…` answers `502 {"error":"the computer did not answer","detail":…}` | the tunnel is up but the plugin's local listener did not answer — DSH restarting, listener not bound, or the tunnel congested | read the computer's DSH log; the plugin reports the local failure reason itself. A `504` here instead means the request outlived `requestTimeoutMs` |
| The phone's WebSocket fails to connect, or opens and dies instantly; the computer's tunnel never establishes | nginx is not upgrading the connection — `proxy_http_version 1.1` and the `Upgrade`/`Connection` pair are missing or only half present | add all three lines from 5.3 to the proxy location, `nginx -t`, `nginx -s reload`. Confirm with `/healthz`: `rooms` stays `0` while HTTPS itself works fine |
| The tunnel drops and reconnects about once a minute | nginx's default 60-second `proxy_read_timeout` closed a quiet socket | set `proxy_read_timeout 3600s` (and `proxy_send_timeout 3600s`), reload nginx. The relay log showing `tunnel for room … disconnected` on that rhythm is the confirmation |
| `curl /healthz` works on 443 but the tunnel never comes up, and the computer logs `relay: reconnecting in Ns` | as above, or the token is wrong, or `relay.enabled` is true while `url`/`token` is empty | check the computer's log for `relay: enabled but url or token is empty — not connecting`, and compare tokens |
| The endpoint probe gets no answer | inbound UDP 8788 is blocked (cloud security group, host firewall), or `probePort` is `0` | open UDP 8788 in both places, or set `probePort: 0` and stop expecting a reply |
| `413 {"error":"request body too large"}` | the request body exceeded `maxBodyBytes` | raise `maxBodyBytes` if the payload is legitimate |
| The relay exits `1` on start with "no tunnel token configured" | `tokens` is empty, or the process is running somewhere the config file is not, or `MIZAR_RELAY_TOKENS` is set to an empty string | check `WorkingDirectory`, then the file, then the environment |
| The relay crash-loops with `RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536` | a numeric setting came from the environment as a non-number, e.g. `MIZAR_RELAY_PORT=8787a`, so it parsed to `NaN`. Numbers are not validated at load time | fix or remove the offending `MIZAR_RELAY_*` variable — `systemctl show -p Environment dsh-mizar-relay` prints what systemd is actually passing |
| Requests to `https://mizar.example.com/healthz` return nginx's HTML page | the reverse proxy does not cover `/` — only some path under it | point the proxy at `/`; the relay serves `/healthz`, `/tunnel` and `/r/…` from one port |
| Everything works, then stops after a certificate renewal | the renewed config was reloaded without the proxy directives, or the ACME path is proxied to the relay | re-check 5.3 in the current config file; confirm `/.well-known/acme-challenge/` is served from disk |

Two logs answer almost every question here, and reading them together is faster than guessing:

```sh
journalctl -u dsh-mizar-relay -f          # the relay's view
tail -f /www/wwwlogs/mizar.example.com.log # nginx's view (BaoTa's log directory)
```

The relay log says whether a computer attached and with which room; the nginx log says whether the request
even arrived, and with what status.

---

## 9. Security notes

Stated plainly, without alarmism, because these are properties of the design rather than defects.

**The relay terminates TLS, so whoever runs it can read everything in transit.** Requests, prompts,
session content and the agent's answers pass through the Node process as plaintext on the loopback
side of nginx. The relay does not *interpret* any of it — it has no idea what a session is, and it
never parses a Mizar frame — but "does not interpret" is not "cannot read". When you run the relay
yourself, on your own server, that is usually exactly what you want: you are the one person who
already has access to the computer. It is *not* fine to hand the relay to somebody else and assume the
tunnel protects you. That is why end-to-end encryption between the phone and the plugin is listed as
future work: with the tunnel as it exists today there is nowhere for it to live, because the relay is
a TLS terminator on the path.

**The room id is a weaker secret than the token, and it travels.** The room appears in a QR code, in
the phone's stored pairing, and in nginx's access log — all places a token must never appear. Knowing
a room lets a stranger reach the plugin's two unauthenticated endpoints, `/mizar/v1/hello` and
`/mizar/v1/pair`; `/pair` still demands a live, single-use code and is rate limited, so a room leak
is survivable. A token leak is not: it lets somebody *be* your computer, receive every phone request and
answer as the plugin would. That asymmetry is the reason tokens live in exactly two configuration
files and rooms are allowed to travel in QR codes.

**The phone is still authenticated by the plugin, not by the relay.** The relay has no user accounts
and no concept of a device; it cannot grant a phone anything. Pairing codes expire (five minutes by
default), are single-use and rate limited, and the device tokens they issue are individually
revocable — revocation disconnects that device immediately. None of that changes because traffic
arrives through a tunnel, and none of it can be bypassed by reaching the relay.

**Practical hardening, in the order it matters:**

- Keep `host` at `127.0.0.1` and 8787 closed to the internet (5.4). Plain HTTP on a public port puts
  the token on the wire in clear text.
- `chmod 600 relay.config.json`, and do not commit it. One token per computer, so revoking a computer is
  deleting one entry and restarting.
- If others can read the unit file, keep the token out of it and use a root-only `EnvironmentFile`.
- Treat a screenshot of the pairing QR as a room disclosure; re-issue the code afterwards rather than
  leaving a live one on screen.
- Keep Node patched — the relay's dependency footprint is one package (`ws`), which is the whole
  reason it is easy to keep current.
- The size and concurrency caps (`maxBodyBytes`, `maxMessageBytes`, `maxClientsPerRoom`,
  `requestTimeoutMs`, `tunnelIdleMs`) are resource guards rather than security controls. They are the
  difference between a stuck phone costing one socket and a stuck phone costing the process.
- Finally: the room derivation means a rotated token changes the room. When you retire a token,
  remember that phones paired against the old room must re-pair — and that anything holding the old
  token can no longer attach.

---

## 10. Push notifications

The relay is the only machine in this system that can reach Apple, so it is the only machine that
can send a notification. The plugin does not have — and must not have — the signing key: a key that
ships inside a plugin installed from a public registry is not a key, it is a public string.

The plugin tells the relay *what happened*; the relay decides nothing. Its judgement stays where the
evidence is, on the computer.

### 10.1 Making the key

In the Apple developer portal:

1. **Keys → +**, name it anything, tick **Apple Push Notifications service (APNs)**, continue,
   register, download the `.p8`. **It can only be downloaded once.**
2. Note the **Key ID** (10 characters) it shows and your **Team ID** (top right of the portal).
3. The **topic** is the app's bundle id: `me.shirazu.dshmizar`.

The key file is text. Copy its whole contents, including the `-----BEGIN PRIVATE KEY-----` lines.

### 10.2 Configuring the relay

Add an `apns` object to `relay.config.json` (see `relay/relay.config.example.json`), or set the
environment instead — the environment wins, and a container usually wants it:

| file key | environment | meaning |
|---|---|---|
| `key` | `MIZAR_APNS_KEY` | the `.p8` contents; `\n` is unescaped for you |
| — | `MIZAR_APNS_KEY_FILE` | or a path to the `.p8`, instead of inline |
| `keyId` | `MIZAR_APNS_KEY_ID` | the 10-character key id |
| `teamId` | `MIZAR_APNS_TEAM_ID` | the 10-character team id |
| `topic` | `MIZAR_APNS_TOPIC` | the app's bundle id |
| `production` | `MIZAR_APNS_ENV` | kept for config compatibility, no longer used for routing — see below |
| `timeSensitive` | `MIZAR_APNS_TIME_SENSITIVE` | `1` to ask iOS to break through Focus |

**Which APNs service to use is decided per device, not per relay.** Apple runs two completely
separate push services and they do not accept each other's device tokens: a token minted by a debug
build only works against `api.sandbox.push.apple.com`, and sending it to production earns
`BadDeviceToken` — which says nothing about the real mistake.

Which one a phone needs is a fact the *phone* has and a server cannot infer, so the app reports it
with its registration and the relay routes each notification to the host that device's token belongs
to. One relay therefore serves a computer with a TestFlight phone and an Xcode phone on it at the same
time, with nothing to configure. `MIZAR_APNS_ENV` is kept so existing config files keep loading, and
leaving it set either way changes nothing.

**`timeSensitive` is off by default** because it is only honoured when the app carries the
time-sensitive-notifications entitlement, and asking for a capability an app was not provisioned for
is not a decision the relay should make on an operator's behalf.

Leave the whole `apns` object out and everything else still works: the plugin is told that push is
unavailable, logs it once, and keeps serving sessions. A relay that refuses to boot because a
notification key is missing would take the tunnel down with it, and the tunnel is the part that
matters.

### 10.3 Serving Android phones (FCM)

An Android phone registers a **different kind of token**, and it is not hex: it is a long opaque
string with `:` `-` and `_` in it. The relay learns which service a token belongs to from the
`platform` each app sends with its registration — never from the token's shape — and sends each
device to its own service. The two halves are configured separately and neither needs the other: a
relay with only `apns` serves iPhones and reports `push: true, fcm: false`, one with only `fcm`
serves Androids, and one with both serves a room that holds both.

**1. Make a service account.** In the Firebase console: **Project settings → Service accounts →
Generate new private key**. It downloads one JSON file, and that file is the credential — keep it
out of the repository. Its `project_id`, `client_email` and `private_key` are the three things the
relay needs; it mints a short-lived OAuth2 access token from them, so nothing else has to be
rotated or pasted anywhere.

**2. Configure it** — either point the relay at that file, or give it the fields:

| file key | environment | meaning |
|---|---|---|
| `serviceAccount` | `MIZAR_FCM_SERVICE_ACCOUNT` | the whole service-account JSON, inline |
| `serviceAccountFile` | `MIZAR_FCM_SERVICE_ACCOUNT_FILE` | or a path to the downloaded JSON |
| `projectId` | `MIZAR_FCM_PROJECT_ID` | the Firebase project; overrides the service account |
| `clientEmail` | `MIZAR_FCM_CLIENT_EMAIL` | the service account's address |
| `privateKey` | `MIZAR_FCM_PRIVATE_KEY` | the PEM; `\n` is unescaped for you |
| `channelId` | `MIZAR_FCM_CHANNEL_ID` | the Android notification channel the app created |
| `authority` | `MIZAR_FCM_AUTHORITY` | tests only: overrides Google's two origins |

The individual fields win over the service account, and the environment wins over both — the same
rule the rest of this file follows. Set `channelId` if the app creates one: Android 8 and later
**silently drop** a notification whose channel id does not exist, which looks exactly like a relay
that is not sending at all. The Android client in `DSH-Mizar-Android` creates one called
`mizar-alerts`; either set `channelId` to that value or omit it and let the app's default channel
apply.

**`environment` is an iOS field.** FCM has one service, so an Android device has no APNs environment
to report: the app sends `{token, platform: 'android', locale}` and the relay records none for it
(`"environment": null` in the status answer below). `platform` is optional and means `ios` when
absent, which is what every app build that predates the field sends — an iPhone keeps registering
unchanged, and `MIZAR_APNS_ENV` keeps its old meaning of doing nothing.

**A relay that cannot reach a platform still serves the other one.** A room with an Android phone and
no `fcm` configured delivers to the iPhones and counts the Android device as failed, with one line in
the log naming the missing credential — not one per device, and never a failed notification for the
phones that could be reached.

**A room's registrations still live in memory.** Nothing about FCM changes that: see 10.6. The computer
re-announces every token on every reconnect, so a relay restart — or a config change, which is also a
restart — re-registers both platforms with nobody touching a phone.

### 10.4 Checking it

```sh
curl -s localhost:8787/healthz
# {"ok":true,"rooms":1,"inFlight":0,"pushDevices":1,"push":true,"fcm":false,"version":1}
```

`push: true` means a credential is loaded — it stays the either-or flag an existing grep already
looks for, so it did not change meaning when FCM arrived — and `fcm` says whether the Google half is
the one. With `push: true, fcm: false` it is the APNs half. `pushDevices` counts the phones currently
registered. And per room, with the computer's own tunnel credential:

```sh
curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/push/v1/status
# {"ok":true,"devices":[{"deviceId":"…","platform":"ios","environment":"sandbox","locale":"zh-Hans","registeredAt":…}],"enabled":true}
```

Device tokens are deliberately **not** in that answer: a diagnostic that leaks credentials is not a
diagnostic.

The `environment` reported per device is the one its token belongs to, and it is what the relay
routes that device's notifications through. It is `null` on Android, where there is nothing to route.

A phone appears in `pushDevices` only after its app has been granted permission and told the computer
about it — which happens on the launch *after* the operator taps Allow. If the count is zero, the
permission was refused or the app has not been opened since. Revoking a device from the panel removes
it here as well, so a phone the operator has just removed stops being woken immediately rather than at
the next relay restart.

**Verifying the Android leg.** `selftest.js` proves the tunnel and does not know about push, so this
is the same pattern applied to FCM: a throwaway check run on the server, from the directory that
holds `relay.config.json` (the bundle is ESM, so a `.js` file there is a module, exactly as
`selftest.js` notes):

```js
// fcm-check.js — /www/server/nodejs/<version>/bin/node fcm-check.js
import fs from 'node:fs'
const config = JSON.parse(fs.readFileSync('relay.config.json', 'utf8'))
const base = `http://127.0.0.1:${config.port}`
// An empty `tokens` list (the default, open-registration mode) accepts any credential of
// sixteen characters or more. If this relay has a token list, put one of its entries here.
const credential = config.tokens[0] ?? 'fcm-check-credential-000000'
const auth = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }
const post = async (path, body) =>
  (await fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json()
const check = (what, ok, detail) =>
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` — ${detail}`}`)

const health = await (await fetch(`${base}/healthz`)).json()
check('a service account is loaded', health.fcm === true, JSON.stringify(health))

// A token Google has never seen. It is refused as unregistered, which is the
// answer that proves the assertion, the token exchange and the send all work.
await post('/push/v1/register', { deviceId: 'fcm-check', token: 'fcm-check-token', platform: 'android' })
const outcome = await post('/push/v1/notify', { kind: 'approval', title: 'fcm check', body: 'probe' })
check('FCM answers for an unknown token', outcome.dropped === 1, JSON.stringify(outcome))
await post('/push/v1/unregister', { deviceId: 'fcm-check' })
```

Read the relay's log for the line that came with it. `dropped: 1` is the answer you want, and means
the whole path works — the assertion was signed, Google traded it for an access token, the message was
sent and the answer was understood. The log line names which refusal it was: `404 UNREGISTERED` for a
token of the right shape that belongs to nobody, `400 INVALID_ARGUMENT` for one Google cannot parse at
all. A real phone token is then the only difference.

The other answers mean something else, and none of them is a working deployment. `403
SENDER_ID_MISMATCH` is the installed app having been built against a different Firebase project than
the service account. `failed: 1` with `THIRD_PARTY_AUTH_ERROR` is Google refusing the access token it
minted — usually a service account that is not authorised for Cloud Messaging in that project. A
`429` or a `5xx` is Google being busy, and the token is kept for the next attempt. And `fcm: false` on
the first check means the credential was not readable at all: the relay deliberately does not fail
over that, so the config file is where to look.

### 10.5 What gets sent

Three things, and the list is deliberately short — a notification that arrives for everything is one
nobody reads.

| when | tile | priority |
|---|---|---|
| an agent is blocked on a **permission prompt** | 需要你的许可 / Permission needed | 10, immediate |
| an agent is blocked on a **question** | 模型有问题要问你 / The model has a question | 10, immediate |
| a session **stopped working** | 任务完成 / 任务出错 / 任务已停止 | 5, may be batched |

The third one waits **15 seconds of silence** before it is sent. DSH does not emit one turn per
instruction: measured on a real session, the log holds long runs of consecutive `turn/start` with no
`user/message` between them, because the agent kept working after the turn that answered the prompt
had ended. Announcing every `turn/end` would be three notifications for one instruction — and
teaching somebody to ignore all of them.

The tile says what *happened*, not merely that something did: a turn that ended in `error`,
`aborted`, `blocked`, `max-tokens` or `interrupted` is reported as failed or stopped. Telling an
operator their agent finished when it stopped on an error is worse than saying nothing.

**A notification is not sent to a phone whose app is on screen.** The app reports where it is, and
the plugin hands that down as a list of devices to leave out — so a second phone that is *not* being
looked at still receives everything. (It was one global flag first, and an iPad left open on a session
then silenced the iPhone in somebody's pocket — which is precisely the notification that matters.)

**A Live Activity ends when the session does, even if nobody opens the app.** The Dynamic Island
timer is not a notification and does not expire on its own, so an alert alone left it counting after
the session had finished. The phone therefore reports its *activity* push token with its registration
(`liveActivityToken`), and the plugin sets `endLiveActivity: true` on the notification that reports
the session finished. The relay sends one `liveactivity` push to each iPhone that holds a token, even
to a phone whose app is on screen — that is exactly where a stale timer is visible — and the activity
token is tracked apart from the alert token: when Apple retires one, the relay forgets only that
token and the phone keeps receiving notifications.

### 10.6 Restarts, push registrations, and why there is no database

Push registrations live in memory. A room's tokens are a cache of what the computer already knows, and the computer
re-announces all of them every time its tunnel reconnects — which is exactly what happens when this
process restarts. Persisting them here would be a second copy of a fact that has an owner, and a
relay that came back with stale tokens would have nothing to correct them with.

Account data is the exception: `accounts.json`, `invites.json`, and `traffic.json` live in the
account relay's `data/` directory and are reloaded on start. That is why the systemd unit grants
exactly that directory write access. It is still a file, not a database: one process, serialized
writes, and a copy that can be backed up with `cp`.

A token Apple reports as retired — `410 Unregistered`, or `BadDeviceToken` — is dropped on the spot.
So is one Google reports as `404 UNREGISTERED`, or as belonging to another project
(`SENDER_ID_MISMATCH`). Retrying either forever turns a misconfiguration into a permanent stream of
failed requests.

---

## 11. Accounts, App Store subscription, admin WebUI, and relay roles

This section is only for the account relay (主力1). The free relay (主力0) keeps
`accounts.enabled=false`, stores no user data, and reports traffic to 主力1.

### 11.1 Roles

- `"role": 0` — free relay. Carries free/guest traffic and reports counters.
- `"role": 1` — paid/account relay. Serves `/account/v1/*`, `/admin`, and the
  aggregated traffic views. Also carries whatever tunnels connect to it.
- Role is **not** an authorization check on tunnels: a paid account may still use
  a free relay, and any computer may still open a tunnel to the paid one. What
  role 1 does gate, by default, is the phone leg — see 11.7. The value itself is
  a label and an accounting dimension; the gate is a separate setting that
  happens to default on for role 1.

### 11.2 Node and the bundle

The account relay needs Node 20+; Node 24 LTS is recommended. The bundle is
self-contained (built `lib/`, `node_modules/ws`, installer), so the server never
runs `npm install` or TypeScript.

```sh
# on the computer, in the repository
cd dsh-relay
npm run pack

# on 主力1
scp release/dsh-relay/dsh-mizar-relay-<version>.tar.gz root@124.220.194.121:/tmp/
ssh root@124.220.194.121
mkdir -p /www/wwwroot/dsh-mizar-relay
tar -xzf /tmp/dsh-mizar-relay-<version>.tar.gz -C /www/wwwroot/dsh-mizar-relay --strip-components=1
cd /www/wwwroot/dsh-mizar-relay
sudo MIZAR_ROLE=1 ./install.sh
```

The installer:

- finds Node (PATH, `/www/server/nodejs/*/bin/node`, common locations, nvm);
- copies the server without touching an existing `relay.config.json`;
- creates `/www/wwwroot/dsh-mizar-relay/data` mode 700 and grants the systemd
  unit `ReadWritePaths` to it;
- for a fresh role=1 config, generates an admin password/hash, an internal report
  secret, sets role=1, enables accounts, and prints the admin password **once**;
- for role=0, sets role=0, accounts off, and optionally the report target.

A re-run keeps the existing config. To enable accounts on an existing install:

```sh
NODE=/www/server/nodejs/v24.22.0/bin/node
SECRET_JSON="$($NODE lib/accounts/cli.js admin-secret)"
# capture .password and .hash from the JSON, then:
$NODE lib/accounts/cli.js configure \
  --config relay.config.json --role 1 --enable-accounts \
  --data-dir ./data \
  --admin-password-hash '<hash>' \
  --internal-secret '<shared secret>' \
  --report-id primary-1 \
  --public-base-url https://dshmizar-1.shirazu-nagisa.com \
  --product-id me.shirazu.dshmizar.paid.monthly \
  --gravatar-base-urls https://gravatar.loli.net,https://cn.cravatar.com,https://www.gravatar.com
```

### 11.3 nginx and TLS for the account relay

The account domain must have a valid certificate; the app uses HTTPS and the
App Store notification endpoint uses HTTPS. The relay still binds loopback.

1. Create the webroot:

   ```sh
   mkdir -p /www/wwwroot/dshmizar-1.shirazu-nagisa.com/.well-known/acme-challenge
   ```

2. Add a site config at
   `/www/server/panel/vhost/nginx/dshmizar-1.shirazu-nagisa.com.conf`:

   ```nginx
   server {
     listen 80;
     server_name dshmizar-1.shirazu-nagisa.com;
     root /www/wwwroot/dshmizar-1.shirazu-nagisa.com;
     location /.well-known/acme-challenge/ { try_files $uri =404; }
     location / { return 301 https://$host$request_uri; }
   }

   server {
     listen 443 ssl;
     http2 on;
     server_name dshmizar-1.shirazu-nagisa.com;
     ssl_certificate     /etc/letsencrypt/live/dshmizar-1.shirazu-nagisa.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/dshmizar-1.shirazu-nagisa.com/privkey.pem;

     client_max_body_size 2m;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
     proxy_set_header X-Real-IP $remote_addr;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_read_timeout 3600s;
     proxy_send_timeout 3600s;
     proxy_buffering off;

     location / { proxy_pass http://127.0.0.1:8787; }
   }
   ```

3. Install certbot and issue the certificate:

   ```sh
   dnf install -y certbot
   certbot certonly --webroot -w /www/wwwroot/dshmizar-1.shirazu-nagisa.com \
     -d dshmizar-1.shirazu-nagisa.com --agree-tos --register-unsafely-without-email
   certbot renew --quiet && nginx -s reload   # add to cron/systemd timer
   nginx -t && nginx -s reload
   ```

4. Verify:

   ```sh
   curl -fsS https://dshmizar-1.shirazu-nagisa.com/healthz
   # {"ok":true,...,"role":1,"accounts":true}
   ```

5. Open `https://dshmizar-1.shirazu-nagisa.com/admin` and log in with the
   printed admin password. Create the first invite code there.

Do **not** open 8787 in the firewall/security group; only nginx should reach it.

### 11.4 App Store subscription

The paid account is an auto-renewable subscription, one month, price set in App
Store Connect (¥6.00/month for China). The app uses StoreKit 2 and shows Apple's
purchase sheet; the server verifies Apple's JWS instead of trusting the client.

Server verification:

- Apple Root CA G2/G3 are embedded and used to verify the `x5c` certificate
  chain in every StoreKit transaction and App Store Server Notification V2.
- The transaction must match:
  - `bundleId`: `accounts.appstore.bundleId`
  - `productId`: `accounts.appstore.productId`
  - `type`: `Auto-Renewable Subscription`
  - `environment`: `Production` or `Sandbox` (if allowed)
  - `appAccountToken`: the account's UUID
- The first transaction for an `originalTransactionId` binds it to that account.
  A second account claiming it is refused (`APPSTORE_ACCOUNT_MISMATCH`).
- Renewals extend the App Store entitlement; refunds/revocations clear it. The
  manual/invite entitlement is separate, so a refund only removes what Apple
  sold. The effective paid state is the later of the two.
- App Store Server Notifications V2 URL:
  `https://dshmizar-1.shirazu-nagisa.com/account/v1/appstore/notifications`
  (configure both Production and Sandbox in App Store Connect).

App Store Connect checklist (operator):

1. Complete Paid Apps agreement, tax, and banking.
2. Create subscription group `DSH-Mizar 付费账户`.
3. Add auto-renewable subscription:
   - Product ID: `me.shirazu.dshmizar.paid.monthly`
   - Duration: 1 month
   - Price: ¥6.00 (China; the app displays `product.displayPrice`, never a
     hard-coded price)
   - Localizations, review screenshot, availability.
4. Attach the subscription to the app version under review.
5. Add Sandbox testers; verify purchase, restore, renewal, cancel, and refund
   on a real device.
6. Add the server notification URL (production and sandbox).
7. Provide a demo account in App Store review notes and a privacy policy URL.

The app's `Product ID` constant, the relay's
`accounts.appstore.productId`, and App Store Connect must all match.

### 11.5 Account API and admin UI

Endpoints (JSON, no-store, 64 KiB body limit):

- `POST /account/v1/register`
- `POST /account/v1/login`
- `POST /account/v1/apple`
- `GET  /account/v1/me`
- `POST /account/v1/logout`
- `POST /account/v1/delete`
- `POST /account/v1/invite/redeem`
- `POST /account/v1/appstore/transaction`
- `POST /account/v1/appstore/sync`
- `POST /account/v1/appstore/notifications` (Apple JWS, no Bearer)

The public user object never contains a password hash, token hash, Apple `sub`,
transaction JWS, or full original transaction id.

Admin pages: `/admin`, `/admin/users`, `/admin/users/:id`, `/admin/guests`,
`/admin/invites`, `/admin/traffic`, `/admin/settings`. Authentication is an
HMAC-signed HttpOnly cookie derived from the admin password hash; every POST
carries a CSRF token.

### 11.6 Traffic accounting

The phone sends two headers on every relayed request and WebSocket upgrade:

- `x-mizar-client-id`: the installation UUID (also the account device id)
- `x-mizar-account`: the **SHA-256** of the account session token, not the token

The relay strips both before replaying the request to the computer. Identities:

- `account:<64hex>` — a logged-in account
- `guest:<clientId>` — a logged-out install
- `anon:<hash>` — an old client that sent neither header

Counters are per UTC day and per relay, kept 90 days. The free relay posts
batches every 30 seconds to `/internal/v1/traffic` on the account relay with
`Authorization: Bearer <accounts.internalSecret>`; the account relay merges them
and the admin UI shows user/guest totals. A failed report is buffered in memory
and retried; relaying itself never waits for it.

The paid relay reads one more header, `x-mizar-session`, which carries the
session token itself rather than its hash — the gate described in 11.7 needs to
resolve the account, and a hash cannot be resolved. It is stripped before replay
like the other two and never reaches the traffic ledger, which keeps bucketing by
the hash.

The accounting above records; it never refuses. The refusal lives in the
`abuse` meters, which bucket by the same identity **and** by source address —
on a free relay `guest:` and `anon:` are headers a caller chooses, so the
identity alone is not a bound. See 11.11.

### 11.7 The paid gate

A relay with `role: 1` is the one users are told is the high-bandwidth server.
Without a gate that was a hostname and nothing else: any phone that knew a room
id could put unlimited bytes through it, paying or not. The gate closes that.

**How it decides.** The phone presents `x-mizar-session: <account session token>`
on every request and on the WebSocket upgrade under `/r/<room>/`. The relay
resolves the token against its own account store and asks one question: is
`paidUntil` still in the future? Nothing else about the account is consulted, and
the token is used for nothing but this check.

| Situation | Status | `error` | What the phone should do |
|---|---|---|---|
| no `x-mizar-session` | `401` | `UNAUTHENTICATED` | sign in |
| token unknown / expired | `401` | `UNAUTHENTICATED` | sign in again |
| token signed out elsewhere | `401` | `SESSION_REVOKED` | sign in again |
| account disabled | `403` | `ACCOUNT_DISABLED` | contact the operator |
| signed in, not paying | `402` | `PAID_REQUIRED` | subscribe, or use the free relay |

Refusals also carry `x-mizar-gate: <code>`, so a proxy log is enough to tell a
paywall rejection from a network failure.

**What is exempt.** `/mizar/v1/hello` and `/mizar/v1/pair` — the handshake a
phone performs *before* it has an account. Neither carries conversation traffic,
and `/pair` still demands a live single-use code and is rate limited by the
plugin. Everything else, including `/mizar/v1/ws`, is gated.

**What is not gated.** The computer's `/tunnel`. A tunnel moves no bytes until a
phone asks for something, so gating it would only break the case where the
computer's owner has not signed in anywhere — and the plugin has no account to
sign in with. The bandwidth is protected at the phone leg, which is where it is
actually spent.

**Configuration.**

```json
"accounts": {
  "enabled": true,
  "paidGate": { "mode": "enforce", "allowUnaccounted": false, "cacheTtlMs": 60000 }
}
```

| Key | Environment override | Default | What it does |
|---|---|---|---|
| `paidGate.mode` | `MIZAR_PAID_GATE` | `enforce` when `role=1` and accounts are enabled, else `off` | `off` does not check, `observe` counts and logs refusals but lets them through, `enforce` refuses. `true`/`false` are accepted as shorthand for `enforce`/`off` |
| `paidGate.allowUnaccounted` | `MIZAR_PAID_GATE_ALLOW_UNACCOUNTED` | `false` | let a phone with **no** account at all through. For a client that cannot sign in yet (Android today); it does not let a free *account* through. **This is a rollout crutch, not a security setting**: the relay cannot tell an Android from anyone else who simply omits the header, so while it is on, the paywall only stops accounts that do present a token |
| `paidGate.cacheTtlMs` | `MIZAR_PAID_GATE_CACHE_TTL` | `60000` | how long a verified entitlement is reused. A refund, sign-out or downgrade invalidates it immediately through the store's listener, so this only bounds the cost of the common case |

`mode` is validated at startup: a typo throws rather than silently leaving the
paywall down, and `enforce` with `accounts.enabled: false` is refused outright —
a gate with no store cannot check anything, and one that reports itself as on
while letting everybody through is worse than none.

**Rolling it out.** Deploy with `"mode": "observe"` first. `/healthz` reports
`paidGate: "observe"`, every would-be refusal is logged (at most once per ten
seconds per reason), and the relay still carries the traffic. When the logs show
no legitimate phone being refused — that is, when every client in the field sends
the header — switch to `enforce` and restart. The app only sends the token to the
host named in `AccountClient.productionBaseURL`, so a free relay never sees it.

**What the gate does not do.** It decides at connection time: a socket that is
already open is not torn down when a subscription lapses, so the next reconnect is
refused rather than the current conversation being cut. It does not authenticate
the phone to the computer; the pairing device token still does that, over the
tunnel, and the relay still cannot forge it. It does not meter bytes either —
traffic accounting is 11.6 and is deliberately non-blocking. And it does not stop
a paying account from sharing its token; the two-device cap and revocation in the
admin UI are the answer to that, not this.

### 11.8 Data, backup, and rollback

- Critical: `data/accounts.json` (users, sessions, entitlements, App Store
  bindings) and `data/invites.json`.
- `data/traffic.json` is statistics and can be lost more cheaply.
- `data/audit.log` records admin changes and invite redemptions.
- Files are mode 600, the directory 700; the config is 600. Back up
  `accounts.json` and `invites.json` off the server regularly.
- Do **not** copy the config or data between relays except the
  `internalSecret`; the free relay must not hold account data.
- Rollback: set `accounts.enabled=false` and restart to take the account API and
  admin UI offline. The tunnel and every free feature keep working. Reverting the
  app binary is a separate App Store action.

### 11.9 Free relay (主力0) upgrade

1. Upload the same bundle and run `sudo ./install.sh` (existing config kept).
2. Edit the `accounts` block (or use the CLI) to:

   ```json
   "role": 0,
   "accounts": {
     "enabled": false,
     "dataDir": "./data",
     "internalSecret": "<same as 主力1>",
     "reportTo": "https://dshmizar-1.shirazu-nagisa.com",
     "reportId": "primary-0"
   }
   ```

3. Restart. The tunnel reconnect is brief; the computer reconnects
   automatically.
4. Verify `/healthz` returns `role:0, accounts:false` and the 主力1 admin shows
   `primary-0` traffic within about 30 seconds.

### 11.10 Security notes

- The account service handles emails, password hashes, session token hashes, and
  App Store subscription identifiers. Treat `data/` and the config as personal
  data; do not commit or share them.
- The relay already terminates TLS; nobody but the operator can read the traffic.
- The admin UI must be reachable only over HTTPS. The cookie is Secure when nginx
  sets `X-Forwarded-Proto: https`.
- App Store JWS verification is pinned to Apple roots; do not replace it with a
  decoded-payload check.
- Custom invite codes are a promotional/administrative mechanism. Public
  promotions should use Apple Offer Codes to stay within App Store payment
  rules; the invitation entry in the app's About screen should be removed or
  gated if App Review objects.

### 11.11 Abuse limits: per identity and per address

The relay meters carried bytes in two dimensions. Both are configured in the
`abuse` block, both default on, and `0` disables either one.

```json
"abuse": {
  "requestsPerMinute": 300,
  "bytesPerDay": 524288000,
  "requestsPerMinutePerIp": 1200,
  "bytesPerDayPerIp": 2097152000,
  "trafficAlertBytesPerDay": 524288000,
  "trafficAlertBytesPerDayPaid": 5368709120,
  "trafficAlertGrowthFactor": 8
}
```

| Key | Environment override | Default | What it does |
|---|---|---|---|
| `requestsPerMinute` | `MIZAR_ABUSE_REQUESTS_PER_MINUTE` | `300` | sustained data-plane requests per minute **per identity**; a token bucket, so a short burst is allowed and then paced |
| `burst` | `MIZAR_ABUSE_BURST` | `0` (a small multiple of the rate) | burst allowance for both request buckets |
| `bytesPerDay` | `MIZAR_ABUSE_BYTES_PER_DAY` | `500 MiB` (the paid relay sets 5 GiB) | carried bytes per identity per UTC day. Spent, the identity is refused until the day turns over |
| `requestsPerMinutePerIp` | `MIZAR_ABUSE_REQUESTS_PER_MINUTE_PER_IP` | `1200` | the same request rate **per source address** |
| `bytesPerDayPerIp` | `MIZAR_ABUSE_BYTES_PER_DAY_PER_IP` | `4 × 500 MiB` | the same byte budget per source address |
| `trafficAlertBytesPerDay` | `MIZAR_ABUSE_TRAFFIC_ALERT_BYTES` | `500 MiB` | when the traffic ledger raises a `volume` anomaly (11.6) |
| `trafficAlertBytesPerDayPaid` | `MIZAR_ABUSE_TRAFFIC_ALERT_BYTES_PAID` | `5 GiB` | the same ceiling for paid accounts, only consulted on a relay with an account store |
| `trafficAlertGrowthFactor` | `MIZAR_ABUSE_TRAFFIC_ALERT_GROWTH` | `8` | today's total versus the identity's own trailing average raises a `spike` anomaly. Also needs a day above 100 MiB, so a quiet account's small day is not news |

**Why two dimensions.** The per-identity meter is the accurate one when the
identity is real: an account hash cannot be forged, and a phone moving between
networks keeps its budget. But on a free relay the identity is `guest:<x-mizar-client-id>`,
a header the phone chooses — a script that mints a new one per request used to
mint a fresh 500 MiB per request, and the only remaining bound was four tunnels
per IP. The address meter is keyed by the source address instead, which the
caller cannot rotate, so it is the ceiling that survives the rotation.

**IPv6 is counted by /64, not by /128.** A client is supposed to rotate through
the privacy addresses inside its own delegation (SLAAC does it on a schedule), so
counting each /128 separately would turn "four tunnels per address" into four per
rotation and an address budget into no budget at all. The same key is used by the
tunnel count and the byte budget, so one definition of "one peer" cannot drift
between them. The address is taken from the same place the tunnel count takes it:
`X-Real-IP` when the TCP peer is loopback (the nginx deployment) and
`trustProxy` is on, otherwise the socket's address.

**The address limits sit well above the identity ones on purpose.** One address
carries several identities — a household of phones behind one NAT, a CGNAT pool —
so an address budget equal to one identity's would throttle the innocent. Four
identities' worth of headroom is enough for a household and still a hard ceiling
that rotation cannot walk past.

**Order of deduction.** The identity budget is spent first and the address budget
second. The address budget is shared by everyone behind one NAT, so it must only
be spent by traffic the caller's own budget also approved: with the reverse
order, a caller whose identity budget is gone could still drain the shared
address budget with requests doomed to be refused, locking the household out for
the day at no cost to itself. The cost of this order is small — when the address
meter refuses, that caller's own budget has already counted bytes that never
moved.

**Paid accounts are exempt from the address budget.** A caller the paid gate
verified gets no address key at all. Its identity cannot be forged and the
enforcement chain can ban it, so charging the shared address budget as well would
let one heavy user spend a whole NAT's allowance. On a free relay nothing is
gate-verified, so every caller is metered by address.

**What refusal looks like.** An HTTP request gets `429` with
`x-mizar-quota: rate|budget` and a `retry-after`; a bridged WebSocket frame is
dropped rather than tearing down a session the phone already holds, and only a
budget refusal closes the socket (`1008, "traffic allowance spent"`). A spent
address budget is logged once per address/day.

**What this is not.** Not authentication, not billing, and not an account ban. A
free relay keeps its position — no login, no account, zero-config pairing — and
answers abuse with an address-level ceiling plus visibility, not with a ban.
There is also no persistent `ip:` traffic report: the ledger's keys are
identities, and inventing `ip:` rows would corrupt the account relay's view. The
address meter lives in memory, and `quota.ip` plus `anomalies` in `/healthz` plus
the log are its whole surface. That is the honest surface: it answers "where is
the bandwidth going", not "who is spending it".
