#!/bin/bash
set -eu

# ─────────────────────────────────────────────────────────────────────────────
# Codex non-GPT compaction installer (Linux)
#
# Codex picks its compaction strategy from the provider name, so a custom
# provider called "OpenAI" makes it ask the gateway for OpenAI-only remote
# compaction v2. Third-party gateways answer with ordinary message items and the
# turn dies with "remote compaction v2 expected exactly one compaction output
# item, got 0 from 1 output items". Declaring
# capabilities.remote_compaction = "unsupported" sends compaction back to the
# local summariser, which works for Gemini, Claude, DeepSeek and friends.
#
# The edit itself lives in scripts/install/codex_compact_config.py so Windows
# and Linux cannot drift apart; this script only finds Python 3, fetches that
# file, and runs it. The patch always targets the invoking user's ~/.codex, even
# when the script is run through sudo (see drop_to_original_user). On top of the config change it installs the
# codex-context-handoff plugin and turns its desktop popups off, so a handoff
# document is written before the context is compacted.
# ─────────────────────────────────────────────────────────────────────────────

CORE_URL="https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/scripts/install/codex_compact_config.py"
MARKETPLACE="Sunwaycoser/codex-context-handoff"
PLUGIN_ID="codex-context-handoff@codex-context-handoff"

MODE=apply
DRY_RUN=0
NO_AUTO_LIMIT=0
SKIP_PLUGIN=0
SKIP_VALIDATION=0
LIMIT_RATIO=0.9
CONFIG=""

usage() {
  cat <<'USAGE'
Codex non-GPT compaction installer (Linux)

  install-codex-compact-root.sh [OPTIONS]

  --revert            undo exactly the lines a previous run applied
  --dry-run           print the diff and change nothing
  --limit-ratio N     auto-compact threshold as a share of the window (0.5-1.0, default 0.9)
  --no-auto-limit     only declare the provider capability, leave the limit alone
  --skip-plugin       do not install the codex-context-handoff plugin
  --skip-validation   do not validate the edited config
  --config PATH       config.toml to edit (default: ${CODEX_HOME:-$HOME/.codex}/config.toml)
  -h, --help          show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --revert) MODE=revert ;;
    --dry-run) DRY_RUN=1 ;;
    --no-auto-limit) NO_AUTO_LIMIT=1 ;;
    --skip-plugin) SKIP_PLUGIN=1 ;;
    --skip-validation) SKIP_VALIDATION=1 ;;
    --limit-ratio) shift; LIMIT_RATIO="${1:?--limit-ratio needs a value}" ;;
    --limit-ratio=*) LIMIT_RATIO="${1#*=}" ;;
    --config) shift; CONFIG="${1:?--config needs a path}" ;;
    --config=*) CONFIG="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

drop_to_original_user() {
  # `curl ... | sudo bash` is how most people run installers, but under sudo
  # $HOME is /root and CODEX_HOME is stripped from the environment, so the
  # default path would point at root's Codex instead of the user's. When the
  # caller did not name a config explicitly, re-run as the user who invoked
  # sudo, inside a login shell so their PATH (~/.local/bin, nvm, ...) is set.
  #
  # SELFRUNNING guards against a loop should the drop-back not change the uid.
  [ "$(id -u)" = 0 ] || return 0
  [ -n "${SUDO_USER:-}" ] || return 0
  [ -n "${SELFRUNNING:-}" ] && return 0
  [ -z "$CONFIG" ] && [ -z "${CODEX_HOME:-}" ] || {
    echo "note: --config or CODEX_HOME was given, so root's environment is used as is." >&2
    return 0
  }
  getent passwd "$SUDO_USER" >/dev/null 2>&1 || {
    echo "error: sudo user '$SUDO_USER' has no passwd entry; cannot continue as them." >&2
    exit 1
  }

  # Only a script that exists as a file can be re-run. One that is piped in
  # (`bash -s`) cannot: bash executes it while still reading stdin, so by the
  # time this function runs the rest of the file has not arrived yet and no
  # complete copy exists. The root entry point handles that case by writing
  # the download to disk first, so only a direct `| sudo bash` of this file
  # lands here.
  if [ ! -f "$0" ] || [ -z "${BASH_SOURCE[0]:-}" ]; then
    cat >&2 <<'ADVICE'
error: this script was piped into bash and cannot re-run itself as the sudo user.

Run one of these instead, so the script exists as a file:

  curl -fsSL https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-compact-root.sh | sudo sh
  bash scripts/install/linux/install-codex-compact-root.sh          (no sudo)
  sudo bash scripts/install/linux/install-codex-compact-root.sh --config /home/you/.codex/config.toml
ADVICE
    exit 2
  fi
  [ -r "$0" ] || { echo "error: cannot read $0" >&2; exit 2; }

  local shell
  shell=$(getent passwd "$SUDO_USER" | cut -d: -f7)
  [ -x "$shell" ] || shell=/bin/bash
  export SELFRUNNING=1
  exec sudo -u "$SUDO_USER" -- "$shell" -l "$0" "$@"
}
find_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && \
      "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

