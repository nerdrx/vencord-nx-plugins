#!/usr/bin/env bash
# Build Vencord with the NX userplugins baked in, and emit a dist tarball.
#
# Usage:
#   scripts/build.sh                 # build into ./build/vencord, output ./out/*.tar.gz
#   VENCORD_REF=v1.15.2 scripts/build.sh
#
# Output tarball layout (root contains `dist/`) so it extracts straight into
# ~/.config/Vencord/ — matching the NX Hub `tarball-prefix` install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENCORD_REF="${VENCORD_REF:-v1.15.2}"
BUILD_DIR="${BUILD_DIR:-$ROOT/build/vencord}"
OUT_DIR="${OUT_DIR:-$ROOT/out}"
VERSION="$(cat "$ROOT/VERSION" | tr -d '[:space:]')"

echo "==> NX Vencord plugins v$VERSION (Vencord $VENCORD_REF)"

# 1. Get a Vencord checkout at the pinned ref (reuse if already present)
if [ ! -d "$BUILD_DIR/.git" ]; then
    mkdir -p "$(dirname "$BUILD_DIR")"
    git clone --branch "$VENCORD_REF" --depth 1 https://github.com/Vendicated/Vencord.git "$BUILD_DIR"
else
    git -C "$BUILD_DIR" fetch --depth 1 origin "$VENCORD_REF"
    git -C "$BUILD_DIR" checkout -f FETCH_HEAD
fi

# 2. Inject our userplugins
rm -rf "$BUILD_DIR/src/userplugins"
mkdir -p "$BUILD_DIR/src/userplugins"
cp -r "$ROOT/userplugins/." "$BUILD_DIR/src/userplugins/"
echo "==> Injected plugins: $(ls "$ROOT/userplugins" | tr '\n' ' ')"

# 3. Build
cd "$BUILD_DIR"
corepack enable >/dev/null 2>&1 || true
npx -y pnpm@11.9.0 install --frozen-lockfile
npx -y pnpm@11.9.0 build

# 4. Package the dist (tarball root = dist/)
mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/nx-vencord-plugins-$VERSION-linux.tar.gz"
tar -czf "$TARBALL" -C "$BUILD_DIR" dist
( cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256" )

echo "==> Wrote $TARBALL"
ls -la "$OUT_DIR"
