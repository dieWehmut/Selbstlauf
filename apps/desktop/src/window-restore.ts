import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Showing a minimized window just long enough to capture it, then putting it back.
 *
 * Electron's `desktopCapturer` does not enumerate a minimized window at all — measured, it is absent from
 * `getSources` while minimized and reappears once shown — and rendering one with `PrintWindow` at its restore
 * size comes back flat, because a minimized window has no rendered surface. So the only way to show a person
 * what is inside one is to let it render briefly.
 *
 * Both directions use the *non-activating* variants: `SW_SHOWNOACTIVATE` maps the window without taking
 * focus and `SW_SHOWMINNOACTIVE` minimizes it again without taking focus, so a preview never steals the caret
 * from whatever the user is typing into, and the foreground window is the same afterwards as before.
 *
 * These are window-management calls only. No keyboard or mouse input is ever synthesized, so this cannot type
 * into anything.
 */

export interface WindowRestoreOptions {
  readonly powershellPath?: string;
  readonly scriptPath?: string;
  /** Injected in tests so no child process is spawned. */
  readonly runCommand?: (executable: string, args: readonly string[]) => Promise<string>;
}

/**
 * Resolve the helper script.
 *
 * It ships inside the service's own tree, beside `window-focus.ps1`, because that tree is already copied
 * into the packaged resources — so there is one asset layout rather than two. A checkout falls back to the
 * source path.
 */
export function resolveRestoreScriptPath(resourcesPath?: string): string {
  if (resourcesPath !== undefined && resourcesPath.trim().length > 0) {
    const packaged = resolve(resourcesPath, 'service-dist', 'src', 'process', 'window-restore.ps1');
    if (existsSync(packaged)) return packaged;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(moduleDirectory, 'window-restore.ps1');
  if (existsSync(sibling)) return sibling;
  return resolve(moduleDirectory, '../../../cli/src/process/window-restore.ps1');
}

interface RestoreState {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly nowMinimized: boolean;
  readonly foregroundBefore: number | null;
  readonly foregroundAfter: number | null;
  readonly reason?: string;
}

function parseState(stdout: string): RestoreState | null {
  const text = stdout.trim();
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    ok: record.ok === true,
    changed: record.changed === true,
    nowMinimized: record.nowMinimized === true,
    foregroundBefore: numberOrNull(record.foregroundBefore),
    foregroundAfter: numberOrNull(record.foregroundAfter),
    ...(typeof record.reason === 'string' && record.reason.length > 0 ? { reason: record.reason } : {}),
  };
}

async function runPowerShell(executable: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return result.stdout;
}

async function invokeRestore(
  handle: number,
  mode: 'show' | 'minimize',
  options: WindowRestoreOptions,
  wasMinimized = false,
): Promise<RestoreState | null> {
  if (!Number.isSafeInteger(handle) || handle <= 0) return null;
  const runCommand = options.runCommand ?? runPowerShell;
  const scriptPath = options.scriptPath ?? resolveRestoreScriptPath();
  try {
    const stdout = await runCommand(options.powershellPath ?? 'powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Handle',
      String(handle),
      '-Mode',
      mode,
      // Sent only for the undo, and as a plain single string: a `[bool]` parameter cannot be bound through
      // `-File` at all, which is the same binding rule that broke the window-title markers.
      ...(mode === 'minimize' ? ['-WasMinimized', wasMinimized ? 'true' : 'false'] : []),
    ]);
    return parseState(stdout);
  } catch {
    return null;
  }
}

/**
 * Show a minimized window without activating it.
 * @returns whether the window was actually shown, so the caller knows a capture is now possible.
 */
export async function showWindowWithoutActivating(
  handle: number,
  options: WindowRestoreOptions = {},
): Promise<boolean> {
  const state = await invokeRestore(handle, 'show', options);
  if (state === null || !state.ok) return false;
  // `nowMinimized` is the answer that matters: it says whether the window is rendering and can therefore be
  // captured. It is false for a window that was already visible, which needs no showing at all.
  return !state.nowMinimized;
}

/**
 * Put the window back the way it was found.
 *
 * `wasMinimized` must be the caller's own record of whether it restored this window, and nothing is done
 * unless it is true. That flag exists because inferring it from the window is wrong: the first version
 * minimized any window that was not minimized, so previewing an ordinary open window whose first capture
 * happened to fail would minimize the window the user was looking at.
 *
 * @returns whether the window is minimized now.
 */
export async function minimizeWindowAgain(
  handle: number,
  wasMinimized: boolean,
  options: WindowRestoreOptions = {},
): Promise<boolean> {
  if (!wasMinimized) return true;
  const state = await invokeRestore(handle, 'minimize', options, true);
  return state !== null && state.ok && state.nowMinimized;
}