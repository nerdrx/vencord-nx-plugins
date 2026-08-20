#!/usr/bin/env bash
# One-shot local install: build Vencord+NX plugins and deploy into the live
# Vencord dist that your Discord/Vesktop loads. For people not using NX Hub.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${VENCORD_DIST:-$HOME/.config/Vencord/dist}"

"$ROOT/scripts/build.sh"

VERSION="$(cat "$ROOT/VERSION" | tr -d '[:space:]')"
TARBALL="$ROOT/out/nx-vencord-plugins-$VERSION-linux.tar.gz"

if [ ! -d "$DEST" ]; then
    echo "!! $DEST not found — is Vencord installed? (run 'vencord' installer first)" >&2
    exit 1
fi

echo "==> Backing up current dist to $DEST.bak"
rm -rf "$DEST.bak"
cp -r "$DEST" "$DEST.bak"

echo "==> Deploying into $DEST"
tar -xzf "$TARBALL" -C "$(dirname "$DEST")"

echo "==> Done. Fully restart Discord (or Ctrl+R) to load the plugins."
echo "    Tip: turn OFF Vencord auto-update so it doesn't overwrite this build."
