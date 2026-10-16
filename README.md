# DSH-Mizar 中继服务器

**让手机从任何网络连上你的 Mac**，即使 Mac 所在的网络封禁入站连接（校园网、公司网、
运营商 CGNAT 都是这样）。同一个中继也负责把推送转给 Apple。

原理很简单：**Mac 主动出站**连到这台服务器，之后手机就通过那条连接找到它。
服务器不解析 Mizar 协议，只搬运字节 —— **手机的身份验证仍然由你 Mac 上的插件完成**，
和同一个 Wi-Fi 下的情况完全一样。

```
Mac 插件 ──出站 wss──▶ 这台服务器 ◀──https── 手机
   /tunnel                    │        /r/<房间号>/...
                              ├─ 转给 Mac 上的 127.0.0.1:19390
                              └─ 推送：/push/v1/notify ──▶ Apple (APNs) ──▶ 手机
```

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
npm test              # 108 个测试
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
