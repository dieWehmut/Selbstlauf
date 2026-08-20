#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)
IMPLEMENTATION="$SCRIPT_DIR/scripts/install/linux/install-opencode-root.sh"
if [ -f "$IMPLEMENTATION" ]; then
  exec /bin/bash "$IMPLEMENTATION" "$@"
fi

REMOTE_URL="https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/scripts/install/linux/install-opencode-root.sh"
TEMP_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/selbstlauf-entry.XXXXXX")
trap 'rm -f "$TEMP_SCRIPT"' EXIT HUP INT TERM
curl -fsSL "$REMOTE_URL" -o "$TEMP_SCRIPT"
exec /bin/bash "$TEMP_SCRIPT" "$@"
