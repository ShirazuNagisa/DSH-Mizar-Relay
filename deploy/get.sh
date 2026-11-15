#!/usr/bin/env bash
#
# One-command bootstrap for a self-hosted DSH-Mizar relay.
#
# This file is meant to be piped into bash:
#
#   curl -fsSL https://raw.githubusercontent.com/ShirazuNagisa/DSH-Mizar-Relay/main/deploy/get.sh \
#     | sudo bash -s -- --domain relay.example.com
#
# It therefore must not use BASH_SOURCE or read anything from its own directory:
# when a script is read from stdin, the shell has no file path for it. Everything
# it needs is downloaded into a temporary directory, verified against the
# release's SHA256SUMS, and cleaned up on exit.
#
# Usage:  get.sh --domain <host|https origin> [options]
#
#   --domain <host|https origin>  required
#   --email <addr>                Caddy / Let's Encrypt notification address
#   --pin <value>                 use this server PIN instead of generating one
#   --dir <path>                  install directory (default /opt/dsh-mizar-relay)
#   --version <vX.Y.Z>            install a specific release (default: latest)
#   --no-auto-update              do not install the daily update timer
#   --behind-proxy                keep an existing nginx/BaoTa proxy; no Caddy
#   --no-tls                      do not install Caddy (private network/debug)
#
set -euo pipefail

REPO=ShirazuNagisa/DSH-Mizar-Relay

DOMAIN=''
EMAIL=''
PIN_ARG=''
DIR_ARG=''
VERSION=''
AUTO_UPDATE=1
BEHIND_PROXY=0
NO_TLS=0
TMP_DIR=''

ORIGINAL_ARGS=("$@")

say() { printf '  %s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
err() { printf '  ✗ %s\n' "$*" >&2; }
fail() { err "$*"; exit 1; }

cleanup() {
  if [ -n "${TMP_DIR:-}" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
DSH-Mizar 自建服务器 · 一条命令安装

  curl -fsSL https://raw.githubusercontent.com/ShirazuNagisa/DSH-Mizar-Relay/main/deploy/get.sh \
    | sudo bash -s -- --domain relay.example.com [选项]

  --domain <host|https origin>  必填；域名或 https://域名
  --email <addr>                Caddy / Let's Encrypt 通知邮箱（可选）
  --pin <value>                 指定服务器 PIN（不填则生成并打印一次）
  --dir <path>                  安装目录，默认 /opt/dsh-mizar-relay
  --version <vX.Y.Z>            安装指定版本，默认最新 release
  --no-auto-update              不安装每日自动更新 timer
  --behind-proxy                已有 nginx/宝塔反代，不装 Caddy
  --no-tls                      内网/调试：不装 Caddy

脚本会从 GitHub Releases 下载 dsh-mizar-relay-<版本>.tar.gz 和 SHA256SUMS，
校验通过后解包并执行包里的 install.sh。
USAGE
}

fail_usage() {
  printf '\n  ✗ %s\n\n' "$*" >&2
  usage >&2
  exit 1
}

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
    --version)
      [ "$#" -ge 2 ] || fail_usage "--version 需要值"
      VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --no-auto-update) AUTO_UPDATE=0; shift ;;
    --behind-proxy) BEHIND_PROXY=1; shift ;;
    --no-tls) NO_TLS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) fail_usage "未知选项：$1" ;;
    -*) fail_usage "未知选项：$1" ;;
    *) fail_usage "不认识的位置参数：$1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "需要 root 权限：请用 sudo 运行（curl … | sudo bash -s -- …）。"
[ -n "$DOMAIN" ] || fail_usage "缺少 --domain（例如 --domain relay.example.com）"
command -v curl >/dev/null 2>&1 || fail "找不到 curl；请先安装 curl。"
command -v tar >/dev/null 2>&1 || fail "找不到 tar；请先安装 tar。"

# Strip a leading v so both v0.5.0 and 0.5.0 are accepted.
VERSION="${VERSION#v}"
VERSION="${VERSION#V}"
if [ -n "$VERSION" ]; then
  case "$VERSION" in
    *[!0-9A-Za-z.-]*) fail_usage "--version 格式不对：$VERSION" ;;
  esac
  printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' \
    || fail_usage "--version 格式不对：${VERSION}（应类似 v0.5.0）"
fi

printf '\nDSH-Mizar 自建服务器安装\n%s\n\n' "$(printf '=%.0s' {1..44})"
say "域名        $DOMAIN"
say "安装目录    ${DIR_ARG:-/opt/dsh-mizar-relay}"
if [ "$AUTO_UPDATE" -eq 1 ]; then AUTO_LABEL=开启; else AUTO_LABEL=关闭; fi
say "自动更新    $AUTO_LABEL"

