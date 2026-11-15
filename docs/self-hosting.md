# 自建中继：一条命令装好

自建中继是给「不想依赖官方服务器」的人用的：用你自己的域名和服务器，手机与电脑之间
的所有流量都走它，没有账户、没有付费门禁、没有每日流量额度。装好之后，客户端在新手教程
里选「自建服务器」，填域名和安装时打印的服务器 PIN，就能像用官方中继一样发现和连接电脑。

需要准备：

- 一台 Linux 服务器（Debian/Ubuntu/CentOS 均可），root 权限，80 与 443 端口可被公网访问；
- 一个解析到这台服务器公网 IP 的域名（A 记录，先不要开 Cloudflare 橙云代理）；
- 服务器能访问 GitHub（下载安装包与更新）。

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/ShirazuNagisa/DSH-Mizar-Relay/main/deploy/get.sh \
  | sudo bash -s -- --domain relay.example.com
```

可选参数：

| 参数 | 作用 |
|---|---|
| `--email you@example.com` | Let's Encrypt 通知邮箱（可选） |
| `--pin K7QP-3M2X` | 指定服务器 PIN；不填则现场生成并打印一次 |
| `--dir /opt/dsh-mizar-relay` | 安装目录（默认 `/opt/dsh-mizar-relay`） |
| `--no-auto-update` | 不装每日自动更新 timer |
| `--behind-proxy` | 服务器上已有 nginx/宝塔站点，不装 Caddy；按输出提示配置反代 |
| `--no-tls` | 不装 Caddy（内网/调试用，客户端需要 https，不推荐） |
| `--version v0.5.0` | 装指定版本而不是最新版 |

安装器会做这些事：找 Node（没有就下载官方 LTS 到安装目录）、复制中继本体、生成
`relay.config.json`（无账户、无额度限制，保留每 IP 600 请求/分钟的防洪限制）、生成
服务器 PIN 与更新 token（各打印一次，只存 scrypt 哈希）、装 Caddy 并申请证书、写
systemd 服务与每日更新定时器，最后打印：

```
https://relay.example.com/
PIN: K7QP-3M2X
更新 token: <32 位>
```

**这两个明文只显示这一次**：PIN 用来让手机/电脑列出你的电脑，更新 token 用来在教程页
触发更新。忘了就在安装目录执行 `sudo ./install.sh --rotate-pin` 或
`--rotate-update-token`（会生成新的并重启服务）。

## 装完以后

打开 `https://<域名>/`：

- 状态：服务是否在跑、在线电脑数、推送能力、隧道协议版本；
- 连接设备：电脑端、手机端各自要填什么；
- 更新：当前/最新版本、检查更新、凭 token 立即更新；
- 排错：证书、日志、轮换、回滚的命令。

客户端那边：

1. **电脑**：AGI Mizar → 设置 → 服务器 → 自建服务器，填域名 + PIN。
2. **手机**：DSH-Mizar → 新手教程/设置 → 服务器 → 自建服务器，填域名 + PIN；之后在
   「连接你的电脑」里选这台电脑，输入电脑上显示的 6 位配对码。
3. 电脑与电脑之间也用同一套配对码互认（远程 Agent），不再需要账户。

## 配置

`selfHost` 块是自建模式的开关，官方部署不写它：

```json
"selfHost": {
  "pinHash": "scrypt$…",
  "updateTokenHash": "scrypt$…",
  "publicURL": "https://relay.example.com",
  "autoUpdate": true,
  "updateScript": "/opt/dsh-mizar-relay/update.sh",
  "githubRepo": "ShirazuNagisa/DSH-Mizar-Relay",
  "dataDir": "/opt/dsh-mizar-relay/data"
}
```

- `pinHash` 为空：电脑列表公开（任何知道域名的人都能看到电脑名，但仍需配对码才能连上）。
- `updateTokenHash` 为空：教程页不能触发更新，每日 timer 仍然工作。
- 两个哈希用 `node lib/selfhost/cli.js init|rotate` 生成，不要手写明文。

端点：

| 路径 | 说明 |
|---|---|
| `GET /healthz` | 公共状态；`product` 用于客户端校验「这是 DSH 中继」 |
| `GET /` | 中英双语教程页 |
| `GET /selfhost/v1/desktops` | 在线电脑列表，需要 `x-mizar-server-pin` |
| `GET/POST /selfhost/v1/update` | 查/触发更新，需要 `x-mizar-update-token` |

## 更新

默认每天凌晨（03:00 + 最多 1 小时随机延迟）检查 GitHub Releases，有新版就自动安装：

1. 下载 `dsh-mizar-relay-<ver>.tar.gz` 与 `SHA256SUMS`，校验；
2. 把当前的 `lib/`、`node_modules/`、`package.json` 等备份到 `app.previous/`；
3. 停服务、换文件、启服务；
4. 30 秒内 `/healthz` 没恢复就自动回滚到上一版。

`relay.config.json` 和 `data/` 永远不动。手动操作：

```sh
sudo /opt/dsh-mizar-relay/update.sh --check   # 只查
sudo /opt/dsh-mizar-relay/update.sh --apply   # 立即更新
tail -f /opt/dsh-mizar-relay/data/update-state.json
```

官方部署（宝塔 + nginx）不在自动更新范围内，升级仍然是重新上传并重跑 `install.sh`。

## 排错

```sh
systemctl status dsh-mizar-relay
journalctl -u dsh-mizar-relay -n 80
journalctl -u caddy -n 80            # 证书/反代
curl -fsS https://<域名>/healthz     # 应该返回 product":"dsh-mizar-relay"
```

- **证书一直申请不到**：域名没解析到本机、80/443 没放行、或域名开了 Cloudflare 橙云。
  先改成灰云；Caddy 能用 443 的 TLS-ALPN 取证书，所以 80 被别的站点占用通常不影响。
- **手机说「不是 DSH-Mizar 中继」**：`/healthz` 返回的不是本中继（反代指错了端口，或者
  域名指向了别的站）。
- **PIN 不对**：`sudo ./install.sh --rotate-pin` 生成新的，再在客户端重填。
- **端口被占用**：安装器会提示 80/443 被谁占用；已有站点请用 `--behind-proxy`，按输出
  把 WebSocket 反代片段加进去。

## 卸载

```sh
sudo systemctl disable --now dsh-mizar-relay dsh-mizar-relay-update.timer caddy
sudo rm -rf /opt/dsh-mizar-relay /etc/systemd/system/dsh-mizar-relay.service \
  /etc/systemd/system/dsh-mizar-relay-update.service \
  /etc/systemd/system/dsh-mizar-relay-update.timer
```

（Caddy 如果是安装器装的，还会在 `/usr/local/bin/caddy` 与 `/etc/caddy/`。）
