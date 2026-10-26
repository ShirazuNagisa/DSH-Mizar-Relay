# DSH-Mizar 中继服务器

**让手机从任何网络连上你的电脑**，即使电脑所在的网络封禁入站连接（校园网、公司网、
运营商 CGNAT 都是这样）。同一个中继也负责把推送转给 Apple。

原理很简单：**电脑主动出站**连到这台服务器，之后手机就通过那条连接找到它。
服务器不解析 Mizar 协议，只搬运字节 —— **手机的身份验证仍然由你电脑上的插件完成**，
和同一个 Wi-Fi 下的情况完全一样。

```
电脑插件 ──出站 wss──▶ 这台服务器 ◀──https── 手机
   /tunnel                    │        /r/<房间号>/...
                              ├─ 转给电脑上的 127.0.0.1:19390
                              └─ 推送：/push/v1/notify ──▶ Apple (APNs) ──▶ 手机
```

## 账户服务、角色与 App Store 订阅

从 0.2.4 起，中继可以承担账户服务：

- `role: 0` 是免费中继（主力0），`role: 1` 是付费/账户中继（主力1）。
  role 本身不拒绝隧道连接 —— 拒绝的是下一条的付费门禁。
- **付费门禁**：`role: 1` 且开启账户服务时默认 `enforce`，手机必须在
  `x-mizar-session` 里带账户会话令牌，中继解析后只认「付费期仍在进行」的账户；
  免费账户得 `402 PAID_REQUIRED`，未登录 `401`。`/mizar/v1/hello` 与
  `/mizar/v1/pair` 放行（配对前还没有账户），隧道 `/tunnel` 不拦（隧道本身不产生
  流量，带宽在手机这一侧被守住）。灰度时用 `"mode": "observe"` 只记录不拦截。
  细节见 `docs/deployment.md` 11.7。
- `accounts.enabled: true` 的中继提供：
  - `/account/v1/*`：注册、登录、Apple 登录、邀请码兑换、App Store 订阅校验
  - `/admin`：用户/游客/流量/邀请码/设置后台（管理员密码 + HttpOnly cookie + CSRF）
  - 汇总流量：主力0 每 30 秒把身份计数上报到主力1
- 账户数据只写入配置的 `dataDir`（`accounts.json`、`invites.json`、
  `traffic.json`、`audit.log`），不进入代码仓库。
- 付费账户有两种来源：**App Store 月度自动续期订阅**（StoreKit 2，价格在
  App Store Connect 设置）和**邀请码/后台授予**；两者独立记账，取较晚到期时间。
- 邮箱注册账户最多 2 台设备；Apple 登录账户不限设备。
- Gravatar 在主力1 不可直连时使用镜像链，全部失败回退哈希生成头像。

主力1 的完整配置、nginx/证书、App Store Connect 清单和备份说明见
[docs/deployment.md](docs/deployment.md) 第 11 节。

## 带宽护栏

免费中继不要求登录，配额的身份就是客户端自报的 `x-mizar-client-id` —— 轮换它
就等于换一个新配额桶。所以带宽按**两个维度**记：

- **按身份**：300 请求/分钟、500 MiB/天（付费中继 5 GiB/天）。
- **按来源地址**：1200 请求/分钟、2 GiB/天，IPv6 按 **/64** 聚合 —— 地址不能靠
  改请求头换掉，这是轮换身份绕不过去的那道天花板。付费门禁验证过的账户不占地址额度，
  免得一个人吃光整个 NAT 的份额。

超额回 `429`（`x-mizar-quota: rate|budget`）；`/healthz` 的 `quota.ip` 与
`anomalies` 让运维不读日志也能看到异常。全部键、默认值、扣减顺序与取舍见
[docs/deployment.md](docs/deployment.md) 11.11，起因见工作区
`docs/relay-free-tier-abuse-risk-2026-10-26.md`。

## 部署

打包成一个自包含的 bundle，然后在服务器上装：

```sh
npm run pack                                  # → ../../release/dsh-relay/dsh-mizar-relay-<版本>.tar.gz
```

bundle 里已经带好编译后的 `lib/`、唯一依赖 `ws`、`install.sh`（装成 systemd 服务）、
宝塔的 nginx 反代片段，以及 `DEPLOYMENT-FULL.md`（完整参考）。**服务器上不需要联网、
不需要 npm install、不需要编译。**

上传、解包、`sudo ./install.sh`，三步。细节见 bundle 里的 `README.md`，
源码里对应 `deploy/README.md`。

**推送（APNs）是可选的。** 配置里不写 `apns` 也能正常转发消息，只是不发推送；
插件启动日志会写 `push: this relay has no push API …`。要开推送就把 Apple 的
`keyId` / `teamId` / `topic` / 私钥填进服务器的 `app/relay.config.json`，
步骤见 `docs/deployment.md` 第 10 节。

## 开发

```sh
npm install
npm test              # 200+ 个测试
npm run typecheck
npm run build         # tsc → lib/（lib/ 不进仓库，bundle 里才有）
npm start             # 用 relay.config.json 起一个本地实例
```

配置项全表、systemd 细节、排错手册：[docs/deployment.md](docs/deployment.md)。

## 目录

| | |
|---|---|
| `src/` | 中继本体：隧道、房间、协议、APNs |
| `test/` | vitest |
| `deploy/` | 打包进 bundle 的部署材料（install.sh、nginx 片段、selftest、说明） |
| `deploy/pack.sh` | 打 bundle 的脚本 |
| `docs/deployment.md` | 部署参考 |

## 许可

本项目以 **GNU General Public License v3.0**（GPLv3，SPDX：`GPL-3.0-only`）发布。
许可证全文见 [LICENSE](LICENSE)。
