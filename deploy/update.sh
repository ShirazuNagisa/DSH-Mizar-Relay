#!/usr/bin/env bash
#
# Update the DSH-Mizar relay from a published GitHub release.
#
# The setup page and the daily timer both call this script. It downloads the
# tarball and SHA256SUMS for the latest release, verifies the checksum, backs up
# the running version to app.previous/, stops the service, replaces only the
# program files, starts the service again and waits for /healthz. If anything
# after the stop fails, the previous version is put back automatically.
#
# `relay.config.json` and data/ are never touched: they are the identity of this
# installation, not part of a release.
#
# Usage:  update.sh [--apply] [--check] [--force] [--auto]
#
#   --apply   download and install the latest release (the default)
#   --check   print one JSON line and exit; nothing is installed
#   --force   install even when the latest version is the installed one
#   --auto    no progress output; the state file is the report (timer mode)
#
# Environment:
#   MIZAR_UPDATE_REPO      owner/name of the GitHub repository
#   MIZAR_UPDATE_DIR       installation directory (default: this script's dir)
#   MIZAR_UPDATE_DATA_DIR  directory holding update-state.json (default: DIR/data)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${MIZAR_UPDATE_DIR:-$HERE}"
REPO="${MIZAR_UPDATE_REPO:-ShirazuNagisa/DSH-Mizar-Relay}"
DATA_DIR="${MIZAR_UPDATE_DATA_DIR:-$DIR/data}"

MODE=apply
FORCE=0
AUTO=0
DL_ROOT=''

say() {
  if [ "$AUTO" -eq 1 ]; then return 0; fi
  printf '  %s\n' "$*"
}
err() { printf '  ✗ %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

usage() {
  cat <<'USAGE'
用法：update.sh [--apply] [--check] [--force] [--auto]

  --apply   下载并安装最新 release（默认）
  --check   只检查，输出一行 JSON：{"current":...,"latest":...,"updateAvailable":...}
  --force   即使已是最新版本也重新安装
  --auto    静默模式（定时器用），进度写进 data/update-state.json

环境变量：
  MIZAR_UPDATE_REPO       GitHub 仓库，默认 ShirazuNagisa/DSH-Mizar-Relay
  MIZAR_UPDATE_DIR        安装目录，默认脚本所在目录
  MIZAR_UPDATE_DATA_DIR   状态文件目录，默认 $MIZAR_UPDATE_DIR/data
USAGE
}

cleanup() {
  if [ -n "${DL_ROOT:-}" ]; then
    rm -rf "$DL_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) MODE=apply; shift ;;
    --check) MODE=check; shift ;;
    --force) FORCE=1; shift ;;
    --auto) AUTO=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# --check promises stdout is one JSON line, so suppress progress in that mode.
if [ "$MODE" = check ]; then AUTO=1; fi

