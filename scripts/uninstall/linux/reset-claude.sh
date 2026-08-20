#!/bin/bash
set -e

# restore original claude binary from the npm package

LINK=$(command -v claude 2>/dev/null || true)
if [ -z "$LINK" ]; then
  echo "claude not found in PATH; nothing to reset."
  exit 0
fi

EXE=$(readlink -f "$LINK" 2>/dev/null || echo "")
if [ -z "$EXE" ] || [ ! -f "$EXE" ]; then
  echo "warning: claude link target missing ($EXE)"
fi

# check if it's already the original symlink
if [ -L "$LINK" ]; then
  echo "claude is already a symlink (original state)."
  read -rp "re-install wrapper anyway? [y/N] " ans
  [[ "$ans" == [yY] ]] || exit 0
fi

echo "restoring original claude symlink ..."
rm -f "$LINK"

# try to find the real binary in the npm package
NPM_ROOT=$(npm root -g 2>/dev/null || echo "/usr/lib/node_modules")
PKG_DIR="$NPM_ROOT/@anthropic-ai/claude-code"
if [ -d "$PKG_DIR" ]; then
  ln -s "$PKG_DIR/bin/claude.exe" "$LINK"
  echo "restored: $LINK -> $PKG_DIR/bin/claude.exe"
else
  echo "error: cannot find claude npm package at $PKG_DIR"
  echo "reinstall with: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

echo "done. run 'claude' to test."
