#!/usr/bin/env bash
# Behaviour of the Linux compaction installer when it is run through sudo.
#
# Nothing here needs root: `id`, `sudo`, `getent` and `codex` are stubbed on
# PATH, so the branching logic is exercised exactly as the real script sees
# it, without touching anyone's ~/.codex.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
impl="$repo_root/scripts/install/linux/install-codex-compact-root.sh"
entry="$repo_root/install-codex-compact-root.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

bash -n "$impl"
bash -n "$entry"
pass 'both scripts parse'

# ---------------------------------------------------------------- stubs ----
bin="$work/bin"; mkdir -p "$bin"
fake_home="$work/home/fakeuser"; mkdir -p "$fake_home/.codex"
printf 'model_provider = "OpenAI"\nmodel_context_window = 100000\n\n[model_providers.OpenAI]\nname = "OpenAI"\n' > "$fake_home/.codex/config.toml"
log="$work/stub.log"

# `id -u` answers from $STUB_UID; everything else passes through.
cat > "$bin/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then echo "${STUB_UID:-1000}"; else exec /usr/bin/id "$@"; fi
STUB
# Record the drop-back and *become* the target user by exporting the env the
# real sudo would set, then running the command in a login shell.
cat > "$bin/sudo" <<'STUB'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$STUB_LOG"
user=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in -u) user="$2"; shift 2;; --) shift;; *) args+=("$1"); shift;; esac
done
[ -n "$user" ] || exec "$@"
export STUB_UID=1000 STUB_DROPPED=1 HOME="$STUB_FAKE_HOME" SUDO_USER=""
exec "${args[@]}"
STUB
cat > "$bin/getent" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = passwd ] && [ "$2" = "${STUB_SUDO_USER:-}" ]; then
  echo "$2:x:1000:1000::$STUB_FAKE_HOME:/bin/bash"
else
  exit 2