case "$REPO" in
  */*) ;;
  *) die "MIZAR_UPDATE_REPO 必须是 owner/name，当前是 '$REPO'" ;;
esac
case "$REPO" in
  *[!A-Za-z0-9._/-]*) die "MIZAR_UPDATE_REPO 含有不支持的字符：'$REPO'" ;;
esac

case "$DIR" in
  /*) ;;
  *) DIR="$PWD/$DIR" ;;
esac
DIR="$(cd "$DIR" 2>/dev/null && pwd -P)" || die "安装目录不存在：$DIR"
[ "$DIR" != "/" ] || die "MIZAR_UPDATE_DIR 不能是 /"
[ "$DATA_DIR" != "/" ] || die "MIZAR_UPDATE_DATA_DIR 不能是 /"

[ -d "$DIR" ] || die "安装目录不存在：$DIR"
[ -f "$DIR/package.json" ] || die "找不到 $DIR/package.json；这里不是中继安装目录"

command -v curl >/dev/null 2>&1 || die "找不到 curl，无法检查/下载更新"

# --- node (optional) ---------------------------------------------------------
#
# The installed version lives in package.json. Node reads it when available,
# including the runtime the self-host installer may have put under DIR/runtime.
# A missing Node is not fatal here: the updater itself is shell, and the sed
# fallback below reads the same field.
find_node() {
  local candidate
  for candidate in $(ls -d "$DIR"/runtime/node-v*/bin/node 2>/dev/null | sort -Vr); do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /www/server/nodejs/*/bin/node /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

read_version() {
  local node_bin='' version=''
  node_bin="$(find_node || true)"
  if [ -n "$node_bin" ]; then
    version="$("$node_bin" -e '
      const fs = require("node:fs");
      try {
        process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version || ""));
      } catch {
        process.exit(2);
      }
    ' "$DIR/package.json" 2>/dev/null || true)"
  fi
  if [ -z "$version" ]; then
    version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -n 1)"
  fi
  printf '%s' "$version"
}

# --- versions ----------------------------------------------------------------

is_version() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'
}

version_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "[.+-]");
    m = split(b, y, "[.+-]");
    for (i = 1; i <= 3; i++) {
      av = (i <= n ? x[i] + 0 : 0);
      bv = (i <= m ? y[i] + 0 : 0);
      if (av > bv) exit 0;
      if (av < bv) exit 1;
    }
    exit 1;
  }'
}

# Ask GitHub for the latest release tag. The API is tried first; a rate-limited
# or otherwise unhappy API falls back to the redirect of /releases/latest, which
# needs no token and no JSON parser.
resolve_latest() {
  local json='' tag='' location=''
  json="$(curl -fsSL --connect-timeout 10 --max-time 30 \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: dsh-mizar-relay-updater' \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" \
    | grep -o '"tag_name": *"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*"([^"]*)"$/\1/' || true)"
  if [ -z "$tag" ]; then
    location="$(curl -fsSI --connect-timeout 10 --max-time 30 \
      -H 'User-Agent: dsh-mizar-relay-updater' \
      "https://github.com/$REPO/releases/latest" 2>/dev/null \
      | tr -d '\r' \
      | awk 'tolower($1) == "location:" { print $2; exit }' || true)"
    if [ -n "$location" ]; then
      location="${location%%\?*}"
      tag="${location##*/}"
    fi
  fi
  tag="${tag#v}"
  tag="${tag#V}"
  is_version "$tag" || return 1
  printf '%s' "$tag"
}

# --- state file --------------------------------------------------------------

now_ms() {
  local ms=''
  ms="$(date +%s%3N 2>/dev/null || true)"
  case "$ms" in
    ''|*[!0-9]*) printf '%s000' "$(date +%s)" ;;
    *) printf '%s' "$ms" ;;
  esac
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

write_state() {
  local state="$1" current="$2" latest="$3" error="${4:-}"
  local tmp="$DATA_DIR/.update-state.$$.tmp"
  mkdir -p "$DATA_DIR" || return 1
  if ! printf '{"state":"%s","current":"%s","latest":"%s","error":"%s","updatedAt":%s}\n' \
    "$(json_escape "$state")" \
    "$(json_escape "$current")" \
    "$(json_escape "$latest")" \
    "$(json_escape "$error")" \
    "$(now_ms)" > "$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  chmod 600 "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$DATA_DIR/update-state.json"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
}

write_state_or_die() {
  if ! write_state "$@"; then
    die "无法写入 $DATA_DIR/update-state.json（目录或权限有问题）"
  fi
}

# --- health and rollback -----------------------------------------------------

# The relay's own listen port, read from the live config. It is 8787 on every
# bundle this updater ships with, but a deployment that moved it should not have
# every update roll back because the health check was looking somewhere else.
read_port() {
  local node_bin='' port=''
  node_bin="$(find_node || true)"
  if [ -n "$node_bin" ]; then
    port="$("$node_bin" -e '
      const fs = require("node:fs");
      try {
        const value = Number(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).port);
        if (Number.isFinite(value) && value > 0) process.stdout.write(String(Math.floor(value)));
      } catch {}
    ' "$DIR/relay.config.json" 2>/dev/null || true)"
  fi
  if [ -z "$port" ]; then
    port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/relay.config.json" 2>/dev/null | head -n 1)"
  fi
  printf '%s' "${port:-8787}"
}

PORT="$(read_port)"
case "$PORT" in
  ''|*[!0-9]*) PORT=8787 ;;
esac

# One health answer, and -- when a version is expected -- proof that the process
# answering is the one this run installed rather than a stale listener.
health_ok() {
  local expected="${1:-}" body=''
  body="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
  [ -n "$body" ] || return 1
  case "$body" in
    *'"product":"dsh-mizar-relay"'*) ;;
    *) return 1 ;;
  esac
  if [ -n "$expected" ]; then
    case "$body" in
      *"\"relayVersion\":\"$expected\""*) ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

