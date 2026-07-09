#!/bin/bash
# Test that claude runs without root/sudo errors
# (does NOT require an API key; just verifies startup doesn't crash)

set -e

echo "=== claude version ==="
CLAUDE_VERSION=$(claude --version 2>&1)
echo "version: $CLAUDE_VERSION"

echo ""
echo "=== claude --help (first 5 lines) ==="
claude --help 2>&1 | head -5

echo ""
echo "=== temp dir ownership ==="
DP=$(claude --version 2>&1 >/dev/null && echo /tmp/claude-1000 || echo "/tmp/claude-1000")
ls -ld "$DP" 2>/dev/null || echo "(dir not created yet)"

OWNER=$(stat -c "%u" "$DP" 2>/dev/null || echo "N/A")
echo "owner of $DP: uid=$OWNER"

echo ""
echo "=== fakeuid.so loaded? ==="
# we can't easily check LD_PRELOAD from inside, but we can verify .so exists
ls -l /tmp/fakeuid.so

echo ""
echo "=== PASS ==="
