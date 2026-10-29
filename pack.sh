#!/usr/bin/env bash
# Build a slim ContentPlay.iinaplgz (runtime files only, no docs/screenshots).
# Packs from a space-free temp copy because `iina-plugin pack` breaks on paths
# with spaces (and can delete the source dir).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$SRC/ContentPlay.iinaplgz}"
PACK=/Applications/IINA.app/Contents/MacOS/iina-plugin

BUILD="$(mktemp -d /tmp/contentplay-pack.XXXXXX)"
trap 'rm -rf "$BUILD"' EXIT

mkdir "$BUILD/ContentPlay"
rsync -a \
  --exclude .git --exclude .github --exclude docs --exclude README.md \
  --exclude .gitignore --exclude .impeccable --exclude .DS_Store \
  --exclude pack.sh --exclude '*.iinaplgz' \
  "$SRC/" "$BUILD/ContentPlay/"

(cd "$BUILD/ContentPlay" && "$PACK" pack . >/dev/null)
cp "$BUILD"/ContentPlay/*.iinaplgz "$OUT"
echo "Created $OUT ($(du -h "$OUT" | cut -f1))"
