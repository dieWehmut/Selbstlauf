import type { SessionView } from '../api/client';
import { writeEligibility } from '../session/write-eligibility';

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

/** The heading for the pinned group, which sits above every host group. */
export const PINNED_GROUP_LABEL = '置顶';

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

/**
 * Group sessions by host, with the pinned ones lifted into their own group on top.
 *
 * Pinning is how a person keeps the two or three sessions they are actually working in
 * within reach while the rest of the list churns; a pinned session is therefore *moved*
 * rather than duplicated, so the list stays a partition of the sessions and no row appears
 * twice.
 *
 * `pinnedIds` is in pin order, and that order is preserved inside the group: re-pinning
 * something moves it to the front, which is the behaviour of every list that supports this.
 * Ids with no matching session are ignored here rather than removed, so a session that
 * exits and comes back returns to its pin.
 */
export function groupSessionsByHost(
  sessions: readonly SessionView[],
  pinnedIds: readonly string[] = [],
): readonly SessionGroup[] {
  const pinnedRank = new Map<string, number>();
  pinnedIds.forEach((id, index) => {
    if (!pinnedRank.has(id)) pinnedRank.set(id, index);
  });

  const pinned: SessionView[] = [];
  const rest: SessionView[] = [];
  for (const session of sessions) {
    if (pinnedRank.has(session.id)) pinned.push(session);
    else rest.push(session);
  }

  const groups = new Map<string, { label: string; category: string; sessions: SessionView[] }>();
  for (const session of rest) {
    const host = session.host ?? null;
    /**
     * Groups follow the **application**, not the operating system.
     *
     * A session running inside WSL is grouped with the terminal that launched it — measured, a Codex session in
     * Ubuntu started from Tabby carries a Tabby host, because the interop socket pairs it with the `wsl.exe`
     * under that terminal. So a WSL session and a native one in the same terminal sit together, which is how a
     * person thinks about them.
     *
     * The distribution is only a fallback, for a WSL session whose launching terminal could not be established.
     * It is still better than the generic "host unrecognised", because the distribution is a true statement about
     * where the session runs — just a less useful grouping.
     */
    const hasHost = host !== null && host.label.trim().length > 0;
    const hasDistribution = session.distribution !== undefined && session.distribution.length > 0;
    const label = hasHost
      ? host.label
      : hasDistribution ? `WSL: ${session.distribution}` : UNKNOWN_HOST_LABEL;
    const category = hasHost ? host.category : hasDistribution ? 'terminal' : 'unknown';
    const existing = groups.get(label);
    if (existing === undefined) {
      groups.set(label, { label, category, sessions: [session] });
    } else {
      existing.sessions.push(session);
    }
  }

  const hostGroups = [...groups.values()]
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

  if (pinned.length === 0) return hostGroups;

  // Pinned rows keep pin order, so the most recently pinned sits first.
  pinned.sort((a, b) => (pinnedRank.get(a.id) ?? 0) - (pinnedRank.get(b.id) ?? 0));
  return [{ label: PINNED_GROUP_LABEL, category: 'pinned', sessions: pinned }, ...hostGroups];
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
 * The same id, shortened to what distinguishes two sessions of one tool in one host.
 *
 * A naive first-eight-characters slice is wrong for ids like
 * `session-b9dbc639-0a40-4eec-…`, where it yields `session-` — a prefix shared by every
 * session, so two such rows would look identical. A leading purely alphabetic segment is
 * therefore dropped as a type prefix, and the distinguishing part after it is shown instead.
 * That was visible in the running app as two rows both reading `步骤执行中 · session-`.
 */
export function conversationShortId(id: string | null | undefined): string | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  const parts = id.split('-').filter((part) => part.length > 0);
  // Drop a leading purely alphabetic segment when enough of the id remains to identify it.
  // `session-b9dbc639-…` must not shorten to `session-`, which every DSH session shares; a
  // short id like `demo-goal` keeps its prefix, because dropping it would lose information
  // the process table still shows.
  const dropPrefix = parts.length > 1
    && /^[A-Za-z]+$/u.test(parts[0])
    && parts.slice(1).join('-').length >= 8;
  const rest = (dropPrefix ? parts.slice(1) : parts).join('-');
  // A uuid-style id is shortened; a short human-written one is shown whole, so a name like
  // `demo-goal` is not clipped to something the table does not say.
  return rest.length <= 16 ? rest : rest.slice(0, 8);
}

/**
 * The dot beside a row.
 *
 * It now derives from the **same rule** the detail page uses, rather than a second implementation. The two used to
 * check different fields — the dot inspected `transportError` while the composer inspected `transport` — and on a
 * real session they disagreed: `codex:9232` has `transport: 'monitor-only'` with `transportError: 'no-cwd-match'`,
 * so the dot said 可写入 while its own detail page said 只能监控.
 */
export type SessionTone = 'writable' | 'monitor' | 'idle' | 'error';

export function sessionTone(session: SessionView): SessionTone {
  if (!session.alive) return 'error';
  // Paused is its own state: the session exists and could be written to, but not until it is resumed.
  if (session.paused) return 'monitor';
  return writeEligibility(session).writable ? 'writable' : 'monitor';
}

export function sessionToneLabel(tone: SessionTone): string {
  switch (tone) {
    case 'writable': return '可写入';
    case 'monitor': return '仅监控';
    case 'error': return '已停止';
    default: return '空闲';
  }
}

/**
 * Pin or unpin a session, returning the new pin order.
 *
 * Pinning puts the id at the front so the newest pin is the most prominent, and unpinning
 * removes it. An id already pinned is not duplicated, so a double click cannot corrupt the
 * order.
 */
export function togglePinnedId(pinnedIds: readonly string[], id: string): readonly string[] {
  if (pinnedIds.includes(id)) return pinnedIds.filter((entry) => entry !== id);
  return [id, ...pinnedIds];
}

/** The ids in `pinnedIds` that match a live session, in pin order. */
export function livePinnedIds(
  pinnedIds: readonly string[],
  sessions: readonly SessionView[],
): readonly string[] {
  const live = new Set(sessions.map((session) => session.id));
  return pinnedIds.filter((id) => live.has(id));
}