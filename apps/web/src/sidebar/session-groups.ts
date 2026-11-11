import type { SessionView } from '../api/client';
import { isAdditionalMonitoredTool } from '../session/monitoring-reasons';
import { translate, getLocale, type Locale } from '../i18n';
import { writeEligibility } from '../session/write-eligibility';

/** A workspace belongs to an execution environment, never to a terminal window title. */
export interface SessionProjectGroup {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly path: string | null;
  readonly sessions: readonly SessionView[];
}

export interface SessionEnvironmentGroup {
  readonly id: string;
  readonly label: string;
  readonly projects: readonly SessionProjectGroup[];
}

export const UNKNOWN_PROJECT_LABEL = '未识别项目目录';

/** Keep the original root, including drive/UNC roots; never guess from a host window's title. */
export function sessionProject(session: SessionView, locale: Locale = getLocale()): Omit<SessionProjectGroup, 'sessions'> {
  const raw = session.sessionCwd?.trim();
  if (!raw) return { id: 'unknown', label: translate(UNKNOWN_PROJECT_LABEL, {}, locale), name: translate(UNKNOWN_PROJECT_LABEL, {}, locale), path: null };
  const windows = /^[a-z]:[\\/]/iu.test(raw) || raw.startsWith('\\\\')
    || (raw.startsWith('//') && session.platform !== 'linux' && !session.distribution);
  let path = windows ? raw.replace(/\\/gu, '/') : raw;
  if (windows) path = path.replace(/^\/\/\?\/UNC\//iu, '//').replace(/^\/\/\?\//u, '');
  const unc = windows && path.startsWith('//');
  path = path.replace(/\/{2,}/gu, '/');
  if (unc) path = `/${path}`;
  if (path !== '/' && !/^[a-z]:\/$/iu.test(path)) path = path.replace(/\/+$/u, '');
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  return { id: windows ? path.toLowerCase() : path, label: path, name, path };
}

export function sessionEnvironment(session: SessionView, locale: Locale = getLocale()): { id: string; label: string } {
  const distro = session.distribution?.trim();
  if (distro) return { id: `wsl:${distro.toLowerCase()}`, label: `WSL · ${distro}` };
  if (session.platform === 'linux' || (!session.platform && /^\/(?!\/)/u.test(session.sessionCwd ?? ''))) return { id: 'linux', label: 'Linux' };
  if (session.platform === 'darwin') return { id: 'darwin', label: 'macOS' };
  return { id: 'windows', label: 'Windows' };
}

/** Pins stay in their workspace so their root and environment never disappear. */
export function groupSessionsByEnvironment(
  sessions: readonly SessionView[],
  pinnedIds: readonly string[] = [],
  locale: Locale = getLocale(),
): readonly SessionEnvironmentGroup[] {
  const pins = new Map(pinnedIds.map((id, index) => [id, index]));
  const environments = new Map<string, { id: string; label: string; projects: Map<string, SessionProjectGroup & { sessions: SessionView[] }> }>();
  for (const session of sessions) {
    const env = sessionEnvironment(session, locale);
    let group = environments.get(env.id);
    if (!group) { group = { ...env, projects: new Map() }; environments.set(env.id, group); }
    const project = sessionProject(session, locale);
    const existing = group.projects.get(project.id);
    if (existing) existing.sessions.push(session);
    else group.projects.set(project.id, { ...project, sessions: [session] });
  }
  return [...environments.values()]
    .sort((a, b) => (a.id === 'windows' ? -1 : b.id === 'windows' ? 1 : a.label.localeCompare(b.label, locale)))
    .map((env) => ({ ...env, projects: [...env.projects.values()]
      .sort((a, b) => a.path === null ? 1 : b.path === null ? -1 : a.label.localeCompare(b.label, locale))
      .map((project) => ({ ...project, sessions: project.sessions.sort((a, b) => {
        const pin = (pins.get(a.id) ?? Infinity) - (pins.get(b.id) ?? Infinity);
        if (pin && !Number.isNaN(pin)) return pin;
        const activity = (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0);
        return activity || a.id.localeCompare(b.id);
      }) })) }));
}

export type SessionActivity = 'running' | 'idle' | 'stopped' | 'unknown' | 'paused' | 'disabled';
export function sessionActivity(session: SessionView): SessionActivity {
  if (!session.alive) return 'stopped';
  if (isAdditionalMonitoredTool(session.tool) && session.paused) return 'paused';
  if (isAdditionalMonitoredTool(session.tool) && !session.enabled) return 'disabled';
  if (session.runningTurn === true) return 'running';
  if (session.runningTurn === false) return 'idle';
  return 'unknown';
}
export function sessionActivityLabel(activity: SessionActivity, locale?: Locale): string {
  return translate({ running: '运行中', idle: '空闲', stopped: '已停止', unknown: '状态未知', paused: '已暂停', disabled: '监控已关闭' }[activity], {}, locale);
}

/** The label shown beside a row: the tool name, matching the process table. */
export { toolLabel } from './tool-labels';

/**
 * How long a session has been quiet, or null when that is not known.
 *
 * The service sends `quietForMs: null` when it has no last-activity time at all (`lastActivityAtMs === null ?
 * null : …` in the watchdog controller). The app's surfaces disagreed about what that meant: the table and the
 * detail page fell back to `lastActivityAtMs` and otherwise said nothing, while the sidebar row and the mobile
 * card read it as `0` — claiming the session had been active this very second, which is the opposite of
 * "unknown". One function, so they cannot drift apart again.
 *
 * A `0` the service really computed is kept: that is "quiet for no measurable time", not "unknown".
 */
export function quietMs(
  session: Pick<SessionView, 'quietForMs' | 'lastActivityAtMs'>,
  now = Date.now(),
): number | null {
  if (typeof session.quietForMs === 'number') return session.quietForMs;
  if (session.lastActivityAtMs === null) return null;
  // A clock that moved backwards since the last activity cannot produce a negative silence.
  return Math.max(0, now - session.lastActivityAtMs);
}

/**
 * The app's one duration, e.g. `18s`, `2m 05s`, `1h 04m`; a dash when the duration is not known.
 *
 * This was two functions: the sidebar's `formatSilence` and the overview table's own `duration`. They differed
 * on the padding and on the unknown glyph — the table wrote `2m 5s` and `--` where the sidebar wrote `2m 05s`
 * and `—` — while both are shown *beside each other* for the same session. The padded form and the em dash are
 * the ones that survived, so a column and a row describing one value now describe it identically.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
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
export function conversationLabel(session: SessionView, locale?: Locale): string {
  if (session.tool === 'dsh') return translate(session.runningTurn ? '步骤执行中' : '等待输入', {}, locale);
  const goalLabels: Readonly<Record<string, string>> = {
    active: '进行中', paused: '已暂停', complete: '已完成', blocked: '受阻',
    budget_limited: '预算已达上限', usage_limited: '用量已达上限', unknown: '未知',
  };
  return session.goal ? `Goal · ${translate(goalLabels[session.goal.status] ?? session.goal.status, {}, locale)}` : translate('普通对话', {}, locale);
}

/**
 * The conversation identity shown under each row: the label plus the id it is bound to.
 *
 * A session with no conversation says 未关联 rather than nothing, because "this process has
 * no conversation yet" is exactly what decides whether it can be continued.
 */
export function conversationDetail(session: SessionView, locale?: Locale): string {
  const id = session.conversationId;
  return `${conversationLabel(session, locale)} · ${id === null || id.length === 0 ? translate('未关联', {}, locale) : id}`;
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

export function sessionToneLabel(tone: SessionTone, locale?: Locale): string {
  switch (tone) {
    case 'writable': return translate('可写入', {}, locale);
    case 'monitor': return translate('仅监控', {}, locale);
    case 'error': return translate('已停止', {}, locale);
    default: return translate('空闲', {}, locale);
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
