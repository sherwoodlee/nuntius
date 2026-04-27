#!/usr/bin/env bash
# Produces a clean Chrome Web Store upload zip with only runtime extension files.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
DIST_DIR="dist"
STAGE_DIR="$DIST_DIR/nuntius-$VERSION"
OUT="$DIST_DIR/nuntius-$VERSION-chrome-web-store.zip"

FILES=(
  "manifest.json"
  "background.js"
  "content-main.js"
  "content-slack.js"
  "content-teams.js"
  "content-instagram.js"
  "content-facebook.js"
  "assets"
  "rules"
  "sidepanel"
)

rm -rf "$STAGE_DIR"
rm -f "$OUT"
mkdir -p "$STAGE_DIR"

for path in "${FILES[@]}"; do
  cp -R "$path" "$STAGE_DIR/"
done

(
  cd "$STAGE_DIR"
  find . -name '.DS_Store' -delete
  zip -r "../$(basename "$OUT")" . > /dev/null
)

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "Staging folder: $STAGE_DIR"
echo
echo "Upload:"
echo "  - Chrome Web Store: upload $OUT in the developer dashboard."
echo "  - Load unpacked: point chrome://extensions to $STAGE_DIR."
