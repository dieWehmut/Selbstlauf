import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export interface CodexProcessContext {
  readonly commandLine: string;
  readonly cwd: string | null;
  readonly creationTimeMs: number;
  readonly activeThreadIds?: readonly string[];
}

export interface CodexThreadRecord {
  readonly id: string;
  readonly cwd: string | null;
  readonly createdAtMs: number | null;
  readonly updatedAtMs: number | null;
  readonly rolloutPath: string | null;
  readonly status?: string | null;
}

export interface RolloutActivitySnapshot {
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly changed: boolean;
  readonly threadStatus: string | null;
}

export interface RolloutActivity {
  snapshot(): Promise<RolloutActivitySnapshot>;
}

export type ThreadAssociationResult =
  | {
      readonly kind: 'matched';
      readonly thread: CodexThreadRecord;
      readonly activity: RolloutActivity;
    }
  | {
      readonly kind: 'ambiguous';
      readonly candidates: readonly string[];
      readonly reason: 'multiple-explicit-matches' | 'equally-recent-threads';
    }
  | {
      readonly kind: 'unmatched';
      readonly reason: 'no-resume-id' | 'resume-id-not-found' | 'no-cwd-match' | 'no-thread-index';
    };

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RESUME_PATTERN = new RegExp(`(?:^|[\\s"'])resume[\\s"']+(${UUID_PATTERN})(?=$|[\\s"'])`, 'i');

/** Extract only a canonical UUID token immediately following `resume`. */
export function extractResumeThreadId(commandLine: string): string | null {
  if (typeof commandLine !== 'string') return null;
  const match = RESUME_PATTERN.exec(commandLine);
  return match === null ? null : match[1].toLowerCase();
}

/**
 * Associate one discovered process with the Codex thread index.
 *
 * Explicit `resume <uuid>` commands always win. Initial commands are matched
 * by normalized working directory and creation-time proximity; a tie is
 * returned as `ambiguous` instead of guessing.
 */
export function associateCodexThread(
  process: CodexProcessContext,
  threads: readonly CodexThreadRecord[],
  options: { readonly activityFactory?: (thread: CodexThreadRecord) => RolloutActivity } = {},
): ThreadAssociationResult {
  const activityFactory = options.activityFactory ?? ((thread) => createRolloutActivity(thread.rolloutPath, thread.status));
  const resumeId = extractResumeThreadId(process.commandLine);
  if (resumeId !== null) {
    const explicit = threads.filter((thread) => thread.id.toLowerCase() === resumeId);
    if (explicit.length === 1) {
      return matched(explicit[0], activityFactory);
    }
    if (explicit.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: Object.freeze(explicit.map((thread) => thread.id)),
        reason: 'multiple-explicit-matches',
      };
    }
    return { kind: 'unmatched', reason: 'resume-id-not-found' };
  }

  if (process.cwd === null || threads.length === 0) {
    return { kind: 'unmatched', reason: threads.length === 0 ? 'no-thread-index' : 'no-cwd-match' };
  }
  const cwd = normalizePath(process.cwd);
  const cwdMatches = threads.filter((thread) => thread.cwd !== null && normalizePath(thread.cwd) === cwd);
  if (cwdMatches.length === 0) return { kind: 'unmatched', reason: 'no-cwd-match' };

  const activeIds = new Set((process.activeThreadIds ?? []).map((id) => id.toLowerCase()));
  const ranked = cwdMatches
    .map((thread) => ({
      thread,
      active: activeIds.has(thread.id.toLowerCase()) ? 1 : 0,
      distance: timeDistance(process.creationTimeMs, thread.createdAtMs),
      updatedAtMs: thread.updatedAtMs ?? Number.NEGATIVE_INFINITY,
    }))
    .sort((left, right) => {
      if (left.active !== right.active) return right.active - left.active;
      if (left.distance !== right.distance) return left.distance - right.distance;
      if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
      return left.thread.id.localeCompare(right.thread.id);
    });

  const best = ranked[0];
  if (best === undefined) return { kind: 'unmatched', reason: 'no-cwd-match' };
  const tied = ranked.filter(
    (candidate) =>
      candidate.active === best.active &&
      candidate.distance === best.distance &&
      candidate.updatedAtMs === best.updatedAtMs,
  );
  if (tied.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: Object.freeze(tied.map((candidate) => candidate.thread.id).sort()),
      reason: 'equally-recent-threads',
    };
  }
  return matched(best.thread, activityFactory);
}

function matched(
  thread: CodexThreadRecord,
  activityFactory: (thread: CodexThreadRecord) => RolloutActivity,
): Extract<ThreadAssociationResult, { kind: 'matched' }> {
  return {
    kind: 'matched',
    thread,
    activity: activityFactory(thread),
  };
}

function normalizePath(value: string): string {
  let normalized = value.trim().replace(/[\\/]+/g, sep).toLowerCase();
  // `resolve` normalizes dot segments but may throw for malformed input; the
  // original normalized value is still a safe comparison fallback.
  try {
    normalized = resolve(normalized).replace(/[\\/]+/g, sep).toLowerCase();
  } catch {
    // Keep the best-effort normalized path.
  }
  while (normalized.length > 1 && normalized.endsWith(sep)) normalized = normalized.slice(0, -1);
  return normalized;
}

function timeDistance(processTimeMs: number, threadTimeMs: number | null): number {
  if (!Number.isFinite(processTimeMs) || threadTimeMs === null || !Number.isFinite(threadTimeMs)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.abs(processTimeMs - threadTimeMs);
}

function createRolloutActivity(path: string | null, threadStatus: string | null | undefined): RolloutActivity {
  let previous: { size: number; mtimeMs: number } | null = null;
  let sampled = false;
  return {
    async snapshot(): Promise<RolloutActivitySnapshot> {
      if (path === null || path.trim().length === 0) {
        return Object.freeze({
          exists: false,
          size: 0,
          mtimeMs: 0,
          changed: false,
          threadStatus: threadStatus ?? null,
        });
      }
      try {
        const info = await stat(path);
        const current = { size: info.size, mtimeMs: info.mtimeMs };
        const changed =
          sampled &&
          (previous === null || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs);
        previous = current;
        sampled = true;
        return Object.freeze({
          exists: true,
          size: current.size,
          mtimeMs: current.mtimeMs,
          changed,
          threadStatus: threadStatus ?? null,
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          const changed = sampled && previous !== null;
          previous = null;
          sampled = true;
          return Object.freeze({
            exists: false,
            size: 0,
            mtimeMs: 0,
            changed,
            threadStatus: threadStatus ?? null,
          });
        }
        throw error;
      }
    },
  };
}
