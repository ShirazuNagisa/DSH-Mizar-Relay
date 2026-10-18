# DSH-Mizar 中继服务器

**让手机从任何网络连上你的电脑**，即使电脑所在的网络封禁入站连接（校园网、公司网、
运营商 CGNAT 都是这样）。

原理很简单：**电脑主动出站**连到这台服务器，之后手机就通过那条连接找到它。
服务器不解析 Mizar 协议，只搬运字节——**手机的身份验证仍然由你电脑上的插件完成**，
和同一个 Wi-Fi 下的情况完全一样。

```
电脑插件 ──出站 wss──▶ 这台服务器 ◀──https── 手机
   /tunnel                    │        /r/<房间号>/...
                              └─ 转给电脑上的 127.0.0.1:19390
```

---

## 推送（APNs）

中继还负责把「审批/提问/跑完」的推送转给 Apple——手机不在前台时的通知走这条路，
插件本身拿不到、也不该拿到 Apple 的签名密钥。要用推送就把 `apns` 配进
`app/relay.config.json`（`keyId` / `teamId` / `topic` / `key`），步骤见
`DEPLOYMENT-FULL.md` 第 10 节。**不配也不会坏**：中继照常转发消息，只是不发推送，
插件启动日志里会写 `push: this relay has no push API …`。

---

## 三步

### 第一步：上传并安装

把整个文件夹上传到服务器（例如 `/www/wwwroot/dsh-mizar-relay`），然后在**宝塔终端**里：

```bash
cd /www/wwwroot/dsh-mizar-relay
sudo ./install.sh
```

装完会打印一段信息，**里面有一串 token，后面要用**。

> **token 是在你的服务器上现场生成的**，不是包里带的。所以每台服务器各不相同，
> 也不存在「默认凭证」。**重新运行 `install.sh` 会保留已有的 token**，不会让已经配好的
> 电脑失效。

> 这个包**不需要 `npm install`，也不需要编译**——服务端代码和它唯一的依赖（`ws`，196K）
> 都已经在包里。这是刻意的：在国内服务器上访问 npm registry 是一个可能因为与本软件
> 毫无关系的原因而失败的步骤。

**装完先自检一遍**（在安装目录里跑）：

```bash
/www/server/nodejs/v24.22.0/bin/node selftest.js
```

它假装自己是电脑，把中继整条链路走一遍——**通过了就说明服务器这边没问题**，
后面万一连不上，问题一定在 DNS / 证书 / 反向代理，不用来回猜。

### 第二步：宝塔里配站点

**1. 添加站点**

宝塔 → **网站** → **添加站点**，填你要用的域名。

> 先把域名的 DNS 解析指向这台服务器的 IP。这一步在你的域名服务商那里做，宝塔管不了。

**2. 申请证书**

站点设置 → **SSL** → **Let's Encrypt** → 申请 → 打开 **强制 HTTPS**。

**3. 配反向代理**

站点设置 → **反向代理** → 添加：

| 项 | 值 |
|---|---|
| 代理名称 | `dsh-mizar-relay` |
| 目标 URL | `http://127.0.0.1:8787` |
| 发送域名 | `$host` |

**4. 粘贴 WebSocket 配置（关键，别跳过）**

打开站点设置 → **配置文件**，在反向代理的 `location` 块里，把同目录下
**`nginx-websocket.conf`** 的内容整个粘进去。

**不做这一步会怎样**：nginx 会把 `Upgrade` 请求头丢掉，WebSocket 握手失败。
症状是手机能连上又立刻断开，或者电脑的日志里隧道反复重连。

### 第三步：配置电脑上的插件

编辑 `~/.dsh/profiles/<你的profile>/cordis.patch.yml`，加上：

```yaml
- id: mizar
  config:
    relay:
      enabled: true
      url: "https://你的域名"
      token: "第一步打印出来的那串 token"
    bind:
      mode: loopback        # 有隧道时不需要再把端口暴露在局域网上
```

**重启 DSH**。面板会显示中继已连接、房间号，以及给手机用的配对地址。

**手机重新扫码配对**——二维码里现在带的是中继地址。

---

## 验证

**先在服务器本机自检**（不需要域名）：

```bash
cd /www/wwwroot/dsh-mizar-relay
/www/server/nodejs/v24.22.0/bin/node selftest.js
```

正常输出：

```
  PASS  the relay answers /healthz
  PASS  a tunnel with no token is refused
  PASS  the token is accepted and a room is assigned
  PASS  a request reaches the tunnel and its answer comes back
  PASS  a phone WebSocket is bridged through to the tunnel
  PASS  an unknown room and an unanswered one are both 404 to a stranger
```

**再验域名**：

```bash
curl https://你的域名/healthz
# → {"ok":true,"rooms":1,"inFlight":0,"version":1}
```

`rooms` 是 0 说明电脑还没连上来；是 1 就对了。

看日志：