fi
STUB
# A codex that only reports its presence; --skip-plugin keeps it unused anyway.
printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/codex"
chmod +x "$bin"/*

run_as_root() {  # run_as_root <extra args...>
  STUB_UID=0 STUB_LOG="$log" STUB_FAKE_HOME="$fake_home" STUB_SUDO_USER=fakeuser \
  SUDO_USER=fakeuser HOME=/root PATH="$bin:/usr/bin:/bin" \
    bash "$impl" --skip-plugin "$@"
}

# ------------------------------------------------- drops back to the user ----
out=$(run_as_root --dry-run 2>&1) || fail "sudo run failed: $out"
grep -q '^sudo -u fakeuser -- /bin/bash -l ' "$log" || fail "did not re-run as SUDO_USER; log: $(cat "$log")"
grep -q "$fake_home/.codex/config.toml" <<<"$out" || fail "patched the wrong config: $out"
grep -q '/root/.codex' <<<"$out" && fail "touched /root/.codex"
pass 'sudo run re-execs as SUDO_USER and targets their ~/.codex/config.toml'

# -------------------------------------------------- no loop on the re-exec ----
: > "$log"
STUB_UID=0 SELFRUNNING=1 STUB_LOG="$log" STUB_FAKE_HOME="$fake_home" STUB_SUDO_USER=fakeuser \
  SUDO_USER=fakeuser HOME=/root PATH="$bin:/usr/bin:/bin" \
  bash "$impl" --skip-plugin --dry-run --config "$fake_home/.codex/config.toml" >/dev/null 2>&1 \
  || fail 're-exec guard broke the run'
[ -s "$log" ] && fail "re-exec looped; log: $(cat "$log")"
pass 'SELFRUNNING guard prevents a re-exec loop'

# ---------------------------------------- explicit --config is left alone ----
: > "$log"
out=$(run_as_root --dry-run --config "$fake_home/.codex/config.toml" 2>&1) || fail "explicit --config run failed: $out"
[ -s "$log" ] && fail "re-ran as the user although --config was explicit; log: $(cat "$log")"
grep -q "note: --config or CODEX_HOME was given" <<<"$out" || fail "missing the explicit-config note: $out"
pass 'explicit --config keeps the root environment and says so'

# ---------------------------------------- explicit CODEX_HOME is left alone ----
: > "$log"
out=$(STUB_UID=0 STUB_LOG="$log" STUB_FAKE_HOME="$fake_home" STUB_SUDO_USER=fakeuser \
  SUDO_USER=fakeuser HOME=/root CODEX_HOME="$fake_home/.codex" PATH="$bin:/usr/bin:/bin" \
  bash "$impl" --skip-plugin --dry-run 2>&1) || fail "CODEX_HOME run failed: $out"
[ -s "$log" ] && fail "re-ran as the user although CODEX_HOME was explicit; log: $(cat "$log")"
grep -q "$fake_home/.codex/config.toml" <<<"$out" || fail "CODEX_HOME was not honoured: $out"
pass 'explicit CODEX_HOME is honoured without re-running'

# ------------------------------------------------------- not root: no-op ----
: > "$log"
out=$(STUB_UID=1000 STUB_LOG="$log" STUB_FAKE_HOME="$fake_home" \
  SUDO_USER= HOME="$fake_home" PATH="$bin:/usr/bin:/bin" \
  bash "$impl" --skip-plugin --dry-run 2>&1) || fail "non-root run failed: $out"
[ -s "$log" ] && fail "non-root run tried to use sudo; log: $(cat "$log")"
grep -q "$fake_home/.codex/config.toml" <<<"$out" || fail "non-root run patched the wrong config: $out"
pass 'non-root run never touches sudo'

# --------------------------------- root without SUDO_USER: stays as root ----
: > "$log"
out=$(STUB_UID=0 STUB_LOG="$log" STUB_FAKE_HOME="$fake_home" \
  SUDO_USER= HOME=/root PATH="$bin:/usr/bin:/bin" \
  bash "$impl" --skip-plugin --dry-run 2>&1) && rc=0 || rc=$?
[ -s "$log" ] && fail "plain root run tried to use sudo; log: $(cat "$log")"
# Root has no ~/.codex/config.toml here, and the core must refuse rather than
# create one out of thin air. The path in the error proves which home it used.
[ "$rc" -eq 1 ] || fail "plain root run returned $rc, expected 1: $out"
grep -q 'config file not found: /root/.codex/config.toml' <<<"$out" || fail "plain root did not use root's config: $out"
pass 'root without SUDO_USER keeps root environment and refuses a missing config'

# ------------------------------------------ piped directly: refuses cleanly ----
out=$(STUB_UID=0 STUB_LOG="$log" STUB_FAKE_HOME="$fake_home" STUB_SUDO_USER=fakeuser \
  SUDO_USER=fakeuser HOME=/root PATH="$bin:/usr/bin:/bin" \
  bash -s -- --dry-run --skip-plugin < "$impl" 2>&1) && rc=0 || rc=$?
[ "$rc" -eq 2 ] || fail "piped run returned $rc, expected 2: $out"
grep -q 'cannot re-run itself as the sudo user' <<<"$out" || fail "piped run lacks the advice: $out"
pass 'implementation piped into sudo bash refuses with advice (exit 2)'

# --------------------------- entry point piped in does not trust the cwd ----
# A checkout-shaped directory in the cwd must NOT be picked up when the entry
# script arrives on stdin; it has to download instead. Point the download at
# a dead port so the test ends quickly and deterministically.
decoy="$work/decoy"; mkdir -p "$decoy/scripts/install/linux"
echo 'echo DECOY-RAN' > "$decoy/scripts/install/linux/install-codex-compact-root.sh"
sed_entry="$work/entry.sh"
sed "s#^REMOTE_URL=.*#REMOTE_URL=\"http://127.0.0.1:9/none\"#" "$entry" > "$sed_entry"
out=$(cd "$decoy" && STUB_UID=1000 PATH="$bin:/usr/bin:/bin" sh -s < "$sed_entry" 2>&1) && rc=0 || rc=$?
[ "$rc" -eq 1 ] || fail "entry piped from a decoy cwd returned $rc, expected 1: $out"
grep -q 'DECOY-RAN' <<<"$out" && fail "entry piped on stdin executed a file from the cwd"
grep -q 'could not download' <<<"$out" || fail "entry did not report the failed download: $out"
pass 'entry piped on stdin downloads instead of trusting the cwd'

printf '\nAll %s linux compaction sudo tests passed.\n' "$(grep -c '^pass ' "$0")"