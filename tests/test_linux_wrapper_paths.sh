#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d)
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$test_root"' EXIT

real_bin="$test_root/npm prefix with spaces"
mkdir -p "$real_bin"

for tool in codex opencode; do
  tool_root="$test_root/$tool"
  bin="$tool_root/bin"
  real_cli="$real_bin/$tool-real"
  capture="$tool_root/arguments.bin"
  mkdir -p "$bin"

  cat > "$real_cli" <<'CLI'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$FAKE_CAPTURE_FILE"
exit 37
CLI
  chmod +x "$real_cli"
  ln -s "$real_cli" "$bin/$tool"

  PATH="$bin:/usr/bin:/bin" bash "$repo_root/scripts/install/linux/install-$tool-root.sh"

  case "$tool" in
    codex) injected_flag='--dangerously-bypass-approvals-and-sandbox' ;;
    opencode) injected_flag='--auto' ;;
  esac

  if output=$(FAKE_CAPTURE_FILE="$capture" PATH="$bin:/usr/bin:/bin" \
    "$bin/$tool" 'argument with spaces' '$HOME;*' '' 2>&1); then
    status=0
  else
    status=$?
  fi

  if [[ $status -ne 37 ]]; then
    printf 'FAIL: %s wrapper returned %s; expected 37. Output: %s\n' "$tool" "$status" "$output" >&2
    exit 1
  fi

  python3 - "$capture" "$injected_flag" "$tool" <<'PY'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")[:-1]
expected = [sys.argv[2].encode(), b"argument with spaces", b"$HOME;*", b""]
if actual != expected:
    raise SystemExit(f"FAIL: {sys.argv[3]} arguments were {actual!r}, expected {expected!r}")
PY
  printf 'PASS: %s wrapper handles spaced executable paths and preserves arguments/status\n' "$tool"
done

claude_script="$repo_root/scripts/install/linux/install-claude-root.sh"
bash -n "$claude_script"
grep -Fq 'printf -v CLAUDE_EXE_FOR_WRAPPER '\''%q'\'' "$CLAUDE_EXE"' "$claude_script"
grep -Fq 'exec $CLAUDE_EXE_FOR_WRAPPER --dangerously-skip-permissions' "$claude_script"
printf 'PASS: Claude wrapper shell-quotes the resolved executable path\n'
