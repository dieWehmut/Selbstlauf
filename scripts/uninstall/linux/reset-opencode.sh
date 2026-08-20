#!/bin/bash
set -e

LINK=$(command -v opencode 2>/dev/null || true)
[ -z "$LINK" ] && echo "opencode not found in PATH." && exit 0

head -1 "$LINK" 2>/dev/null | grep -q "^#!/bin/bash" || {
  echo "opencode is not a wrapper (likely original binary)."
  exit 0
}

rm -f "$LINK"
# recreate original symlink
if [ -f /root/.opencode/bin/opencode ]; then
  ln -s /root/.opencode/bin/opencode "$LINK"
  echo "restored: $LINK -> /root/.opencode/bin/opencode"
else
  echo "error: cannot find /root/.opencode/bin/opencode"
  exit 1
fi
