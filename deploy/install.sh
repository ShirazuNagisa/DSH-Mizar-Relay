#!/usr/bin/env bash
#
# Install the DSH-Mizar relay as a systemd service.
#
# Deliberately does as little as possible: the bundle already carries the built
# server and its only dependency, so there is nothing to compile and nothing to
# fetch. That is the point -- a server in China fetching from the npm registry is
# a step that can fail for reasons that have nothing to do with this software.
#
# Usage:  sudo ./install.sh [install-dir]
# Default install dir: /www/wwwroot/dsh-mizar-relay
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-/www/wwwroot/dsh-mizar-relay}"
SERVICE=/etc/systemd/system/dsh-mizar-relay.service

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

printf '\nDSH-Mizar relay installer\n%s\n\n' "$(printf '=%.0s' {1..40})"

# --- find node --------------------------------------------------------------
#
# BaoTa installs Node under /www/server/nodejs/<version>/bin and does NOT put it
# on the PATH of a plain shell -- its own Node project manager uses the absolute
# path. So `command -v node` failing says nothing about whether Node is
# installed, and the first version of this script told someone who had just
# installed it from the app store that it was not there.
#
# The binary path is also what the systemd unit needs, since a service does not
# inherit anyone's shell configuration.
find_node() {
  local candidate
  # 1. On the PATH -- a system Node, or a login shell that sourced nvm.
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # 2. BaoTa's own installs, newest version first.
  for candidate in $(ls -d /www/server/nodejs/*/bin/node 2>/dev/null | sort -Vr); do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  # 3. Where a hand install usually lands.
  for candidate in /usr/local/bin/node /usr/bin/node /opt/node/bin/node /snap/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  # 4. nvm, for this user and for root.
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /root/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

# --- checks -----------------------------------------------------------------
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

# --- copy -------------------------------------------------------------------
#
# Everything except the config. Re-running this installer is how an upgrade is
# applied, and a blanket copy would put the shipped placeholder over the token
# the Mac is already paired against -- which looks like the relay breaking
# rather than the installer having clobbered a credential.
mkdir -p "$TARGET"
for entry in "$HERE"/app/*; do
  name="$(basename "$entry")"
  if [ "$name" = "relay.config.json" ]; then continue; fi
  cp -R "$entry" "$TARGET/"
done
if [ -f "$TARGET/relay.config.json" ]; then
  say "copied the server to $TARGET (kept the existing relay.config.json)"
else
  cp "$HERE/app/relay.config.json" "$TARGET/"
  say "copied the server to $TARGET"
fi

chmod 600 "$TARGET/relay.config.json"

# --- token ------------------------------------------------------------------
#
# Generated here rather than shipped. A token baked into a downloadable bundle
# is the same token on every server that bundle reaches, which makes it a
# default credential in the way that matters -- and this bundle's was known
# before its domain existed.
#
# Re-running the installer leaves an existing token alone, so an upgrade does not
# silently invalidate the Mac that is already paired against it.
say "relay.config.json is root-only"

# --- systemd ----------------------------------------------------------------
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

# The relay only needs to listen on loopback and open outbound connections.
# It writes nothing, so it is given nothing to write to.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/

[Install]
WantedBy=multi-user.target
UNIT
say "wrote $SERVICE (ExecStart uses $NODE_BIN)"

systemctl daemon-reload
systemctl enable --now dsh-mizar-relay >/dev/null 2>&1 || fail "systemd could not start the service. Check: journalctl -u dsh-mizar-relay -n 40"
sleep 1

if systemctl is-active --quiet dsh-mizar-relay; then
  say "service is running"
else
  fail "the service did not stay up. Check: journalctl -u dsh-mizar-relay -n 40"
fi

# --- prove it answers -------------------------------------------------------
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

  Then put this in the DSH-Mizar plugin's config on your Mac:

    relay:
      url: "https://<your-domain>"

  Restart DSH. The panel will show the pairing address to scan.

  Logs:  journalctl -u dsh-mizar-relay -f
  Stop:  systemctl stop dsh-mizar-relay

DONE
