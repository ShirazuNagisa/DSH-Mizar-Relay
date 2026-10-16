#!/usr/bin/env bash
#
# Pack the relay into the bundle the server installs from.
#
# Usage:  deploy/pack.sh [output-dir]
#
# The bundle is self-contained on purpose: built JavaScript, the one runtime
# dependency, the installer, the nginx snippet and the deployment notes. A server
# in China fetching from the npm registry is a step that can fail for reasons
# that have nothing to do with this software, so nothing is fetched there.
#
# Output: <output-dir>/dsh-mizar-relay-<version>.tar.gz
#         default output-dir: $MIZAR_RELEASE_DIR, or ../../release/dsh-relay
#
# Nothing secret goes in. `relay.config.json` is generated from the example with
# an empty token list and mode 600; the operator's tunnel token is created on the
# server, by the installer, and never leaves it.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="${1:-${MIZAR_RELEASE_DIR:-$ROOT/../../release/dsh-relay}}"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die 'node is required to build and pack the relay'
[ -f "$ROOT/package.json" ] || die "no package.json in $ROOT"

VERSION="$(node -p "require('$ROOT/package.json').version")"
[ -n "$VERSION" ] || die 'could not read the version'

# The deployment reference lives beside the relay in the source tree, and beside
# this script in the bundle. Either layout is accepted so the packer works before
# and after the repository split.
DOC=''
for candidate in "$ROOT/docs/deployment.md" "$ROOT/../docs/relay-deployment.md" "$ROOT/docs/relay-deployment.md"; do
  [ -f "$candidate" ] && DOC="$candidate" && break
done
[ -n "$DOC" ] || die 'the deployment reference (docs/deployment.md) is missing'

printf '\nDSH-Mizar relay · packing %s\n%s\n\n' "$VERSION" "$(printf '=%.0s' {1..40})"

say "building lib/ …"
(cd "$ROOT" && npm run build >/dev/null)
[ -f "$ROOT/lib/index.js" ] || die 'the build produced no lib/index.js'

STAGE="$(mktemp -d)/dsh-mizar-relay-$VERSION"
mkdir -p "$STAGE/app/node_modules"
say "staging $STAGE"

cp -R "$ROOT/lib" "$STAGE/app/lib"
cp "$ROOT/package.json" "$STAGE/app/package.json"
# The example deliberately has no `apns` block: it used to carry a placeholder
# PEM, and the relay tried to parse it at start-up, so a fresh install following
# the deployment notes never listened at all. Push is opt-in.
cp "$ROOT/relay.config.example.json" "$STAGE/app/relay.config.json"
cp "$HERE/selftest.js" "$STAGE/app/selftest.js"
# The one runtime dependency, carried rather than installed.
cp -R "$ROOT/node_modules/ws" "$STAGE/app/node_modules/ws"

cp "$HERE/README.md" "$STAGE/README.md"
cp "$HERE/install.sh" "$STAGE/install.sh"
cp "$HERE/nginx-websocket.conf" "$STAGE/nginx-websocket.conf"
cp "$DOC" "$STAGE/DEPLOYMENT-FULL.md"
# The bundle's own file list, with the version it was cut at.
sed "s/v[0-9][0-9.]* — 文件说明/v$VERSION — 文件说明/" "$HERE/文件说明.txt" > "$STAGE/文件说明.txt"

chmod 600 "$STAGE/app/relay.config.json"
chmod +x "$STAGE/install.sh"

mkdir -p "$OUT"
rm -f "$OUT/dsh-mizar-relay-$VERSION.tar.gz"
# `COPYFILE_DISABLE`: without it macOS tar adds AppleDouble `._` entries, which
# is how a bundle grows a second copy of every file that the server then has to
# ignore.
COPYFILE_DISABLE=1 tar czf "$OUT/dsh-mizar-relay-$VERSION.tar.gz" -C "$(dirname "$STAGE")" "dsh-mizar-relay-$VERSION"
rm -rf "$(dirname "$STAGE")"

printf '\n'
say "wrote $OUT/dsh-mizar-relay-$VERSION.tar.gz"
say "sha256 $(shasum -a 256 "$OUT/dsh-mizar-relay-$VERSION.tar.gz" | cut -d' ' -f1)"
printf '\n'