```bash
journalctl -u dsh-mizar-relay -f
```

正常启动长这样：

```
relay: listening on 127.0.0.1:8787
relay: serving 1 room(s)
relay: tunnel for room XXXXXXXXXXXX connected
```

---

## 排错

| 现象 | 原因 | 怎么办 |
|---|---|---|
| **提示没装 node，但宝塔里明明装了** | **宝塔的 Node 不在 shell 的 PATH 里** | 见下方说明；`install.sh` 会自动去找 |
| 自检通过了，但手机连不上 | 问题在反代，不在中继 | 检查 `nginx-websocket.conf` 有没有粘全 |
| 电脑日志 `401` | token 不一致 | 对比插件配置和 `app/relay.config.json` 里的 `tokens[0]` |
| `curl /healthz` 返回 404 | 反代没配好，请求没到 relay | 检查目标 URL 是不是 `http://127.0.0.1:8787` |
| 手机扫码后 `404` | 房间号不对，或电脑没连上 | 看 `healthz` 的 `rooms`；重新扫码 |
| 手机连上又立刻断开 | **WebSocket 头没配** | 粘贴 `nginx-websocket.conf`，重载 nginx |
| 隧道每分钟重连一次 | `proxy_read_timeout` 还是默认 60s | 见上一行，改成 `3600s` |
| 手机 `502` | 电脑没应答 | 电脑上的 DSH 在跑吗？看插件日志 |
| 服务起不来 | 端口被占 | `journalctl -u dsh-mizar-relay -n 40` |
| 探测口不通 | UDP 8788 被防火墙挡了 | 放行 UDP 8788（只有打洞阶段用得到） |

### 为什么 `node -v` 说找不到，但宝塔说装了

**宝塔把 Node 装在 `/www/server/nodejs/<版本>/bin/`，但不把它加进普通 shell 的 PATH**——
宝塔自己的 Node 项目管理器用的是绝对路径。所以在终端里敲 `node -v` 得到
`command not found`，**完全不能说明 Node 没装**。

自己确认一下：

```bash
ls -d /www/server/nodejs/*/bin/node
```

`install.sh` 会按这个顺序找，多个版本时**选最新的**：

1. 当前 shell 的 PATH
2. `/www/server/nodejs/*/bin/node` ← 宝塔装在这
3. `/usr/local/bin`、`/usr/bin`、`/opt/node/bin`、`/snap/bin`
4. `~/.nvm/...` 和 `/root/.nvm/...`

找到哪个会打印出来。**systemd 服务里写的是绝对路径**——服务不继承任何 shell 配置，
写 `node` 会在开机时找不到。

---

## 关于安全，说清楚

**这台服务器能看到经过它的明文流量。** 它终止 TLS，所以电脑和手机之间的内容——
包括 agent 的对话——在它上面是明文。你自己运维时这是可接受的，但**如果你把服务器
借给别人用，这句话就不成立了**。也正因如此，**端到端加密是后续的独立阶段**。

**房间号比 token 弱，而且会外传。** 房间号由 token 推导而来，会出现在二维码、
手机存储和 nginx 访问日志里。它能到达的只有两个不需要认证的端点：`/hello` 和 `/pair`，
而 `/pair` 还需要一次性配对码并且有限流。**token 则完全不同——泄露 token 等于让别人
成为你的电脑**，所以它只存在于这台服务器的 `relay.config.json`（权限 600）和你的
电脑上，永远不要提交到 git。

**手机上做了两层校验**：二维码里的地址（`u` 参数）必须是 `http` 或 `https`，
因为那个地址决定设备令牌发往哪里——一个伪造的二维码不应该能把 App 指去别处。

---

## 常用命令

```bash
systemctl status dsh-mizar-relay      # 状态
systemctl restart dsh-mizar-relay     # 重启
journalctl -u dsh-mizar-relay -f      # 实时日志
```

改配置（`app/relay.config.json`）之后要 `systemctl restart dsh-mizar-relay`。

---

## 这个包为什么是现在这个形状

| 决定 | 原因 |
|---|---|
| **绑定 `127.0.0.1`** | nginx 在前面终止 TLS，Node 进程不需要被直接访问。**绝不要把 8787 暴露到公网**——它说的是明文 HTTP |
| **内置 `lib/` 和 `node_modules/ws`** | 服务器上不需要编译器，也不需要联网拉包 |
| **房间号由服务器推导** | 只有一份实现，不会两端不一致；而且电脑无法冒领别人的房间 |
| **未知房间统一返回 404** | 区分"从未存在"和"电脑离线"会让人能枚举出哪些电脑在线 |
| **WebSocket 升级延迟到电脑同意之后** | 否则手机看到的是"连上又断开"，和"电脑不可达"在日志里长得一模一样 |

更详细的说明（含 systemd 细节、配置项全表、中文快速开始）见仓库里的
`docs/relay-deployment.md`。
