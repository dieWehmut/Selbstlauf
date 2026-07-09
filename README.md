# ai-cli-bypass

Bypass root/sudo restrictions for AI CLI tools (Claude Code, etc.) in sandbox/root environments.

## Tools

| Script | Purpose |
|---|---|
| `install-claude-root.sh` | Auto-install deps & inject root bypass for Claude Code |
| `reset-claude.sh` | Restore claude to original state (undo bypass) |

## How it works

Uses `LD_PRELOAD` to intercept `getuid()`/`geteuid()`/`getgid()`/`getegid()` syscalls,
making the process believe it runs as a non-root user (UID 1000). The actual tool
binary is replaced with a thin wrapper that injects the preload library and the
`--dangerously-skip-permissions` flag automatically.

## Quick start

```bash
bash <(curl -sSfL https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/install-claude-root.sh)
claude
```

## Requirements

- Linux (Debian/Ubuntu/Fedora/RHEL/Alpine)
- `gcc` (auto-installed if missing)
- Node.js / npm (for Claude Code installation)