wait_health() {
  local expected="${1:-}" attempt=0
  while [ "$attempt" -lt 15 ]; do
    if health_ok "$expected"; then
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -lt 15 ]; then sleep 2; fi
  done
  return 1
}

restore_previous() {
  local reason="$1" item
  err "更新失败：${reason}；正在从 $DIR/app.previous 回滚"
  for item in lib node_modules package.json selftest.js install.sh update.sh; do
    rm -rf "$DIR/$item" 2>/dev/null || true
    if [ -e "$DIR/app.previous/$item" ]; then
      if ! cp -a "$DIR/app.previous/$item" "$DIR/"; then
        err "回滚 $item 失败"
      fi
    fi
  done
  if systemctl start dsh-mizar-relay; then
    if wait_health; then
      err "已回滚到 ${CURRENT}，服务恢复"
    else
      err "已回滚到 ${CURRENT}，但 /healthz 仍未恢复；查看 journalctl -u dsh-mizar-relay -n 80"
    fi
  else
    err "回滚后服务仍无法启动；查看 journalctl -u dsh-mizar-relay -n 80"
  fi
  write_state failed "$CURRENT" "$LATEST" "${reason}（已回滚）" || true
}

fail_update() {
  local message="$1"
  err "$message"
  write_state failed "$CURRENT" "$LATEST" "$message" || true
  exit 1
}

# --- main --------------------------------------------------------------------

CURRENT="$(read_version)"
[ -n "$CURRENT" ] || die "无法从 $DIR/package.json 读取版本"
is_version "$CURRENT" || die "package.json 里的版本号不合法：$CURRENT"
say "当前版本：$CURRENT"

if [ "$MODE" = apply ]; then
  command -v systemctl >/dev/null 2>&1 || die "找不到 systemctl；这个更新器只支持 systemd 安装"
  command -v tar >/dev/null 2>&1 || die "找不到 tar，无法解包更新"
  LOCK="$DIR/.update.lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK" || die "无法创建锁文件 $LOCK"
    if ! flock -n 9; then
      say "另一个更新正在进行，本次退出"
      exit 0
    fi
  else
    say "提示：系统没有 flock，跳过并发保护"
  fi
fi

if ! LATEST="$(resolve_latest)"; then
  if [ "$MODE" = apply ]; then
    write_state failed "$CURRENT" '' '无法从 GitHub 解析最新版本' || true
  fi
  die "无法从 GitHub 解析最新版本。请检查网络；也可以稍后手动重试。"
fi
say "最新版本：$LATEST"

AVAILABLE=0
if [ "$FORCE" -eq 1 ] || version_gt "$LATEST" "$CURRENT"; then
  AVAILABLE=1
fi

if [ "$MODE" = check ]; then
  if [ "$AVAILABLE" -eq 1 ]; then
    printf '{"current":"%s","latest":"%s","updateAvailable":true}\n' "$CURRENT" "$LATEST"
  else
    printf '{"current":"%s","latest":"%s","updateAvailable":false}\n' "$CURRENT" "$LATEST"
  fi
  exit 0
fi

if [ "$AVAILABLE" -eq 0 ]; then
  say "已是最新版本（${CURRENT}）"
  write_state_or_die idle "$CURRENT" "$LATEST" ''
  exit 0
fi

BASE_URL="https://github.com/$REPO/releases/download/v$LATEST"
TARBALL="dsh-mizar-relay-$LATEST.tar.gz"
DL_ROOT="$DIR/.update"
DL="$DL_ROOT/$LATEST"
EXTRACT="$DL/extract"
APP_SRC="$EXTRACT/dsh-mizar-relay-$LATEST/app"

say "准备更新：$CURRENT → $LATEST"
write_state_or_die preparing "$CURRENT" "$LATEST" ''
rm -rf "$DL_ROOT"
mkdir -p "$DL" || fail_update "无法创建下载目录 $DL"

write_state_or_die downloading "$CURRENT" "$LATEST" ''
say "下载 $TARBALL …"
if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$DL/$TARBALL" "$BASE_URL/$TARBALL"; then
  fail_update "下载 ${TARBALL} 失败（${BASE_URL}/${TARBALL}）"
fi
if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$DL/SHA256SUMS" "$BASE_URL/SHA256SUMS"; then
  fail_update "下载 SHA256SUMS 失败（$BASE_URL/SHA256SUMS）"
