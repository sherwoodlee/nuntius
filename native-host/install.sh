#!/usr/bin/env bash
# Installs the nuntius native-messaging host so the Chrome extension
# can spawn local AI CLIs (Claude / Gemini / Codex) via stdin/stdout.
#
# Usage:
#   ./install.sh <extension-id>
#   bash <(curl -fsSL https://raw.githubusercontent.com/sherwoodlee/nuntius-installer/main/install.sh)
#
# To get the extension ID: load the unpacked extension in chrome://extensions,
# enable Developer mode, and copy the ID shown on the nuntius card.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <extension-id>" >&2
  exit 1
fi

EXTENSION_ID="$1"
HOST_NAME="com.nuntius.claude"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/nuntius/native-host}"
RAW_BASE_URL="${RAW_BASE_URL:-https://raw.githubusercontent.com/sherwoodlee/nuntius-installer/main}"
LOCAL_HOST_SCRIPT="$SCRIPT_DIR/claude-host.js"
HOST_SCRIPT="$INSTALL_ROOT/claude-host.js"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH — install Node or set NODE_BIN." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT"

if [ -f "$LOCAL_HOST_SCRIPT" ]; then
  cp "$LOCAL_HOST_SCRIPT" "$HOST_SCRIPT"
else
  echo "Downloading native host from $RAW_BASE_URL/claude-host.js"
  curl -fsSL "$RAW_BASE_URL/claude-host.js" -o "$HOST_SCRIPT"
fi
chmod +x "$HOST_SCRIPT"

# Write a thin wrapper so Chrome doesn't have to know about node.
WRAPPER="$INSTALL_ROOT/claude-host-wrapper.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$HOST_SCRIPT" "\$@"
EOF
chmod +x "$WRAPPER"

case "$(uname -s)" in
  Darwin)
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

mkdir -p "$TARGET_DIR"
MANIFEST_PATH="$TARGET_DIR/$HOST_NAME.json"

cat > "$MANIFEST_PATH" <<EOF
{
  "name": "$HOST_NAME",
  "description": "nuntius bridge to local AI CLIs",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed $HOST_NAME"
echo "  manifest: $MANIFEST_PATH"
echo "  wrapper:  $WRAPPER"
echo "  host js:  $HOST_SCRIPT"
echo "Reload the extension in chrome://extensions to pick it up."
