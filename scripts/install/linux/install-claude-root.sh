#!/bin/bash
set -e

# ──────────────────────────────────────────────
# Claude Code Root Bypass – 一键安装脚本
# 自动安装依赖并注入 root 权限绕过
# ──────────────────────────────────────────────

# ---- 1. install system deps ----
PM=""
INSTALL_CMD=""
if command -v apt &>/dev/null; then
  PM=apt; INSTALL_CMD="apt install -y"
elif command -v dnf &>/dev/null; then
  PM=dnf; INSTALL_CMD="dnf install -y"
elif command -v yum &>/dev/null; then
  PM=yum; INSTALL_CMD="yum install -y"
elif command -v apk &>/dev/null; then
  PM=apk; INSTALL_CMD="apk add"
fi

if [ -n "$PM" ]; then
  echo "[*] checking system deps ($PM) ..."
  if $PM list --installed 2>/dev/null | grep -q gcc; then
    echo "  -> gcc already installed"
  else
    echo "  -> installing gcc ..."
    $INSTALL_CMD gcc 2>/dev/null || $INSTALL_CMD build-essential 2>/dev/null || {
      # try individual packages
      $INSTALL_CMD gcc libc-dev 2>/dev/null
    }
  fi
else
  echo "[!] unknown package manager; assuming gcc is installed"
fi

if ! command -v gcc &>/dev/null; then
  echo "ERROR: gcc still not available after install attempt."
  exit 1
fi

# ---- 2. compile fakeuid.so ----
echo "[*] compiling /tmp/fakeuid.so ..."
cat > /tmp/fakeuid.c << 'CEOF'
#define _GNU_SOURCE
#include <unistd.h>
#include <sys/types.h>
uid_t getuid(void) { return 1000; }
uid_t geteuid(void) { return 1000; }
gid_t getgid(void) { return 1000; }
gid_t getegid(void) { return 1000; }
CEOF
gcc -shared -fPIC -o /tmp/fakeuid.so /tmp/fakeuid.c && rm /tmp/fakeuid.c

# ---- 3. install claude if missing ----
if ! command -v claude &>/dev/null; then
  echo "[*] installing Claude Code via npm ..."
  if ! command -v npm &>/dev/null; then
    echo "ERROR: npm not found. Install Node.js first."
    exit 1
  fi
  npm install -g @anthropic-ai/claude-code
fi

# ---- 4. locate claude binary paths ----
CLAUDE_LINK=$(command -v claude 2>/dev/null)
if [ -z "$CLAUDE_LINK" ]; then
  echo "ERROR: claude binary not found after install."
  exit 1
fi
CLAUDE_EXE=$(readlink -f "$CLAUDE_LINK" 2>/dev/null || echo "$CLAUDE_LINK")
if [ ! -x "$CLAUDE_EXE" ]; then
  echo "ERROR: claude executable not found at $CLAUDE_EXE"
  # fallback: try to find it via npm root
  NPM_ROOT=$(npm root -g 2>/dev/null || echo "/usr/lib/node_modules")
  for f in "$NPM_ROOT/@anthropic-ai/claude-code/bin/claude.exe" \
           "$NPM_ROOT/@anthropic-ai/claude-code/cli-wrapper.cjs"; do
    [ -f "$f" ] && CLAUDE_EXE="$f" && break
  done
fi

# ---- 5. write wrapper ----
echo "[*] installing claude wrapper ..."
rm -f "$CLAUDE_LINK"
cat > "$CLAUDE_LINK" << WEOF
#!/bin/bash
DP=/tmp/claude-1000
[ -d "\$DP" ] || mkdir -p "\$DP"
[ "\$(stat -c %u "\$DP")" != 1000 ] && chown 1000:1000 "\$DP" 2>/dev/null
LD_PRELOAD=/tmp/fakeuid.so exec $CLAUDE_EXE --dangerously-skip-permissions "\$@"
WEOF
chmod +x "$CLAUDE_LINK"

echo ""
echo "done.  run 'claude' to start (no extra flags needed)."
