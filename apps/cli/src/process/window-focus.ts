import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { ProcessCommandRunner } from './process-provider.js';

/**
 * Bring a watched session's window forward, or open its local interface.
 *
 * Focusing uses window-management calls only — never synthesized keyboard or
 * mouse input — so the watchdog can show a person where a session lives without
 * being able to type into anything.
 */

const execFileAsync = promisify(execFile);

export interface WindowFocusResult {
  readonly ok: boolean;
  /** True when the window became the foreground window (or a URL was opened). */
  readonly focused?: boolean;
  readonly reason?: string;
  readonly title?: string;
  readonly processId?: number;
}

export interface WindowFocusOptions {
  readonly powershellPath?: string;
  readonly scriptPath?: string;
  readonly runCommand?: ProcessCommandRunner;
}

function defaultScriptPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(moduleDirectory, 'window-focus.ps1');
  if (existsSync(sibling)) return sibling;
  return resolve(moduleDirectory, '../../../src/process/window-focus.ps1');
}

function parseResult(stdout: string): WindowFocusResult {
  const text = stdout.trim();
  if (text.length === 0) return { ok: false, reason: 'empty-response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'invalid-response' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'invalid-response' };
  const record = parsed as Record<string, unknown>;
  return {
    ok: record.ok === true,
    ...(typeof record.focused === 'boolean' ? { focused: record.focused } : {}),
    ...(typeof record.reason === 'string' && record.reason.length > 0 ? { reason: record.reason } : {}),
    ...(typeof record.title === 'string' && record.title.length > 0 ? { title: record.title } : {}),
    ...(typeof record.processId === 'number' && record.processId > 0 ? { processId: record.processId } : {}),
  };
}

async function runPowerShell(
  executable: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    windowsHide: true,
    maxBuffer: 1 * 1024 * 1024,
    encoding: 'utf8',
  });
  return result.stdout;
}

function baseArgs(scriptPath: string): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ];
}

/**
 * Raise an existing top-level window.
 * @param handle - the window handle reported by process discovery.
 * @param options - overrides for tests.
 * @returns whether the window became the foreground window.
 */
export async function focusWindow(
  handle: number,
  options: WindowFocusOptions = {},
): Promise<WindowFocusResult> {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    return { ok: false, reason: 'invalid-window-handle' };
  }
  const runCommand = options.runCommand ?? runPowerShell;
  const scriptPath = options.scriptPath ?? defaultScriptPath();
  try {
    const stdout = await runCommand(
      options.powershellPath ?? 'powershell.exe',
      [...baseArgs(scriptPath), '-Handle', String(handle)],
    );
    return parseResult(stdout);
  } catch (error) {
    return { ok: false, reason: `focus-command-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Open a local interface URL in the operator's default browser.
 * @param url - loopback http(s) URL; anything else is refused before spawning.
 * @param options - overrides for tests.
 * @returns whether the URL was handed to the shell.
 */
export async function openLocalUrl(
  url: string,
  options: WindowFocusOptions = {},
): Promise<WindowFocusResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-url' };
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    return { ok: false, reason: 'non-loopback-url' };
  }
  const runCommand = options.runCommand ?? runPowerShell;
  const scriptPath = options.scriptPath ?? defaultScriptPath();
  try {
    const stdout = await runCommand(
      options.powershellPath ?? 'powershell.exe',
      [...baseArgs(scriptPath), '-OpenUrl', parsed.href],
    );
    return parseResult(stdout);
  } catch (error) {
    return { ok: false, reason: `open-command-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}