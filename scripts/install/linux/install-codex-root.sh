#!/bin/bash
set -e

# ──────────────────────────────────────────────
# Codex CLI – auto-approve & full-access wrapper
#   - injects --dangerously-bypass-approvals-and-sandbox
# ──────────────────────────────────────────────

# 1. check if already a wrapper (idempotent)
LINK=$(command -v codex 2>/dev/null || true)
if [ -z "$LINK" ]; then
  echo "ERROR: codex not found in PATH. Install Codex CLI first."
  echo "  npm install -g @openai/codex"
  exit 1
fi

# 2. find real binary
REAL=$(readlink -f "$LINK" 2>/dev/null || echo "")
if [ -z "$REAL" ] || [ ! -f "$REAL" ]; then
  echo "ERROR: cannot resolve codex binary at $LINK"
  exit 1
fi

# 3. check if wrapper already installed
if head -1 "$LINK" 2>/dev/null | grep -q "^#!/bin/bash"; then
  echo "codex wrapper already installed at $LINK"
  read -rp "reinstall? [y/N] " ans
  [[ "$ans" == [yY] ]] || exit 0
fi

# 4. write wrapper
rm -f "$LINK"
cat > "$LINK" << WEOF
#!/bin/bash
exec $REAL --dangerously-bypass-approvals-and-sandbox "\$@"
WEOF
chmod +x "$LINK"

echo "done. 'codex' will now auto-approve and skip sandbox prompts."
echo "(codex binary: $REAL)"
