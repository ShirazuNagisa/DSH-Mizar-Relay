#!/usr/bin/env bash
#
# Install the DSH-Mizar relay as a systemd service.
#
# Two modes, one script:
#
#   * Without --domain: the original BaoTa/nginx flow, unchanged. The bundle is
#     copied to /www/wwwroot/dsh-mizar-relay, the role is configured, the unit
#     is written and the operator is told the three BaoTa steps.
#
#   * With --domain: a self-hosted installation. Node is downloaded if missing,
#     the bundle is copied to /opt/dsh-mizar-relay, a minimal relay.config.json
#     is written, the selfHost block is generated through lib/selfhost/cli.js,
#     Caddy is installed and configured for automatic HTTPS (unless the caller
#     already has a proxy or asked for no TLS), and a daily update timer is
#     installed.
#
# The self-host mode keeps the same promise as the old installer: re-running it
# preserves relay.config.json, the data directory, the PIN and the update token.
#
# Usage:
#   sudo [MIZAR_ROLE=0|1] ./install.sh [install-dir]          # BaoTa/nginx
#   sudo ./install.sh --domain relay.example.com [options]    # self-hosted
#   sudo ./install.sh --rotate-pin [--dir <install-dir>]
#   sudo ./install.sh --rotate-update-token [--dir <install-dir>]
#
# Self-hosted options:
#   --domain <host|https origin>  required; https:// is accepted and stripped
#   --email <addr>                Caddy / Let's Encrypt notification address
#   --pin <value>                 use this server PIN instead of generating one
#   --dir <path>                  install directory (default /opt/dsh-mizar-relay)
#   --no-auto-update              do not install the daily update timer
#   --behind-proxy                keep an existing nginx/BaoTa proxy; no Caddy
#   --no-tls                      do not install Caddy (private network/debug)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE=/etc/systemd/system/dsh-mizar-relay.service
UPDATE_SERVICE=/etc/systemd/system/dsh-mizar-relay-update.service
UPDATE_TIMER=/etc/systemd/system/dsh-mizar-relay-update.timer
CADDY_SERVICE=/etc/systemd/system/caddy.service
CADDYFILE=/etc/caddy/Caddyfile

DOMAIN=''
EMAIL=''
PIN_ARG=''
DIR_ARG=''
POSITIONAL=''
AUTO_UPDATE=1
BEHIND_PROXY=0
NO_TLS=0
ROTATE=''
TARGET=''
TMP_DIR=''

say() { printf '  %s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
fail() {
  printf '\n  ✗ %s\n\n' "$*" >&2
  if [ "${PIN_ROTATED:-}" = "true" ] || [ "${TOKEN_ROTATED:-}" = "true" ]; then
    printf '  提示：本次已经生成新的 PIN/更新 token，但还没到最后的总结框。\n' >&2
    printf '        修复后重跑安装器；如果配置里已有新哈希，可用 --rotate-pin / --rotate-update-token 重新生成并显示。\n\n' >&2
  fi
  exit 1
}

usage() {
  cat <<'USAGE'
DSH-Mizar relay 安装器

自建模式（推荐，一条命令）：
  curl -fsSL https://raw.githubusercontent.com/ShirazuNagisa/DSH-Mizar-Relay/main/deploy/get.sh \
    | sudo bash -s -- --domain relay.example.com

  或解包 release 后在本目录运行：
  sudo ./install.sh --domain relay.example.com [选项]

  --domain <host|https origin>  必填；域名或 https://域名
  --email <addr>                Caddy / Let's Encrypt 通知邮箱（可选）
  --pin <value>                 指定服务器 PIN（不填则生成并打印一次）
  --dir <path>                  安装目录，默认 /opt/dsh-mizar-relay
  --no-auto-update              不安装每日自动更新 timer
  --behind-proxy                已有 nginx/宝塔反代，不装 Caddy
  --no-tls                      内网/调试：不装 Caddy（中继仍只监听 127.0.0.1:8787）

宝塔/nginx 旧模式（不带 --domain，行为与旧版一致）：
  sudo [MIZAR_ROLE=0|1] ./install.sh [install-dir]
  默认安装目录 /www/wwwroot/dsh-mizar-relay

轮换密钥（在安装目录里运行，不需要 --domain）：
  sudo ./install.sh --rotate-pin
  sudo ./install.sh --rotate-update-token

自建模式装完后：
  打开 https://<域名>/ 查看教程页
  日志 journalctl -u dsh-mizar-relay -f
USAGE
}

fail_usage() {
  printf '\n  ✗ %s\n\n' "$*" >&2
  usage >&2
  exit 1
}

cleanup() {
  if [ -n "${TMP_DIR:-}" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- arguments --------------------------------------------------------------

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      [ "$#" -ge 2 ] || fail_usage "--domain 需要值"
      DOMAIN="$2"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --email)
      [ "$#" -ge 2 ] || fail_usage "--email 需要值"
      EMAIL="$2"; shift 2 ;;
    --email=*) EMAIL="${1#*=}"; shift ;;
    --pin)
      [ "$#" -ge 2 ] || fail_usage "--pin 需要值"
      PIN_ARG="$2"; shift 2 ;;
    --pin=*) PIN_ARG="${1#*=}"; shift ;;
    --dir)
      [ "$#" -ge 2 ] || fail_usage "--dir 需要值"
      DIR_ARG="$2"; shift 2 ;;
    --dir=*) DIR_ARG="${1#*=}"; shift ;;
    --no-auto-update) AUTO_UPDATE=0; shift ;;
    --behind-proxy) BEHIND_PROXY=1; shift ;;
    --no-tls) NO_TLS=1; shift ;;
    --rotate-pin) ROTATE=pin; shift ;;
    --rotate-update-token) ROTATE=update-token; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) fail_usage "未知选项：$1" ;;
    -* ) fail_usage "未知选项：$1" ;;
    *)
      [ -z "$POSITIONAL" ] || fail_usage "只能指定一个安装目录（位置参数）"
      POSITIONAL="$1"; shift ;;
  esac
