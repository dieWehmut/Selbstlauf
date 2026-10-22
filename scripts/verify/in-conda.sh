#!/usr/bin/env bash
# Run checks with the environment's Node even when shell startup prepends nvm.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  printf 'Usage: %s COMMAND [ARG ...]\n' "$0" >&2
  exit 2
fi

task_environment="${SELBSTLAUF_CONDA_ENV:-selbstlauf-settings-20261022}"
task_conda="${CONDA_EXE:-conda}"
task_prefix="$($task_conda run --no-capture-output -n "$task_environment" python -c 'import sys; print(sys.prefix)')"
if [ ! -x "$task_prefix/bin/node" ]; then
  printf 'No Node executable in conda environment %s (%s)\n' "$task_environment" "$task_prefix" >&2
  exit 2
fi

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
task_browser_libraries="$task_root/tmp/browser-runtime/root/usr/lib/x86_64-linux-gnu"
task_browser_fonts="$task_root/tmp/browser-runtime/fonts.conf"
if [ -d "$task_browser_libraries" ]; then
  export LD_LIBRARY_PATH="$task_browser_libraries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
if [ -f "$task_browser_fonts" ]; then
  export FONTCONFIG_FILE="$task_browser_fonts"
fi

# Put this env invocation *inside* conda run: activation may itself source a
# shell profile that prepends a different Node installation.
exec "$task_conda" run --no-capture-output -p "$task_prefix" \
  /usr/bin/env PATH="$task_prefix/bin:$PATH" "$@"