disable_popups() {
  # The plugin shows a native desktop notification per reminder. Turning
  # "notify" off keeps the plain-text reminder and the handoff document.
  "$2" - "$1/codex-handoff.json" <<'PY'
import json, os, sys

path = os.path.expanduser(sys.argv[1])
data = {}
if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as stream:
            loaded = json.load(stream)
        if isinstance(loaded, dict):
            data = loaded
    except (OSError, ValueError):
        data = {}

if data.get("notify") is False:
    print("  - popups already disabled in " + path)
else:
    data["notify"] = False
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
    print("  - disabled codex-context-handoff popups in " + path)
PY
}

install_plugin() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "  - codex is not on PATH, so the codex-context-handoff plugin was skipped"
    return 0
  fi
  if [ -d "$1/plugins/cache/codex-context-handoff" ]; then
    echo "  - codex-context-handoff is already installed"
    disable_popups "$1" "$2"
    return 0
  fi
  echo "Installing the codex-context-handoff plugin (pre-compaction handoff notes)"
  # A marketplace that is already configured makes "add" fail; that is the
  # expected result on a re-run, so only the plugin install decides the outcome.
  codex plugin marketplace add "$MARKETPLACE" >/dev/null 2>&1 || true
  if codex plugin add "$PLUGIN_ID" >/dev/null 2>&1; then
    echo "  - plugin installed"
    disable_popups "$1" "$2"
  else
    echo "  ! could not install $PLUGIN_ID; the config patch is still applied" >&2
  fi
}

drop_to_original_user

CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
if [ -n "$CONFIG" ]; then
  CONFIG_PATH="$CONFIG"
else
  CONFIG_PATH="$CODEX_HOME_DIR/config.toml"
fi

PYTHON=""
if ! PYTHON=$(find_python); then
  echo "Python 3.8 or newer is required to patch config.toml safely." >&2
  echo "Install it once, then re-run this script:" >&2
  echo "  Debian/Ubuntu   apt-get install -y python3" >&2
  echo "  Fedora / RHEL   dnf install -y python3" >&2
  echo "  Alpine          apk add --no-cache python3" >&2
  echo "  Arch            pacman -S --needed python" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)
CORE="$SCRIPT_DIR/../codex_compact_config.py"
if [ ! -f "$CORE" ]; then
  CORE=$(mktemp "${TMPDIR:-/tmp}/codex-compact-core.XXXXXX")
  trap 'rm -f "$CORE"' EXIT HUP INT TERM
  if ! curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 "$CORE_URL" -o "$CORE"; then
    echo "error: could not download $CORE_URL" >&2
    echo "Run the installer from a clone instead, which carries the core script:" >&2
    echo "  git clone https://github.com/dieWehmut/Selbstlauf.git && bash Selbstlauf/install-codex-compact-root.sh" >&2
    exit 1
  fi
fi

EXTRA=()
[ "$DRY_RUN" = 1 ] && EXTRA+=(--dry-run)
[ "$SKIP_VALIDATION" = 1 ] && EXTRA+=(--skip-validation)
if [ "$MODE" = apply ]; then
  EXTRA+=(--limit-ratio "$LIMIT_RATIO")
  [ "$NO_AUTO_LIMIT" = 1 ] && EXTRA+=(--no-auto-limit)
fi

set +e
"$PYTHON" -X utf8 "$CORE" "$MODE" --config "$CONFIG_PATH" ${EXTRA[@]+"${EXTRA[@]}"}
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi

if [ "$MODE" = apply ] && [ "$DRY_RUN" = 0 ] && [ "$SKIP_PLUGIN" = 0 ]; then
  install_plugin "$CODEX_HOME_DIR" "$PYTHON"
fi

echo ""
if [ "$MODE" = revert ]; then
  echo "Reverted. Restart Codex so it reloads config.toml."
elif [ "$DRY_RUN" = 1 ]; then
  echo "Dry run only: config.toml was not modified."
else
  echo "Next steps:"
  echo "  1. Restart Codex so it reloads config.toml."
  echo "  2. In the Codex TUI run  /hooks  once and trust the codex-context-handoff hooks."
  echo "  3. To undo, run the same script again with --revert."
fi