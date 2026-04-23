#!/usr/bin/env bash
# Produces nuntius-ultimate-<version>.zip with just the files needed to load
# the extension. Strips .git, Chrome-generated _metadata, prior zips, and
# dotfiles.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
OUT="nuntius-ultimate-${VERSION}.zip"

rm -f "$OUT"

zip -r "$OUT" . \
  --exclude '*.git*' \
  --exclude '_metadata/*' \
  --exclude '*.zip' \
  --exclude '.DS_Store' \
  --exclude 'native-host/claude-host-wrapper.sh' \
  --exclude 'pack.sh' \
  > /dev/null

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "Install paths:"
echo "  - Load unpacked: unzip and point chrome://extensions → Load unpacked at the folder."
echo "  - Chrome Web Store: upload $OUT in the developer dashboard."