done

# The rotation commands are documented as `sudo ./install.sh --rotate-pin` from
# the install directory, so without --domain/--dir the script's own directory is
# the target. A normal install keeps the old defaults.
if [ -n "$ROTATE" ] && [ -z "$DIR_ARG" ] && [ -z "$POSITIONAL" ]; then
  TARGET="$HERE"
elif [ -n "$DIR_ARG" ]; then
  TARGET="$DIR_ARG"
elif [ -n "$POSITIONAL" ]; then
  TARGET="$POSITIONAL"
elif [ -n "$DOMAIN" ]; then
  TARGET=/opt/dsh-mizar-relay
else
  TARGET=/www/wwwroot/dsh-mizar-relay
fi
TARGET="${TARGET%/}"
[ -n "$TARGET" ] || fail_usage "安装目录不能是 /"
case "$TARGET" in
  /*) ;;
  *) TARGET="$PWD/$TARGET" ;;
esac
case "$TARGET" in
  *[[:space:]]*) fail "安装目录不能包含空格：$TARGET" ;;
esac

# --- helpers ----------------------------------------------------------------

# BaoTa installs Node under /www/server/nodejs/<version>/bin and does NOT put it
# on the PATH of a plain shell. A self-hosted install may also carry its own
# runtime under <install-dir>/runtime. Check both before giving up.
find_node() {
  local candidate
  for candidate in $(ls -d "$TARGET"/runtime/node-v*/bin/node 2>/dev/null | sort -Vr); do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in $(ls -d /www/server/nodejs/*/bin/node 2>/dev/null | sort -Vr); do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  for candidate in /usr/local/bin/node /usr/bin/node /opt/node/bin/node /snap/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /root/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

node_major_of() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0'
}

# Official Node Linux builds are linked against glibc. Alpine's musl cannot run
# them, and the failure mode is an unhelpful "not found" from the loader, so say
# so before downloading anything.
is_musl() {
  if [ -f /etc/alpine-release ]; then return 0; fi
  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then return 0; fi
  fi
  return 1
}

normalise_domain() {
  local value="$1"
  # Strip the scheme case-insensitively, then anything from the first slash on.
  value="$(printf '%s' "$value" | sed -E 's#^[Hh][Tt][Tt][Pp][Ss]?://##')"
  value="${value%%/*}"
  value="${value%/}"
  printf '%s' "$value"
}

validate_domain() {
  case "$DOMAIN" in
    '') fail "--domain 不能为空" ;;
    *[[:space:]]*|*/*) fail "--domain 不是有效域名：'$DOMAIN'" ;;
    *[!A-Za-z0-9.:-]*) fail "--domain 只接受域名（可带端口），不要带路径：'$DOMAIN'" ;;
  esac
}

validate_email() {
  case "$EMAIL" in
    *[[:space:]]*|*[!A-Za-z0-9._%+@-]*) fail "--email 不是有效邮箱：'$EMAIL'" ;;
    *@*.*) ;;
    *) fail "--email 不是有效邮箱：'$EMAIL'" ;;
  esac
}

# Ask GitHub for the latest tag of a repository. Same API-then-redirect fallback
# as get.sh/update.sh; used for Caddy, whose release tags look like v2.10.0.
resolve_latest_tag() {
  local repo="$1" json='' tag='' location=''
  json="$(curl -fsSL --connect-timeout 10 --max-time 30 \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: dsh-mizar-relay-installer' \
    "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" \
    | grep -o '"tag_name": *"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*"([^"]*)"$/\1/' || true)"
  if [ -z "$tag" ]; then
    location="$(curl -fsSI --connect-timeout 10 --max-time 30 \
      -H 'User-Agent: dsh-mizar-relay-installer' \
      "https://github.com/$repo/releases/latest" 2>/dev/null \
      | tr -d '\r' \
      | awk 'tolower($1) == "location:" { print $2; exit }' || true)"
    if [ -n "$location" ]; then
      location="${location%%\?*}"
      tag="${location##*/}"
    fi
  fi
  tag="${tag#v}"
  tag="${tag#V}"
  case "$tag" in
    ''|*[!0-9A-Za-z.-]*) return 1 ;;
  esac
  printf '%s' "$tag"
}

download_node() {
  local arch='' dist='' index='' file=''
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "不支持的 CPU 架构：$(uname -m)。请手动安装 Node 20+ 后重跑。" ;;
  esac
  dist="https://nodejs.org/dist/latest-v24.x/"
  say "读取 Node LTS 目录：$dist"
  if ! index="$(curl -fsSL --connect-timeout 20 --max-time 60 "$dist")"; then
    fail "无法访问 nodejs.org。请手动安装 Node 20+ 后重跑，或把官方 linux-$arch 包解压到 $TARGET/runtime/。"
  fi
  file="$(printf '%s' "$index" \
    | grep -o "node-v[0-9][0-9.]*-linux-$arch\.tar\.xz" \
    | sort -V | tail -n 1)"
  [ -n "$file" ] || fail "在 Node LTS 目录里找不到 linux-$arch 的 .tar.xz；请手动安装 Node 20+。"
  say "下载 $file …"
  mkdir -p "$TARGET/runtime" || fail "无法创建 $TARGET/runtime"
  if ! curl -fsSL --retry 3 --connect-timeout 20 "$dist$file" | tar -xJ -C "$TARGET/runtime"; then
    fail "下载或解包 Node 失败。官方 linux-x64/arm64 二进制依赖 glibc，Alpine/musl 不支持。
  手动做法（任选其一）：
    1. Debian/Ubuntu: apt-get update && apt-get install -y nodejs npm（需要 20+）
    2. CentOS/RHEL:   dnf install -y nodejs
    3. 从 $dist 下载 ${file}，解压后把目录放到 $TARGET/runtime/，重跑本安装器
  如果只是缺少 xz：apt-get install -y xz-utils 后重试。"
  fi
  NODE_BIN="$(ls -d "$TARGET"/runtime/node-v*/bin/node 2>/dev/null | sort -V | tail -n 1)"
  [ -x "$NODE_BIN" ] || fail "Node 解包后找不到 $TARGET/runtime/node-*/bin/node"
}

