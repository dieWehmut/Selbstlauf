#!/bin/bash
set -e

# ──────────────────────────────────────────────
# OpenCode – auto-approve wrapper
#   - injects --auto (auto-approve permissions)
# ──────────────────────────────────────────────

LINK=$(command -v opencode 2>/dev/null || true)
if [ -z "$LINK" ]; then
  echo "ERROR: opencode not found in PATH."
  exit 1
fi

REAL=$(readlink -f "$LINK" 2>/dev/null || echo "")
if [ -z "$REAL" ] || [ ! -f "$REAL" ]; then
  echo "ERROR: cannot resolve opencode binary at $LINK"
  exit 1
fi

# check if wrapper already installed
if head -1 "$LINK" 2>/dev/null | grep -q "^#!/bin/bash"; then
  echo "opencode wrapper already installed at $LINK"
  read -rp "reinstall? [y/N] " ans
  [[ "$ans" == [yY] ]] || exit 0
fi

rm -f "$LINK"
cat > "$LINK" << WEOF
#!/bin/bash
exec $REAL --auto "\$@"
WEOF
chmod +x "$LINK"

echo "done. 'opencode' will now auto-approve permissions."
echo "(opencode binary: $REAL)"
