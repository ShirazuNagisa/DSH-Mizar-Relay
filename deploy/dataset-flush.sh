#!/bin/sh
# The 04:00 dataset flush, run by dsh-mizar-dataset-flush.service.
#
# The relay bundle installs node under the panel's versioned directory, and a
# systemd unit does not inherit the shell's PATH. Resolve once, then exec, so the
# timer has one place to be wrong instead of two.
set -eu

NODE="${NODE:-}"
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ] && [ -x /www/server/nodejs/v24.22.0/bin/node ]; then
  NODE=/www/server/nodejs/v24.22.0/bin/node
fi
if [ -z "$NODE" ]; then
  echo "dataset: no node found; set NODE=/path/to/node" >&2
  exit 1
fi

ROOT="${MIZAR_RELAY_ROOT:-/www/wwwroot/dsh-mizar-relay}"
CONFIG="${MIZAR_RELAY_CONFIG:-$ROOT/relay.config.json}"

exec "$NODE" "$ROOT/lib/dataset/flush.js" --config "$CONFIG"