# --- self-hosted mode -------------------------------------------------------

ensure_caddy() {
  if [ -x /usr/local/bin/caddy ]; then return 0; fi
  mkdir -p /usr/local/bin || fail "无法创建 /usr/local/bin"
  if command -v caddy >/dev/null 2>&1; then
    ln -sf "$(command -v caddy)" /usr/local/bin/caddy || fail "无法链接 Caddy 到 /usr/local/bin"
    say "已把 $(command -v caddy) 链接到 /usr/local/bin/caddy"
    return 0
  fi
  local arch='' ver='' url=''
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "不支持的 CPU 架构：$(uname -m)。请手动安装 Caddy 后重跑。" ;;
  esac
  if ! ver="$(resolve_latest_tag caddyserver/caddy)"; then
    fail "无法解析 Caddy 最新版本。请手动安装 Caddy（https://caddyserver.com/docs/install）后重跑。"
  fi
  case "$ver" in
    *[!0-9.]*) fail "Caddy 版本号异常：$ver" ;;
  esac
  url="https://github.com/caddyserver/caddy/releases/download/v$ver/caddy_${ver}_linux_${arch}.tar.gz"
  say "下载 Caddy $ver …"
  TMP_DIR="$(mktemp -d)" || fail "无法创建临时目录"
  if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$TMP_DIR/caddy.tar.gz" "$url"; then
    rm -rf "$TMP_DIR"; TMP_DIR=''
    fail "Caddy 下载失败：$url
  可以手动下载后放到 /usr/local/bin/caddy，或改用 --behind-proxy 交给现有 nginx。"
  fi
  if ! tar -xzf "$TMP_DIR/caddy.tar.gz" -C "$TMP_DIR" caddy; then
    rm -rf "$TMP_DIR"; TMP_DIR=''
    fail "Caddy 解包失败：$url"
  fi
  mkdir -p /usr/local/bin
  cp "$TMP_DIR/caddy" /usr/local/bin/caddy || fail "无法写入 /usr/local/bin/caddy"
  chmod 0755 /usr/local/bin/caddy
  rm -rf "$TMP_DIR"; TMP_DIR=''
  say "已安装 /usr/local/bin/caddy（${ver}）"
}

write_caddyfile() {
  local backup=''
  mkdir -p /etc/caddy || fail "无法创建 /etc/caddy"
  if [ -f "$CADDYFILE" ]; then
    backup="$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$CADDYFILE" "$backup" || fail "无法备份 $CADDYFILE"
    say "已备份现有 Caddyfile 到 $backup"
  fi
  {
    if [ -n "$EMAIL" ]; then
      printf '{\n\temail %s\n}\n\n' "$EMAIL"
    fi
    printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:8787\n}\n' "$DOMAIN"
  } > "$CADDYFILE" || fail "无法写入 $CADDYFILE"
  chmod 644 "$CADDYFILE"
}

write_caddy_unit() {
  cat > "$CADDY_SERVICE" <<UNIT
[Unit]
Description=Caddy for the DSH-Mizar relay
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
}

detect_busy_ports() {
  local busy=''
  if command -v ss >/dev/null 2>&1; then
    busy="$(ss -ltn 2>/dev/null | awk 'NR > 1 { print $4 }' | grep -E ':(80|443)$' || true)"
  elif command -v netstat >/dev/null 2>&1; then
    busy="$(netstat -ltn 2>/dev/null | awk 'NR > 2 { print $4 }' | grep -E ':(80|443)$' || true)"
  fi
  if [ -n "$busy" ]; then
    say "提示：80/443 已有监听：$(printf '%s' "$busy" | tr '\n' ' ')"
    say "Caddy 仍会尝试用 443 的 TLS-ALPN 申请证书；若证书申请失败，先停掉占用者或用 --behind-proxy。"
  fi
}

install_tls() {
  step "6/7" "配置 HTTPS"
  if [ "$NO_TLS" -eq 1 ]; then
    say "已按 --no-tls 跳过 Caddy（中继仍只监听 127.0.0.1:8787）"
    if [ -n "$EMAIL" ]; then say "（--email 已忽略，因为没有安装 Caddy）"; fi
    TLS_STATUS="未启用（--no-tls）"
    return 0
  fi
  if [ "$BEHIND_PROXY" -eq 1 ]; then
    say "已按 --behind-proxy 跳过 Caddy；请让现有 nginx/宝塔反代到 http://127.0.0.1:8787"
    if [ -n "$EMAIL" ]; then say "（--email 已忽略，因为没有安装 Caddy）"; fi
    TLS_STATUS="由现有反代提供"
    return 0
  fi
  ensure_caddy
  write_caddyfile
  if ! /usr/local/bin/caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    fail "Caddyfile 校验失败。运行 /usr/local/bin/caddy validate --config $CADDYFILE --adapter caddyfile 查看原因。"
  fi
  write_caddy_unit
  detect_busy_ports
  systemctl daemon-reload
  systemctl enable caddy >/dev/null 2>&1 || say "警告：systemctl enable caddy 失败"
  CADDY_RUNNING=0
  if systemctl restart caddy; then
    CADDY_RUNNING=1
    say "caddy 已启动"
  else
    say "警告：caddy 启动失败；证书可能还没申请。查看 journalctl -u caddy -n 80"
  fi
  if [ "$CADDY_RUNNING" -eq 1 ] && curl -fsS --max-time 15 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    say "https://$DOMAIN/healthz 验证通过"
    TLS_STATUS="Caddy + Let's Encrypt"
  elif [ "$CADDY_RUNNING" -eq 1 ]; then
    say "提示：https 验证暂未通过（证书可能还在申请，通常 1-2 分钟）"
    say "查看：journalctl -u caddy -f"
    TLS_STATUS="Caddy（证书申请中，稍后重试）"
  else
    TLS_STATUS="Caddy（启动失败，检查 journalctl -u caddy）"
  fi
}

