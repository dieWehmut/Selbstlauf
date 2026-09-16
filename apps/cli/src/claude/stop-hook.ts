import { stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

import { ClaudeLeaseStore } from './lease-store.js';

const MAX_IDENTITY_LENGTH = 512;
const SYSTEM_MESSAGE = 'Continuation watchdog submitted a follow-up.';

export interface ClaudeStopHookInput {
  readonly hook_event_name: 'Stop';
  readonly session_id: string;
  readonly cwd: string;
  readonly transcript_path: string;
  readonly stop_hook_active: false;
}

export interface ClaudeStopHookBlockDecision {
  readonly decision: 'block';
  readonly reason: string;
  readonly systemMessage: string;
}

export type ClaudeStopHookDecision = ClaudeStopHookBlockDecision | Record<string, never>;

/** Resolve one Claude Stop Hook invocation without reading transcript contents. */
export async function decideClaudeStopHook(
  store: ClaudeLeaseStore | null | undefined,
  input: unknown,
): Promise<ClaudeStopHookDecision> {
  try {
    if (store === null || store === undefined) return {};
    const hook = parseInput(input);
    if (hook === null) return {};

    const transcript = await stat(hook.transcript_path);
    if (!transcript.isFile()) return {};
    const lease = await store.consume({
      sessionId: hook.session_id,
      cwd: hook.cwd,
      transcriptPath: hook.transcript_path,
      activity: { size: transcript.size, mtimeMs: transcript.mtimeMs },
    });
    if (lease === null) return {};
    return {
      decision: 'block',
      reason: lease.prompt,
      systemMessage: SYSTEM_MESSAGE,
    };
  } catch {
    return {};
  }
}

function parseInput(value: unknown): ClaudeStopHookInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.hook_event_name !== 'Stop' || input.stop_hook_active !== false) return null;
  if (!isBoundedText(input.session_id) || !isAbsolutePath(input.cwd) || !isAbsolutePath(input.transcript_path)) {
    return null;
  }
  return {
    hook_event_name: 'Stop',
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    stop_hook_active: false,
  };
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 &&
    value.length <= MAX_IDENTITY_LENGTH && !/[\u0000\r\n]/u.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return isBoundedText(value) && (isAbsolute(value) || win32.isAbsolute(value));
}
