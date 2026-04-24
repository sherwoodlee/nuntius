#!/usr/bin/env bash
# Installs the Nuntius native-messaging host so the Chrome extension
# can spawn `claude` via stdin/stdout.
#
# Usage:
#   ./install.sh <extension-id>
#
# To get the extension ID: load the unpacked extension in chrome://extensions,
# enable Developer mode, and copy the ID shown on the Nuntius card.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <extension-id>" >&2
  exit 1
fi

EXTENSION_ID="$1"
HOST_NAME="com.nuntius.claude"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOST_SCRIPT="$SCRIPT_DIR/claude-host.js"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH — install Node or set NODE_BIN." >&2
  exit 1
fi

# Write a thin wrapper so Chrome doesn't have to know about node.
WRAPPER="$SCRIPT_DIR/claude-host-wrapper.sh"
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
  "description": "Nuntius bridge to the Claude CLI",
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
echo "Reload the extension in chrome://extensions to pick it up."
