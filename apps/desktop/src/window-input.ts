import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Typing text into the window a session runs in.
 *
 * **Why this takes focus.** Measured in this session, against windows created for the purpose:
 *
 *     PostMessage(WM_CHAR) into a background window   -> delivers NOTHING (10 characters posted, control empty)
 *     SendInput                                       -> delivers, but only to the FOREGROUND window
 *     SetForegroundWindow from a background process   -> returns False (Windows' foreground lock)
 *     AttachThreadInput + SetFocus                    -> works, and VISIBLY TAKES FOCUS
 *     UI Automation ValuePattern                      -> its child controls are absent from the automation tree
 *                                                        while the window is minimized
 *
 * So there is no route that both delivers input and leaves focus alone. The user was told that and chose this
 * trade explicitly, so the focus is taken, the text is typed, and the previous foreground window is restored
 * immediately afterwards.
 *
 * **What it will never do.** The text is typed into whatever holds focus, so the helper refuses unless it has
 * confirmed the target really became the foreground window; if focus cannot be taken, nothing is typed. This
 * module adds a second refusal on top for the case the helper cannot see: a window that hosts **more than one
 * monitored session**. Measured on this machine, two Tabby Codex sessions share window handle 67008, and typing
 * into it would go to whichever terminal pane happens to be focused — which need not be the session the person
 * selected. That is a silent wrong-target failure, so it is refused outright.
 */

export interface WindowInputResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** The window's title, so a caller can state which window it typed into. */
  readonly title?: string;
  readonly typed?: number;
  readonly submitted?: boolean;
  readonly focusRestored?: boolean;
}

export interface WindowInputOptions {
  readonly powershellPath?: string;
  readonly scriptPath?: string;
  /** Overridden in tests so no child process is spawned and nothing is typed. */
  readonly runCommand?: (executable: string, args: readonly string[], stdin: string) => Promise<string>;
}

/** The longest line this will type, matching the service's own limit for injected text. */
export const MAX_TYPED_LENGTH = 4096;

export function resolveInputScriptPath(resourcesPath?: string): string {
  if (resourcesPath !== undefined && resourcesPath.trim().length > 0) {
    const packaged = resolve(resourcesPath, 'service-dist', 'src', 'process', 'window-input.ps1');
    if (existsSync(packaged)) return packaged;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(moduleDirectory, 'window-input.ps1');
  if (existsSync(sibling)) return sibling;
  return resolve(moduleDirectory, '../../../cli/src/process/window-input.ps1');
}

export function parseWindowInputResult(stdout: string): WindowInputResult | null {
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
  const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    ok: record.ok === true,
    ...(typeof record.reason === 'string' && record.reason.length > 0 ? { reason: record.reason } : {}),
    ...(typeof record.title === 'string' && record.title.length > 0 ? { title: record.title } : {}),
    ...(numberOrUndefined(record.typed) === undefined ? {} : { typed: numberOrUndefined(record.typed) as number }),
    ...(typeof record.submitted === 'boolean' ? { submitted: record.submitted } : {}),
    ...(typeof record.focusRestored === 'boolean' ? { focusRestored: record.focusRestored } : {}),
  };
}

async function runPowerShell(
  executable: string,
  args: readonly string[],
  stdin: string,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = execFile(executable, [...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(stdout);
      });
    // The text travels on stdin, never as an argument. Measured repeatedly in this project: a `-File` parameter
    // cannot bind an array, cannot bind a Boolean, and mangles non-ASCII through the console code page.
    child.stdin?.end(stdin);
  });
}

/**
 * Type a line into a window.
 *
 * @param handle - the window to type into, as process discovery reported it.
 * @param text - the line. Refused when empty, multi-line, or longer than the service's own limit.
 * @param submit - press Enter afterwards, so the window receives a completed line rather than a pending one.
 */
export async function typeIntoWindow(
  handle: number,
  text: string,
  submit: boolean,
  options: WindowInputOptions = {},
): Promise<WindowInputResult> {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    return { ok: false, reason: 'invalid-window-handle' };
  }
  // Refused here rather than in the helper, so the reason is stated without spawning a process.
  if (text.trim().length === 0) return { ok: false, reason: 'empty-text' };
  if (/[\r\n]/u.test(text)) return { ok: false, reason: 'multi-line-text' };
  if (text.length > MAX_TYPED_LENGTH) return { ok: false, reason: 'text-too-long' };

  const runCommand = options.runCommand ?? runPowerShell;
  const scriptPath = options.scriptPath ?? resolveInputScriptPath();
  const args = [
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
    'type',
    // A plain string, sent explicitly — the same `-File` binding rule that a `[bool]` parameter cannot satisfy.
    ...(submit ? ['-SubmitKey', 'enter'] : []),
  ];
  try {
    const stdout = await runCommand(options.powershellPath ?? 'powershell.exe', args, text);
    const result = parseWindowInputResult(stdout);
    return result ?? { ok: false, reason: 'unreadable-response' };
  } catch (error) {
    return { ok: false, reason: `type-command-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Whether a window may be typed into at all.
 *
 * A window hosting several monitored sessions is refused: the text would go to whichever terminal pane holds the
 * focus inside it, which need not be the session the person selected. Nothing in the window's own state reveals
 * that, so the only safe rule is to decline and say why.
 */
export function typingRefusal(sharedBy: number): string | null {
  if (sharedBy > 1) {
    return `该窗口内有 ${sharedBy} 个受监控会话，输入会送到其中当前获得焦点的那个，无法确定是你选的那个，因此不允许写入。`;
  }
  return null;
}