install_update_units() {
  if [ "$AUTO_UPDATE" -eq 0 ]; then
    step "7/7" "关闭自动更新"
    if [ -f "$UPDATE_TIMER" ]; then
      systemctl disable --now dsh-mizar-relay-update.timer >/dev/null 2>&1 || true
    fi
    rm -f "$UPDATE_TIMER" "$UPDATE_SERVICE"
    systemctl daemon-reload || true
    say "未安装自动更新 timer（--no-auto-update）"
    AUTO_STATUS="关闭（--no-auto-update）"
    return 0
  fi
  step "7/7" "安装每日自动更新 timer"
  cat > "$UPDATE_SERVICE" <<UNIT
[Unit]
Description=DSH-Mizar relay updater
Documentation=file://$TARGET/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $TARGET/update.sh --apply --auto
Nice=10
UNIT
  cat > "$UPDATE_TIMER" <<UNIT
[Unit]
Description=Daily DSH-Mizar relay update check

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=3600
Persistent=true
Unit=dsh-mizar-relay-update.service

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  if systemctl enable --now dsh-mizar-relay-update.timer >/dev/null 2>&1; then
    say "已启用 dsh-mizar-relay-update.timer（每天 03:00 左右，随机延迟最多 1 小时）"
    AUTO_STATUS="每天 03:00（随机延迟最多 1 小时）"
  else
    say "警告：timer 启用失败，自动更新未生效；可手动运行 $TARGET/update.sh --apply"
    AUTO_STATUS="安装失败（检查 systemctl status dsh-mizar-relay-update.timer）"
  fi
}

json_field() {
  "$NODE_BIN" -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(input); } catch { process.exit(2); }
      const value = parsed[process.argv[1]];
      process.stdout.write(value === null || value === undefined ? "" : String(value));
    });
  ' "$1"
}

print_summary() {
  cat <<SUMMARY

$(printf '=%.0s' {1..54})
  DSH-Mizar 自建服务器安装完成
$(printf '=%.0s' {1..54})

  域名        $PUBLIC_ORIGIN
  安装目录    $TARGET
  Node        $NODE_VERSION  ($NODE_BIN)
  HTTPS       $TLS_STATUS
  自动更新    $AUTO_STATUS

  教程页      $PUBLIC_ORIGIN/
              第一次打开需要下面的 PIN；页面可查看状态、在线电脑和更新。
SUMMARY
  if [ "$PIN_ROTATED" = "true" ]; then
    printf '\n  服务器 PIN  %s   ← 只显示这一次，请现在保存\n' "$PIN_NEW"
  else
    printf '\n  服务器 PIN  沿用已有（没有重新生成）\n'
    printf '              忘记的话：sudo %s/install.sh --rotate-pin\n' "$TARGET"
  fi
  if [ "$TOKEN_ROTATED" = "true" ]; then
    printf '  更新 token  %s   ← 只显示这一次，请现在保存\n' "$TOKEN_NEW"
  else
    printf '  更新 token  沿用已有（没有重新生成）\n'
    printf '              忘记的话：sudo %s/install.sh --rotate-update-token\n' "$TARGET"
  fi
  cat <<SUMMARY

  日志        journalctl -u dsh-mizar-relay -f
  重启        systemctl restart dsh-mizar-relay
  检查更新    sudo $TARGET/update.sh --check
  手动更新    sudo $TARGET/update.sh --apply
  自动更新    systemctl list-timers dsh-mizar-relay-update.timer
  换 PIN      sudo $TARGET/install.sh --rotate-pin
  换 token    sudo $TARGET/install.sh --rotate-update-token

  回滚到上一版（update.sh 失败时会自动做；首次更新后才有 app.previous）：
    sudo systemctl stop dsh-mizar-relay
    sudo rm -rf $TARGET/lib $TARGET/node_modules
    sudo cp -a $TARGET/app.previous/lib $TARGET/app.previous/node_modules $TARGET/
    sudo cp -a $TARGET/app.previous/package.json $TARGET/app.previous/selftest.js $TARGET/
    sudo systemctl start dsh-mizar-relay
SUMMARY
  if [ "$BEHIND_PROXY" -eq 1 ]; then
    printf '\n  反代：把 %s/nginx-websocket.conf 粘进站点的 location，目标 http://127.0.0.1:8787。\n' "$TARGET"
  fi
  if [ "$NO_TLS" -eq 1 ]; then
    printf '\n  注意：中继仍只监听 127.0.0.1:8787，--no-tls 只表示不装 Caddy；\n'
    printf '        如需从别的机器访问，请自行配反代，或把 relay.config.json 的 host 改成 0.0.0.0。\n'
  fi
  printf '\n'
}

