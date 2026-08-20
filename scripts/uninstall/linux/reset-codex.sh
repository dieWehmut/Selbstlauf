#!/bin/bash
set -e

LINK=$(command -v codex 2>/dev/null || true)
[ -z "$LINK" ] && echo "codex not found in PATH." && exit 0

# skip if not a wrapper
head -1 "$LINK" 2>/dev/null | grep -q "^#!/bin/bash" || {
  echo "codex is not a wrapper (likely original binary)."
  exit 0
}

rm -f "$LINK"
# recreate original symlink
NPM_ROOT=$(npm root -g 2>/dev/null || echo "/usr/lib/node_modules")
PKG_DIR="$NPM_ROOT/@openai/codex"
if [ -f "$PKG_DIR/bin/codex.js" ]; then
  ln -s "$PKG_DIR/bin/codex.js" "$LINK"
  echo "restored: $LINK -> $PKG_DIR/bin/codex.js"
else
  echo "error: cannot find $PKG_DIR/bin/codex.js"
  echo "reinstall: npm install -g @openai/codex"
  exit 1
fi
