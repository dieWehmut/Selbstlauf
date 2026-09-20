import type { SessionView } from '../api/client';

/**
 * The sidebar's process list, grouped the way the reference sidebar groups its
 * conversations: a small grey section heading, then the rows, with the selected row
 * highlighted across its full width.
 *
 * Grouping is by the session's host — the application the CLI is running inside, which
 * the process table already shows as 运行位置 (`Tabby`, `Visual Studio Code`,
 * `dsh-shortcut`). That is the grouping a person recognises when looking for "the
 * Codex session I had open in Tabby", so the list reuses it rather than inventing a
 * second taxonomy.
 */

export interface SessionGroup {
  /** The host label, or the fallback for a session whose host was not identified. */
  readonly label: string;
  /** The host category, used only for ordering the groups predictably. */
  readonly category: string;
  readonly sessions: readonly SessionView[];
}

/** Sessions whose host could not be identified. */
export const UNKNOWN_HOST_LABEL = '未识别宿主';

/**
 * Order groups by category so the list is stable between polls, then by label.
 *
 * Without a fixed order the groups would reshuffle whenever a process appeared or
 * exited, which makes the list unusable for clicking.
 */
const CATEGORY_ORDER: readonly string[] = [
  'terminal',
  'editor',
  'desktop-app',
  'browser',
  'console',
  'shell',
  'unknown',
];

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

export function groupSessionsByHost(sessions: readonly SessionView[]): readonly SessionGroup[] {
  const groups = new Map<string, { label: string; category: string; sessions: SessionView[] }>();
  for (const session of sessions) {
    const host = session.host ?? null;
    const label = host === null || host.label.trim().length === 0 ? UNKNOWN_HOST_LABEL : host.label;
    const category = host?.category ?? 'unknown';
    const existing = groups.get(label);
    if (existing === undefined) {
      groups.set(label, { label, category, sessions: [session] });
    } else {
      existing.sessions.push(session);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      // Within a group, keep the furthest-silent first: those are the ones that need a
      // decision. The list is for finding the session to act on, not for browsing.
      sessions: [...group.sessions].sort((a, b) => (b.quietForMs ?? 0) - (a.quietForMs ?? 0)),
    }))
    .sort((a, b) => {
      const byCategory = categoryRank(a.category) - categoryRank(b.category);
      if (byCategory !== 0) return byCategory;
      return a.label.localeCompare(b.label, 'zh-Hans-CN');
    });
}

/** The label shown beside a row: the tool name, matching the process table. */
export function toolLabel(tool: string): string {
  switch (tool) {
    case 'codex': return 'Codex';
    case 'claude': return 'Claude';
    case 'opencode': return 'opencode';
    case 'dsh': return 'DeepSeek Harness';
    default: return tool;
  }
}

/** A compact silence duration, e.g. `18s`, `2m 12s`, `1h 04m`. */
export function formatSilence(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * What conversation a session is in, phrased the way the process table phrases it.
 *
 * Defined here rather than in the renderer so the sidebar list and the table cannot
 * describe the same session differently — they are two views of one value.
 */
export function conversationLabel(session: SessionView): string {
  if (session.tool === 'dsh') return session.runningTurn ? '步骤执行中' : '等待输入';
  return session.goal ? `Goal · ${session.goal.status}` : '普通对话';
}

/**
 * The conversation identity shown under each row: the label plus the id it is bound to.
 *
 * A session with no conversation says 未关联 rather than nothing, because "this process has
 * no conversation yet" is exactly what decides whether it can be continued.
 */
export function conversationDetail(session: SessionView): string {
  const id = session.conversationId;
  return `${conversationLabel(session)} · ${id === null || id.length === 0 ? '未关联' : id}`;
}

/**
 * The dot beside a row, which must agree with the process table's own badges.
 *
 * This mirrors the app's `canInject` rule rather than testing `transport` directly: the
 * reason a session cannot be written to lives in `transportError`, not in the transport
 * kind, so a transport comparison would have been wrong.
 */
export type SessionTone = 'writable' | 'monitor' | 'idle' | 'error';

/** The reasons a live session still cannot be written to, matching `canInject`. */
const INJECT_BLOCKERS: readonly string[] = ['monitor-only', 'cannot-inject', 'unknown'];

export function sessionTone(session: SessionView): SessionTone {
  if (!session.alive) return 'error';
  if (session.paused) return 'monitor';
  if (session.transportError !== undefined && INJECT_BLOCKERS.includes(session.transportError)) return 'monitor';
  return 'writable';
}

export function sessionToneLabel(tone: SessionTone): string {
  switch (tone) {
    case 'writable': return '可写入';
    case 'monitor': return '仅监控';
    case 'error': return '已停止';
    default: return '空闲';
  }
}