fi
[ -s "$DL/$TARBALL" ] || fail_update "下载的 $TARBALL 是空文件"
[ -s "$DL/SHA256SUMS" ] || fail_update "下载的 SHA256SUMS 是空文件"

write_state_or_die verifying "$CURRENT" "$LATEST" ''
say "校验 SHA256 …"
grep -E "dsh-mizar-relay-$LATEST\.tar\.gz$" "$DL/SHA256SUMS" > "$DL/SHA256SUMS.filter" || true
[ -s "$DL/SHA256SUMS.filter" ] || fail_update "SHA256SUMS 里没有 $TARBALL"
if command -v sha256sum >/dev/null 2>&1; then
  if ! (cd "$DL" && sha256sum -c SHA256SUMS.filter > checksum.log 2>&1); then
    cat "$DL/checksum.log" >&2 || true
    fail_update "SHA256 校验失败；下载可能不完整，请重试"
  fi
elif command -v shasum >/dev/null 2>&1; then
  if ! (cd "$DL" && shasum -a 256 -c SHA256SUMS.filter > checksum.log 2>&1); then
    cat "$DL/checksum.log" >&2 || true
    fail_update "SHA256 校验失败；下载可能不完整，请重试"
  fi
else
  fail_update "系统没有 sha256sum 或 shasum，无法校验下载"
fi

mkdir -p "$EXTRACT"
say "解包 …"
if ! tar -xzf "$DL/$TARBALL" -C "$EXTRACT"; then
  fail_update "解包 $TARBALL 失败"
fi
if [ ! -d "$APP_SRC" ]; then
  APP_SRC="$(find "$EXTRACT" -type d -name app -print -quit 2>/dev/null || true)"
fi
if [ -z "$APP_SRC" ] || [ ! -f "$APP_SRC/lib/index.js" ]; then
  fail_update "包结构异常：找不到 app/lib/index.js"
fi
for item in lib node_modules package.json selftest.js; do
  [ -e "$APP_SRC/$item" ] || fail_update "包结构异常：缺少 $item"
done

write_state_or_die installing "$CURRENT" "$LATEST" ''
say "备份当前版本到 $DIR/app.previous …"
rm -rf "$DIR/app.previous" || fail_update "无法清理旧的 app.previous"
mkdir -p "$DIR/app.previous" || fail_update "无法创建 $DIR/app.previous"
for item in lib node_modules package.json selftest.js install.sh update.sh; do
  if [ -e "$DIR/$item" ]; then
    cp -a "$DIR/$item" "$DIR/app.previous/" || fail_update "备份 $item 失败"
  fi
done

say "停止服务 …"
if ! systemctl stop dsh-mizar-relay; then
  fail_update "无法停止 dsh-mizar-relay；未改动任何文件"
fi

say "安装新文件 …"
if ! {
  rm -rf "$DIR/lib" "$DIR/node_modules" &&
  cp -a "$APP_SRC/lib" "$DIR/lib" &&
  cp -a "$APP_SRC/node_modules" "$DIR/node_modules" &&
  cp -a "$APP_SRC/package.json" "$DIR/package.json" &&
  cp -a "$APP_SRC/selftest.js" "$DIR/selftest.js"
}; then
  restore_previous "复制新文件失败"
  exit 1
fi

if ! write_state restarting "$CURRENT" "$LATEST" ''; then
  err "无法写入 $DATA_DIR/update-state.json（继续启动服务）"
fi
say "启动服务 …"
if ! systemctl start dsh-mizar-relay; then
  restore_previous "systemctl start 失败"
  exit 1
fi
if ! wait_health "$LATEST"; then
  restore_previous "新版本 30 秒内没有通过 /healthz"
  exit 1
fi

# The installer scripts live at the bundle root, not in app/, and an update that
# left the old ones behind would keep an old rotation command around forever.
for script in install.sh update.sh; do
  if [ -f "$EXTRACT/dsh-mizar-relay-$LATEST/$script" ]; then
    cp -f "$EXTRACT/dsh-mizar-relay-$LATEST/$script" "$DIR/$script" ||
      err "警告：无法更新 $DIR/$script；当前版本已安装，脚本仍是旧的"
    chmod +x "$DIR/$script" 2>/dev/null || true
  fi
done

if ! write_state updated "$LATEST" "$LATEST" ''; then
  err "更新已完成，但无法写入 $DATA_DIR/update-state.json"
fi
say "更新完成：$CURRENT → $LATEST"
exit 0