rotate_secret() {
  [ "$(id -u)" -eq 0 ] || fail "轮换密钥需要 root：请用 sudo 运行。"
  [ -f "$TARGET/relay.config.json" ] || fail "找不到 $TARGET/relay.config.json。
  请在安装目录里运行（例如 cd /opt/dsh-mizar-relay && sudo ./install.sh --rotate-pin），
  或加 --dir <安装目录>。"
  [ -f "$TARGET/lib/selfhost/cli.js" ] || fail "找不到 $TARGET/lib/selfhost/cli.js；请重新解包 release 或重新安装。"
  NODE_BIN="$(find_node || true)"
  [ -n "$NODE_BIN" ] || fail "找不到 node。请安装 Node 20+ 后重试。"
  [ "$(node_major_of "$NODE_BIN")" -ge 20 ] || fail "$NODE_BIN 版本太旧，需要 Node 20+。"
  if ! ROTATE_JSON="$("$NODE_BIN" "$TARGET/lib/selfhost/cli.js" rotate \
      --config "$TARGET/relay.config.json" "--$ROTATE")"; then
    fail "轮换失败。可能这个 relay.config.json 还没有 selfHost 块——先带 --domain 安装一次。"
  fi
  if [ "$ROTATE" = pin ]; then
    NEW_PIN="$(printf '%s' "$ROTATE_JSON" | json_field pin)" || fail "无法解析 CLI 输出"
    [ -n "$NEW_PIN" ] || fail "CLI 没有返回新的 PIN"
    printf '\n  新的服务器 PIN：%s\n  只显示这一次；所有客户端都要重新填。\n\n' "$NEW_PIN"
  else
    NEW_TOKEN="$(printf '%s' "$ROTATE_JSON" | json_field updateToken)" || fail "无法解析 CLI 输出"
    [ -n "$NEW_TOKEN" ] || fail "CLI 没有返回新的更新 token"
    printf '\n  新的更新 token：%s\n  只显示这一次；教程页里要重新填。\n\n' "$NEW_TOKEN"
  fi
  if systemctl restart dsh-mizar-relay; then
    say "服务已重启，新值已生效。"
  else
    fail "配置已写入，但服务重启失败；检查 journalctl -u dsh-mizar-relay -n 40"
  fi
}

