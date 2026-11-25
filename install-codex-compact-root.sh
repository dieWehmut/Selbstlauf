#!/bin/sh
# Entry point for `curl -fsSL .../install-codex-compact-root.sh | sh`.
# Kept tiny: run the real installer from the same checkout when it exists,
# otherwise download it. The download is removed on exit (no exec, so the
# trap survives) and handed to the invoking user before dropping privileges.
set -eu

# When run as a file from a checkout, run the sibling implementation. When
# piped in (`curl | sh`, `$0` is "sh") there is no script directory: `dirname`
# would yield "." and silently pick up whatever sits in the current directory,
# so that case must download instead.
if [ -f "$0" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)
  IMPLEMENTATION="$SCRIPT_DIR/scripts/install/linux/install-codex-compact-root.sh"
  if [ -f "$IMPLEMENTATION" ]; then
    exec /bin/bash "$IMPLEMENTATION" "$@"
  fi
fi

REMOTE_URL="https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/scripts/install/linux/install-codex-compact-root.sh"
TEMP_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/selbstlauf-entry.XXXXXX")
trap 'rm -f "$TEMP_SCRIPT"' EXIT HUP INT TERM
# Bounded so an unreachable CDN fails in seconds instead of hanging forever.
# --retry covers a dropped connection; the timeouts cover a black-holed host.
if ! curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 "$REMOTE_URL" -o "$TEMP_SCRIPT"; then
  echo "error: could not download $REMOTE_URL" >&2
  echo "Install from a clone instead (works offline for the download step):" >&2
  echo "  git clone https://github.com/dieWehmut/Selbstlauf.git && bash Selbstlauf/install-codex-compact-root.sh" >&2
  exit 1
fi
chmod 700 "$TEMP_SCRIPT"
# `curl | sudo sh` runs this as root, and the implementation re-runs itself as
# SUDO_USER; that user must be able to read the copy it was started from.
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  chown "$SUDO_USER" "$TEMP_SCRIPT" 2>/dev/null || true
fi
/bin/bash "$TEMP_SCRIPT" "$@"