# Ask GitHub for the latest release tag. The API is tried first; when it is rate
# limited or otherwise unhappy, follow the redirect of /releases/latest, which
# needs no token and no JSON parser.
resolve_latest() {
  local json='' tag='' location=''
  json="$(curl -fsSL --connect-timeout 10 --max-time 30 \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: dsh-mizar-relay-get' \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" \
    | grep -o '"tag_name": *"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*"([^"]*)"$/\1/' || true)"
  if [ -z "$tag" ]; then
    location="$(curl -fsSI --connect-timeout 10 --max-time 30 \
      -H 'User-Agent: dsh-mizar-relay-get' \
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
  printf '%s' "$tag" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' || return 1
  printf '%s' "$tag"
}

step "1/5" "检查运行环境"
if [ -n "$VERSION" ]; then
  step "2/5" "使用指定版本"
  say "v$VERSION"
else
  step "2/5" "解析最新 release"
  if ! VERSION="$(resolve_latest)"; then
    fail "无法从 GitHub 解析最新版本。
  请检查这台机器能否访问 github.com；也可以显式指定版本重试：
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/deploy/get.sh | sudo bash -s -- --domain $DOMAIN --version v0.5.0"
  fi
  say "最新版本：v$VERSION"
fi

step "3/5" "下载并校验 SHA256"
TMP_DIR="$(mktemp -d)" || fail "无法创建临时目录"
BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
TARBALL="dsh-mizar-relay-$VERSION.tar.gz"
say "下载 $TARBALL …"
if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$TMP_DIR/$TARBALL" "$BASE_URL/$TARBALL"; then
  fail "下载失败：$BASE_URL/$TARBALL
  请检查网络，或到 https://github.com/$REPO/releases 手动下载。"
fi
if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$TMP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS"; then
  fail "下载 SHA256SUMS 失败：$BASE_URL/SHA256SUMS
  这个 release 可能没有校验文件；请到 Releases 页面确认，或手动下载安装包。"
fi
[ -s "$TMP_DIR/$TARBALL" ] || fail "下载的 $TARBALL 是空文件，请重试。"
[ -s "$TMP_DIR/SHA256SUMS" ] || fail "下载的 SHA256SUMS 是空文件，请重试。"

grep -E "dsh-mizar-relay-$VERSION\.tar\.gz$" "$TMP_DIR/SHA256SUMS" > "$TMP_DIR/SHA256SUMS.filter" || true
[ -s "$TMP_DIR/SHA256SUMS.filter" ] || fail "SHA256SUMS 里没有 ${TARBALL}；请确认 release 资产完整。"
if command -v sha256sum >/dev/null 2>&1; then
  if ! (cd "$TMP_DIR" && sha256sum -c SHA256SUMS.filter > checksum.log 2>&1); then
    cat "$TMP_DIR/checksum.log" >&2 || true
    fail "SHA256 校验失败；下载可能不完整或被篡改。请重试，或到 Releases 页面手动下载。"
  fi
elif command -v shasum >/dev/null 2>&1; then
  if ! (cd "$TMP_DIR" && shasum -a 256 -c SHA256SUMS.filter > checksum.log 2>&1); then
    cat "$TMP_DIR/checksum.log" >&2 || true
    fail "SHA256 校验失败；下载可能不完整或被篡改。请重试，或到 Releases 页面手动下载。"
  fi
else
  fail "系统没有 sha256sum 或 shasum，无法校验下载。"
fi
say "SHA256 校验通过"

step "4/5" "解包"
mkdir -p "$TMP_DIR/extract" || fail "无法创建解包目录"
if ! tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR/extract"; then
  fail "解包失败：$TMP_DIR/$TARBALL"
fi
PKG_DIR="$TMP_DIR/extract/dsh-mizar-relay-$VERSION"
if [ ! -f "$PKG_DIR/install.sh" ]; then
  INSTALLER="$(find "$TMP_DIR/extract" -type f -name install.sh -print -quit 2>/dev/null || true)"
  if [ -n "$INSTALLER" ]; then PKG_DIR="$(dirname "$INSTALLER")"; fi
fi
[ -n "$PKG_DIR" ] && [ -f "$PKG_DIR/install.sh" ] || fail "包里找不到 install.sh；release 资产可能不完整。"

step "5/5" "运行安装器"
# Forward every option except --version: install.sh does not need it, and would
# reject it as unknown. The downloaded package already is that version.
FORWARD=()
index=0
while [ "$index" -lt "${#ORIGINAL_ARGS[@]}" ]; do
  arg="${ORIGINAL_ARGS[$index]}"
  case "$arg" in
    --version) index=$((index + 2)) ;;
    --version=*) index=$((index + 1)) ;;
    *) FORWARD+=("$arg"); index=$((index + 1)) ;;
  esac
done

if ! bash "$PKG_DIR/install.sh" "${FORWARD[@]}"; then
  fail "安装器返回失败。上面的日志是原因；修复后可以重跑同一条命令。
  如果需要手动排查：重新下载 release，解包后执行
    sudo bash dsh-mizar-relay-$VERSION/install.sh ${FORWARD[*]}"
fi

printf '\n  安装流程结束。请按上面的总结保存 PIN 与更新 token。\n\n'