install_selfhost() {
  [ "$(id -u)" -eq 0 ] || fail "自建模式需要 root：请用 sudo 运行。"
  command -v systemctl >/dev/null 2>&1 || fail "找不到 systemctl；本安装器要求 systemd（Debian/Ubuntu/CentOS）。"
  [ -d /etc/systemd/system ] || fail "找不到 /etc/systemd/system；本安装器要求 systemd（Debian/Ubuntu/CentOS）。"
  command -v curl >/dev/null 2>&1 || fail "找不到 curl；安装 Node/Caddy 和更新器都需要它。"
  command -v tar >/dev/null 2>&1 || fail "找不到 tar；安装 Node/Caddy 需要它。"
  if [ "$TARGET" = "$HERE" ]; then
    fail "安装目录不能是解包目录本身。请用 --dir 指定目标目录（默认 /opt/dsh-mizar-relay）。"
  fi

  DOMAIN="$(normalise_domain "$DOMAIN")"
  validate_domain
  if [ -n "$EMAIL" ]; then validate_email; fi
  if [ "$NO_TLS" -eq 1 ]; then
    PUBLIC_ORIGIN="http://$DOMAIN"
  else
    PUBLIC_ORIGIN="https://$DOMAIN"
  fi

  printf '\nDSH-Mizar relay installer · 自建模式\n%s\n\n' "$(printf '=%.0s' {1..40})"
  say "域名              $DOMAIN"
  say "公开地址          $PUBLIC_ORIGIN"
  say "安装目录          $TARGET"
  if [ "$AUTO_UPDATE" -eq 1 ]; then AUTO_LABEL=开启; else AUTO_LABEL=关闭; fi
  say "自动更新          $AUTO_LABEL"

  mkdir -p "$TARGET" || fail "无法创建安装目录 $TARGET"
  case "$TARGET" in
    /home/*|/root/*)
      say "警告：systemd unit 使用 ProtectHome=true，$TARGET 在 home 目录下可能无法读取；建议改到 /opt 或 /srv。" ;;
  esac

  # 1. Node ------------------------------------------------------------------
  step "1/7" "检查 Node.js（需要 20+）"
  NODE_BIN="$(find_node || true)"
  if [ -n "$NODE_BIN" ] && [ "$(node_major_of "$NODE_BIN")" -ge 20 ]; then
    say "使用已有 Node：$NODE_BIN ($("$NODE_BIN" -v))"
  else
    if [ -n "$NODE_BIN" ]; then
      say "找到的 Node 太旧：$NODE_BIN ($("$NODE_BIN" -v 2>/dev/null || echo unknown))"
    fi
    if is_musl; then
      fail "检测到 Alpine/musl。官方 Node Linux 二进制依赖 glibc，不能直接用。
  请先安装 Node 20+：
    apk add --no-cache nodejs npm
  或换一台 glibc 的 Debian/Ubuntu/CentOS 服务器，然后重跑安装器。"
    fi
    say "未找到可用的 Node 20+，下载官方 LTS 到 $TARGET/runtime …"
    download_node
  fi
  [ -x "$NODE_BIN" ] || fail "Node 路径不可执行：$NODE_BIN"
  [ "$(node_major_of "$NODE_BIN")" -ge 20 ] || fail "$NODE_BIN 版本太旧，需要 Node 20+。"
  NODE_VERSION="$("$NODE_BIN" -v)"

  # 2. copy ------------------------------------------------------------------
  step "2/7" "复制服务端到 $TARGET"
  [ -f "$HERE/app/lib/index.js" ] || fail "bundle 缺少 app/lib/index.js；请用 get.sh 下载完整 release，或解包后在本目录运行 install.sh。"
  [ -d "$HERE/app/node_modules/ws" ] || fail "bundle 缺少 app/node_modules/ws；请重新下载 release。"
  [ -f "$HERE/app/package.json" ] || fail "bundle 缺少 app/package.json；请重新下载 release。"
  [ -f "$HERE/app/selftest.js" ] || fail "bundle 缺少 app/selftest.js；请重新下载 release。"
  [ -f "$HERE/update.sh" ] || fail "bundle 缺少 update.sh；请用 0.5.0 或更新的 release。"
  for entry in "$HERE"/app/*; do
    name="$(basename "$entry")"
    if [ "$name" = "relay.config.json" ]; then continue; fi
    cp -R "$entry" "$TARGET/" || fail "复制 $name 失败"
  done
  cp "$HERE/update.sh" "$TARGET/update.sh" || fail "复制 update.sh 失败"
  chmod +x "$TARGET/update.sh" || fail "无法给 $TARGET/update.sh 加执行权限"
  cp "$HERE/install.sh" "$TARGET/install.sh" || fail "复制 install.sh 失败"
  chmod +x "$TARGET/install.sh" || fail "无法给 $TARGET/install.sh 加执行权限"
  if [ -f "$HERE/README.md" ]; then cp "$HERE/README.md" "$TARGET/README.md" || say "警告：无法复制 README.md"; fi
  if [ -f "$HERE/nginx-websocket.conf" ]; then cp "$HERE/nginx-websocket.conf" "$TARGET/nginx-websocket.conf" || say "警告：无法复制 nginx-websocket.conf"; fi
  say "已复制服务端、update.sh、install.sh"

  # 3. config ----------------------------------------------------------------
  step "3/7" "准备 relay.config.json"
  CONFIG="$TARGET/relay.config.json"
  if [ ! -f "$CONFIG" ]; then
    cat > "$CONFIG" <<'CONFIG_JSON'
{
  "port": 8787,
  "host": "127.0.0.1",
  "tokens": [],
  "trustProxy": true,
  "role": 0,
  "accounts": null,
  "abuse": {
    "requestsPerMinute": 0,
    "bytesPerDay": 0,
    "requestsPerMinutePerIp": 600,
    "bytesPerDayPerIp": 0
  }
}
CONFIG_JSON
    say "已写入基础配置（无账户、无总量额度，保留每 IP 600 请求/分钟）"
  else
    say "保留已有 relay.config.json（基础字段不动）"
  fi
  chmod 600 "$CONFIG" || fail "无法把 $CONFIG 设为 600"
  DATA_DIR="$TARGET/data"
  mkdir -p "$DATA_DIR" || fail "无法创建 $DATA_DIR"
  chmod 700 "$DATA_DIR" || fail "无法把 $DATA_DIR 设为 700"

  # 4. selfHost secrets ------------------------------------------------------
  step "4/7" "生成/沿用服务器 PIN 与更新 token"
  CLI="$TARGET/lib/selfhost/cli.js"
  [ -f "$CLI" ] || fail "找不到 ${CLI}；这个 release 不含自建模式（需要 0.5.0+）。"
  AUTO_UPDATE_STR=false
  if [ "$AUTO_UPDATE" -eq 1 ]; then AUTO_UPDATE_STR=true; fi
  INIT_ARGS=(init --config "$CONFIG" --domain "$PUBLIC_ORIGIN" --data-dir "$DATA_DIR" \
    --update-script "$TARGET/update.sh" --auto-update "$AUTO_UPDATE_STR")
  if [ -n "$PIN_ARG" ]; then INIT_ARGS+=(--pin "$PIN_ARG"); fi
  if ! INIT_JSON="$("$NODE_BIN" "$CLI" "${INIT_ARGS[@]}")"; then
    fail "生成 selfHost 配置失败。检查 $CONFIG 是否是合法 JSON，然后重跑。"
  fi
  PIN_NEW="$(printf '%s' "$INIT_JSON" | json_field pin)" || fail "无法解析 CLI 输出"
  TOKEN_NEW="$(printf '%s' "$INIT_JSON" | json_field updateToken)" || fail "无法解析 CLI 输出"
  PIN_ROTATED="$(printf '%s' "$INIT_JSON" | json_field pinRotated)" || fail "无法解析 CLI 输出"
  TOKEN_ROTATED="$(printf '%s' "$INIT_JSON" | json_field updateTokenRotated)" || fail "无法解析 CLI 输出"
  if [ "$PIN_ROTATED" = "true" ] && [ -z "$PIN_NEW" ]; then fail "CLI 没有返回新 PIN"; fi
  if [ "$TOKEN_ROTATED" = "true" ] && [ -z "$TOKEN_NEW" ]; then fail "CLI 没有返回新更新 token"; fi
  if [ "$PIN_ROTATED" = "true" ]; then
    say "已生成新的服务器 PIN（明文只在最后显示一次）"
  else
    say "沿用已有服务器 PIN（没有重新生成）"
  fi
  if [ "$TOKEN_ROTATED" = "true" ]; then
    say "已生成新的更新 token（明文只在最后显示一次）"
  else
    say "沿用已有更新 token（没有重新生成）"
  fi

  # 5. systemd ---------------------------------------------------------------
  step "5/7" "写入 systemd 服务并启动"
  cat > "$SERVICE" <<UNIT
[Unit]
Description=DSH-Mizar relay — a reverse tunnel for the DSH-Mizar iOS app
Documentation=file://$TARGET/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$TARGET
ExecStart=$NODE_BIN $TARGET/lib/index.js
Restart=always
RestartSec=3
User=root

# The relay listens on loopback and opens outbound connections. The account
# service writes only its data directory; everything else stays read-only.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/
ReadWritePaths=$TARGET/data

[Install]
WantedBy=multi-user.target
UNIT
  say "已写入 $SERVICE"
  systemctl daemon-reload
  systemctl enable dsh-mizar-relay >/dev/null 2>&1 || fail "systemd 无法 enable dsh-mizar-relay"
  systemctl restart dsh-mizar-relay || fail "systemd 无法启动服务。检查：journalctl -u dsh-mizar-relay -n 40"
  sleep 1
  systemctl is-active --quiet dsh-mizar-relay || fail "服务没有保持运行。检查：journalctl -u dsh-mizar-relay -n 40"
  HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:8787/healthz)" || fail "服务在跑，但本地 /healthz 不应答。检查：journalctl -u dsh-mizar-relay -n 40"
  case "$HEALTH" in
    *'"product":"dsh-mizar-relay"'*) ;;
    *) fail "/healthz 没有返回 product=dsh-mizar-relay，可能有别的程序占用了 8787。" ;;
  esac
  case "$HEALTH" in
    *'"selfHost":true'*) ;;
    *) fail "/healthz 没有报告 selfHost=true；selfHost 配置没有生效，检查 ${CONFIG}。" ;;
  esac
  say "本地 http://127.0.0.1:8787/healthz 通过（自建模式已生效）"

  # 6. TLS -------------------------------------------------------------------
  TLS_STATUS="未配置"
  install_tls

  # 7. auto update -----------------------------------------------------------
  AUTO_STATUS="未配置"
  install_update_units

  print_summary
}

# --- original BaoTa/nginx mode ----------------------------------------------

install_legacy() {
  printf '\nDSH-Mizar relay installer\n%s\n\n' "$(printf '=%.0s' {1..40})"

  NODE_BIN="$(find_node)" || fail "$(cat <<'WHY'
No node binary was found. Checked, in order:

  1. whatever is on this shell's PATH
  2. /www/server/nodejs/*/bin/node      (where BaoTa installs it)
  3. /usr/local/bin, /usr/bin, /opt/node/bin, /snap/bin
  4. ~/.nvm/versions/node/*/bin/node and /root/.nvm/...

If BaoTa says Node is installed, find it and pass it in:

    ls -d /www/server/nodejs/*/bin/node

To install Node, use BaoTa's app store (软件商店 -> Node.js 版本管理器),
or any other method. Anything from 20 upwards works.
WHY
)"

  NODE_VERSION="$("$NODE_BIN" -v)"
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || fail "$NODE_BIN is $NODE_VERSION, which is too old; this needs Node 20 or newer."

  [ -f "$HERE/app/relay.config.json" ] || fail "app/relay.config.json is missing from the bundle."
  [ -d "$HERE/app/node_modules/ws" ]   || fail "app/node_modules/ws is missing; re-download the bundle."

  if [ "$(id -u)" -ne 0 ]; then
    fail "run this with sudo — it writes $SERVICE"
  fi

  say "node              $NODE_VERSION"
  say "node binary       $NODE_BIN"
  say "install dir       $TARGET"
  say "service           $SERVICE"
  printf '\n'

  # --- copy -----------------------------------------------------------------
  #
  # Everything except the config. Re-running this installer is how an upgrade is
  # applied, and a blanket copy would put the shipped placeholder over the token
  # the computer is already paired against -- which looks like the relay breaking
  # rather than the installer having clobbered a credential.
  mkdir -p "$TARGET"
  for entry in "$HERE"/app/*; do
    name="$(basename "$entry")"
    if [ "$name" = "relay.config.json" ]; then continue; fi
    cp -R "$entry" "$TARGET/"
  done
  NEW_CONFIG=0
  if [ -f "$TARGET/relay.config.json" ]; then
    say "copied the server to $TARGET (kept the existing relay.config.json)"
  else
    cp "$HERE/app/relay.config.json" "$TARGET/"
    NEW_CONFIG=1
    say "copied the server to $TARGET"
  fi

  chmod 600 "$TARGET/relay.config.json"

  # --- data directory -------------------------------------------------------
  #
  # accounts.json, invites.json, traffic.json and audit.log live here. The systemd
  # unit's ProtectSystem=strict makes everything else read-only, so this one path
  # is the only writable place the service has.
  DATA_DIR="$TARGET/data"
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"

  # --- account service ------------------------------------------------------
  #
  # A fresh role=1 install needs three secrets nobody should have to hand-write:
  # the admin password/hash, the relay-to-relay report secret, and the App Store
  # product id. They are generated here, printed once, and written into the
  # root-only config. A re-run keeps the existing config: changing the admin
  # password or the report secret is an explicit operation, not an upgrade side
  # effect.
  if [ "$NEW_CONFIG" -eq 1 ]; then
    ROLE="${MIZAR_ROLE:-0}"
    case "$ROLE" in
      0|1) ;;
      *) fail "MIZAR_ROLE must be 0 (free) or 1 (paid/account), got '$ROLE'" ;;
    esac
    if [ "$ROLE" = "1" ]; then
      SECRET_JSON="$("$NODE_BIN" "$TARGET/lib/accounts/cli.js" admin-secret)"
      ADMIN_PASSWORD="$(printf '%s' "$SECRET_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).password))')"
      ADMIN_HASH="$(printf '%s' "$SECRET_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hash))')"
      INTERNAL_SECRET="${MIZAR_ACCOUNT_INTERNAL_SECRET:-$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')}"
      PUBLIC_BASE_URL="${MIZAR_PUBLIC_BASE_URL:-https://dshmizar-1.shirazu-nagisa.com}"
      APPSTORE_PRODUCT_ID="${MIZAR_APPSTORE_PRODUCT_ID:-me.shirazu.dshmizar.paid.monthly}"
      GRAVATAR_URLS="${MIZAR_GRAVATAR_BASE_URLS:-https://gravatar.loli.net,https://cn.cravatar.com,https://www.gravatar.com}"
      "$NODE_BIN" "$TARGET/lib/accounts/cli.js" configure       --config "$TARGET/relay.config.json"       --role 1       --enable-accounts       --data-dir "$DATA_DIR"       --admin-password-hash "$ADMIN_HASH"       --internal-secret "$INTERNAL_SECRET"       --report-id "${MIZAR_ACCOUNT_REPORT_ID:-primary-1}"       --public-base-url "$PUBLIC_BASE_URL"       --product-id "$APPSTORE_PRODUCT_ID"       --gravatar-base-urls "$GRAVATAR_URLS" >/dev/null
      say "account service enabled (role=1)"
      printf '
  ┌──────────────────────────────────────────────────────────────┐
'
      printf '  │  ADMIN PASSWORD (shown once, save it now):                   │
'
      printf '  │  %-60s│
' "$ADMIN_PASSWORD"
      printf '  └──────────────────────────────────────────────────────────────┘

'
      printf '  Internal report secret: %s

' "$INTERNAL_SECRET"
    else
      REPORT_TO="${MIZAR_ACCOUNT_REPORT_TO:-}"
      INTERNAL_SECRET="${MIZAR_ACCOUNT_INTERNAL_SECRET:-}"
      ARGS=(--config "$TARGET/relay.config.json" --role 0 --disable-accounts --data-dir "$DATA_DIR" --report-id "${MIZAR_ACCOUNT_REPORT_ID:-primary-0}")
      [ -n "$REPORT_TO" ] && ARGS+=(--report-to "$REPORT_TO")
      [ -n "$INTERNAL_SECRET" ] && ARGS+=(--internal-secret "$INTERNAL_SECRET")
      "$NODE_BIN" "$TARGET/lib/accounts/cli.js" configure "${ARGS[@]}" >/dev/null
      say "free relay configured (role=0, accounts off)"
      if [ -n "$REPORT_TO" ]; then say "traffic will be reported to $REPORT_TO"; fi
    fi
  else
    say "existing relay.config.json kept; role/accounts were not changed"
    if [ "${MIZAR_ROLE:-}" = "1" ]; then
      say "to enable accounts: generate a password with"
      say "  $NODE_BIN $TARGET/lib/accounts/cli.js admin-secret"
      say "then merge the hash with:"
      say "  $NODE_BIN $TARGET/lib/accounts/cli.js configure --config $TARGET/relay.config.json --role 1 --enable-accounts --data-dir $DATA_DIR --admin-password-hash '<hash>' --internal-secret '<secret>' --report-id primary-1 --public-base-url https://dshmizar-1.shirazu-nagisa.com"
    fi
  fi
  chmod 600 "$TARGET/relay.config.json"

  # --- token ----------------------------------------------------------------
  #
  # Generated here rather than shipped. A token baked into a downloadable bundle
  # is the same token on every server that bundle reaches, which makes it a
  # default credential in the way that matters -- and this bundle's was known
  # before its domain existed.
  #
  # Re-running the installer leaves an existing token alone, so an upgrade does not
  # silently invalidate the computer that is already paired against it.
  say "relay.config.json is root-only"

  # --- systemd --------------------------------------------------------------
  cat > "$SERVICE" <<UNIT
[Unit]
Description=DSH-Mizar relay — a reverse tunnel for the DSH-Mizar iOS app
Documentation=file://$TARGET/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$TARGET
ExecStart=$NODE_BIN $TARGET/lib/index.js
Restart=always
RestartSec=3
User=root

# The relay listens on loopback and opens outbound connections. The account
# service writes only its data directory; everything else stays read-only.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
  say "wrote $SERVICE (ExecStart uses $NODE_BIN)"

  systemctl daemon-reload
  # `enable --now` starts a stopped service but leaves a running one running, so
  # an upgrade would keep the old build in memory until the next reboot. This
  # installer doubles as the upgrade path ("Re-running this installer is how an
  # upgrade is applied" above), so restart unconditionally.
  systemctl enable dsh-mizar-relay >/dev/null 2>&1 || fail "systemd could not enable the service"
  systemctl restart dsh-mizar-relay || fail "systemd could not start the service. Check: journalctl -u dsh-mizar-relay -n 40"
  sleep 1

  if systemctl is-active --quiet dsh-mizar-relay; then
    say "service is running"
  else
    fail "the service did not stay up. Check: journalctl -u dsh-mizar-relay -n 40"
  fi

  # --- prove it answers -----------------------------------------------------
  if curl -fsS --max-time 5 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    say "http://127.0.0.1:8787/healthz answers"
  else
    printf '\n'
    fail "the service is up but /healthz does not answer. Check: journalctl -u dsh-mizar-relay -n 40"
  fi

  cat <<DONE

$(printf '=%.0s' {1..40})

  The relay is running. Three things are left, and they are all in BaoTa.

  1. Websites -> Add site, with the domain you want to use.
     Point the domain's DNS at this server first.

  2. SSL -> Let's Encrypt -> apply, then turn on "Force HTTPS".

  3. Reverse proxy -> target http://127.0.0.1:8787
     Then paste the block from nginx-websocket.conf into the site's config.
     Without it the WebSocket handshake is stripped and nothing connects.

  Then put this in the DSH-Mizar plugin's config on your computer:

    relay:
      url: "https://<your-domain>"

  Restart DSH. The panel will show the pairing address to scan.

  Logs:  journalctl -u dsh-mizar-relay -f
  Stop:  systemctl stop dsh-mizar-relay

  Account service (role=1 only):

    https://<your-domain>/admin
    https://<your-domain>/account/v1/*

  The admin password was printed above if this was a fresh role=1 install.
  It is stored only as a scrypt hash in relay.config.json (mode 600).
  For the free relay, set MIZAR_ACCOUNT_REPORT_TO and the same
  MIZAR_ACCOUNT_INTERNAL_SECRET before installing an existing config, or edit
  the accounts block with \`lib/accounts/cli.js configure\`.

DONE

  cat <<'HINT'

  一条命令安装（自建域名 + 自动 HTTPS + 自动更新）：
    curl -fsSL https://raw.githubusercontent.com/ShirazuNagisa/DSH-Mizar-Relay/main/deploy/get.sh \
      | sudo bash -s -- --domain relay.example.com

  自建模式会把中继装到 /opt/dsh-mizar-relay，不需要在宝塔里配站点。

HINT
}

# --- dispatch ---------------------------------------------------------------

if [ -n "$ROTATE" ]; then
  rotate_secret
  exit 0
fi

if [ -z "$DOMAIN" ]; then
  install_legacy
  exit 0
fi

install_selfhost
