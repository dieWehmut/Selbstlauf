# ai-cli-bypass

Bypass root/sudo restrictions and permission prompts for AI CLI tools in sandbox/root environments.

## Supported Tools

| Tool | Script | Mechanism |
|---|---|---|
| **Claude Code** | `install-claude-root.sh` | `LD_PRELOAD` fakes `getuid()` + injects `--dangerously-skip-permissions` |
| **Codex CLI** | `install-codex-root.sh` | Injects `--dangerously-bypass-approvals-and-sandbox` |
| **OpenCode** | `install-opencode-root.sh` | Injects `--auto` (auto-approve permissions) |

## Reset Scripts

| Tool | Script |
|---|---|
| Claude Code | `reset-claude.sh` |
| Codex CLI | `reset-codex.sh` |
| OpenCode | `reset-opencode.sh` |

## Quick Start

```bash
# Claude Code (needs LD_PRELOAD root bypass)
bash <(curl -sSfL https://cdn.jsdelivr.net/gh/dieWehmut/ai-cli-bypass@main/install-claude-root.sh)
claude

# Codex CLI (bypass approval prompts)
bash <(curl -sSfL https://cdn.jsdelivr.net/gh/dieWehmut/ai-cli-bypass@main/install-codex-root.sh)
codex

# OpenCode (auto-approve permissions)
bash <(curl -sSfL https://cdn.jsdelivr.net/gh/dieWehmut/ai-cli-bypass@main/install-opencode-root.sh)
opencode
```

## Requirements

- Linux (Debian/Ubuntu/Fedora/RHEL/Alpine)
- `gcc` (for Claude Code bypass; auto-installed if missing)
- Node.js / npm
