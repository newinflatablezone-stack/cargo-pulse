#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE="${1:?Cargo Pulse release directory is required}"
RUNTIME=/opt/cargo-pulse-runtime/factory-export-runtime
test -s "$SOURCE/server/factory-export.mjs"
test -s "$SOURCE/factory-order-export.js"
test -s "$SOURCE/node_modules/exceljs/package.json"
test -s "$SOURCE/node_modules/sharp/package.json"

install -d -m 755 "$RUNTIME/server"
install -m 644 "$SOURCE/server/factory-export.mjs" "$RUNTIME/server/factory-export.mjs"
install -m 644 "$SOURCE/factory-order-export.js" "$RUNTIME/factory-order-export.js"

DEPENDENCIES="$(sha256sum "$SOURCE/package-lock.json" | cut -d ' ' -f 1)"
if [ "$(cat "$RUNTIME/dependency-lock" 2>/dev/null || true)" != "$DEPENDENCIES" ]; then
  install -d -m 755 "$RUNTIME/node_modules"
  rsync -a --delete --chown=root:root "$SOURCE/node_modules/" "$RUNTIME/node_modules/"
  printf '%s\n' "$DEPENDENCIES" > "$RUNTIME/dependency-lock"
fi
