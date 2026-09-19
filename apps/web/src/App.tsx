import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  CircleAlert,
  CircleArrowUp,
  CirclePause,
  CirclePlay,
  Copy,
  Gauge,
  LayoutDashboard,
  ListTree,
  Menu,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Power,
  RefreshCw,
  Save,
  Send,
  Settings2,
  ShieldAlert,
  SquareArrowOutUpRight,
  Sun,
  Terminal,
  Trash2,
  Unplug,
  UserCheck,
  Webhook,
  X,
} from 'lucide-react';
/** Bundled with the app so the Pages sub-path rewrites it like any other asset. */
import brandIcon from './assets/brand.png';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  createApi,
  type AuditEvent,
  type ClaudeHookStatusView,
  type CodexProfileFieldView,
  type CodexProfilesView,
  type EnvironmentToolView,
  type EnvironmentView,
  type ToolState,
  type HealthView,
  type SessionView,
  type WatchdogApi,
  type WatchdogEvent,
  type WatchdogConfig,
} from './api/client';
import { SettingsRail, SETTINGS_SECTION_IDS } from './settings/SettingsRail';
import {
  AccountSection,
  BrowserSection,
  ComputerControlSection,
  ImportSection,
  NotificationsSection,
  ParentalSection,
  PersonalizationSection,
  PetSection,
  PluginsSection,
  ProfileSection,
  ShortcutsSection,
  SnapshotsSection,
  TrustedContactSection,
  UsageSection,
  VoiceSection,
  describeTrustedContact,
} from './settings/sections';
import {
  NOTIFICATIONS_DEFAULTS,
  PARENTAL_DEFAULTS,
  PREF_KEYS,
  PROFILE_DEFAULTS,
  TRUSTED_CONTACT_DEFAULTS,
  hashPin,
  isNotificationsPref,
  isParentalPref,
  isProfilePref,
  isTrustedContactPref,
  readPref,
  writePref,
  type ProfilePref,
} from './settings/desktop-prefs';

/** Shown by the account section and the sidebar; tracks the package version. */
const APP_VERSION = '0.2.3';

/** 电脑操控's single switch. */
function isRevealPref(value: unknown): value is { allowReveal: boolean } {
  return typeof value === 'object' && value !== null
    && typeof (value as { allowReveal?: unknown }).allowReveal === 'boolean';
}

type Page = 'overview' | 'timeline' | 'settings';
/** What the person chose; 'system' resolves against the OS preference. */
type ThemePreference = 'light' | 'dark' | 'system';
type Theme = 'light' | 'dark';

/**
 * The desktop shell bridge, when the page is running inside Electron.
 *
 * The renderer draws its own `文件 编辑 视图 帮助` row because the native menu
 * bar is hidden behind the custom title bar, so these are the window operations
 * those menus drive. Everything is optional: in a plain browser (the Vite dev
 * server, the static Pages demo) the object is absent and the corresponding
 * menu items render disabled rather than throwing.
 */
interface DesktopShellBridge {
  reload(): void;
  toggleFullScreen(): void;
  /** +1 zooms in, -1 zooms out, 0 returns to 100%. */
  zoom(delta: number): void;
  quit(): void;
  openExternal(url: string): Promise<void>;
  /**
   * Repaint the native window-button strip.
   *
   * The title bar is painted from the live palette, so it changes with the
   * theme, the contrast slider and the accent. Reporting the colour actually
   * used keeps the OS-drawn buttons on the same surface instead of leaving the
   * top row split into two strips.
   */
  setTitleBarOverlay?(colors: { color: string; symbolColor?: string }): void;
}

interface DesktopBridge {
  readonly shell?: Partial<DesktopShellBridge>;
  readonly settings?: {
    get(): Promise<{ closeToTray?: boolean; preferredTerminal?: string | null }>;
    set(patch: { closeToTray?: boolean; preferredTerminal?: string }): Promise<unknown>;
  };
  /** Named commands from the menu bar and the tray. */
  onCommand?(listener: (payload: { command?: string; section?: string }) => void): () => void;
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as { selbstlaufDesktop?: unknown }).selbstlaufDesktop;
  return bridge !== null && typeof bridge === 'object' ? (bridge as DesktopBridge) : null;
}

/**
 * The settings navigation.
 *
 * The reference console groups its settings into two labelled categories, so the
 * rail replaces the earlier flat three-tab strip. Section content lives in
 * `./settings/sections`; this file only decides which section is in view and
 * hands each one its live data.
 */
export const DEFAULT_SETTINGS_SECTION = 'general';

/**
 * The trusted contact summary shown beside the notification switches.
 *
 * The contact is edited on its own rail entry, so this is the read-only line the
 * reference console puts next to the notifications.
 */
function TrustedContactSummarySection() {
  const contact = readPref(PREF_KEYS.trustedContact, TRUSTED_CONTACT_DEFAULTS, isTrustedContactPref);
  return (
    <section className="settings-section settings-section--wide">
      <div className="section-title"><div><span className="eyebrow">Contact</span><h2>Trusted contact</h2></div><UserCheck size={20} /></div>
      <p className="section-hint">{describeTrustedContact(contact)}</p>
    </section>
  );
}

const THEME_QUERY = '(prefers-color-scheme: light)';

/** Resolve a stored preference to the colour scheme actually applied. */
function resolveTheme(preference: ThemePreference, prefersLight: boolean): Theme {
  if (preference === 'system') return prefersLight ? 'light' : 'dark';
  return preference;
}

/** Font stacks the appearance section can switch between. */
type FontChoice = 'system' | 'mono' | 'serif';

/** What the body text renders in, and how heavy it sits. */
interface TypeSetting {
  readonly family: FontChoice;
  /** 400 or 500; the reference pairs the family pick with a weight pick. */
  readonly weight: 400 | 500;
}

/** A per-theme palette chosen in the appearance section. */
interface ThemePalette {
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
  /** 0-100 slider; feeds the surface and border mixes below. */
  readonly contrast: number;
  /** Draw the sidebar as a translucent layer over the page background. */
  readonly translucentSidebar: boolean;
  /** The interface chrome's type. */
  readonly uiType: TypeSetting;
  /** The reading surfaces' type; "same" reuses the interface stack. */
  readonly contentType: TypeSetting & { readonly sameAsUi: boolean };
}

/** The palette each theme starts from; also what reset returns to. */
const DEFAULT_PALETTES: Record<Theme, ThemePalette> = {
  dark: {
    accent: '#e6b65b', background: '#0d1216', foreground: '#e9eef0', contrast: 68,
    translucentSidebar: false,
    uiType: { family: 'system', weight: 400 },
    contentType: { family: 'system', weight: 400, sameAsUi: true },
  },
  light: {
    accent: '#a56a08', background: '#eef2f1', foreground: '#1c262b', contrast: 68,
    translucentSidebar: false,
    uiType: { family: 'system', weight: 400 },
    contentType: { family: 'system', weight: 400, sameAsUi: true },
  },
};

const FONT_CHOICES: readonly FontChoice[] = ['system', 'mono', 'serif'];

function normalizeType(value: unknown, fallback: TypeSetting): TypeSetting {
  if (value === null || typeof value !== 'object') return fallback;
  const entry = value as { family?: unknown; weight?: unknown };
  return {
    family: FONT_CHOICES.includes(entry.family as FontChoice) ? (entry.family as FontChoice) : fallback.family,
    weight: entry.weight === 500 ? 500 : fallback.weight,
  };
}

/**
 * The shape a saved palette must have.
 *
 * Saves from an earlier build lack the type and layout fields, so each missing
 * field falls back rather than discarding the whole palette.
 */
function normalizePalette(value: unknown, fallback: ThemePalette): ThemePalette {
  if (value === null || typeof value !== 'object') return fallback;
  const entry = value as Partial<Record<keyof ThemePalette, unknown>>;
  const colour = (key: 'accent' | 'background' | 'foreground') =>
    typeof entry[key] === 'string' && HEX_COLOR.test(entry[key] as string) ? (entry[key] as string) : fallback[key];
  const contentType = value as { contentType?: unknown };
  const content = normalizeType(contentType.contentType, fallback.contentType);
  return {
    accent: colour('accent'),
    background: colour('background'),
    foreground: colour('foreground'),
    contrast: typeof entry.contrast === 'number' && Number.isFinite(entry.contrast)
      ? Math.min(100, Math.max(0, Math.round(entry.contrast)))
      : fallback.contrast,
    translucentSidebar: typeof entry.translucentSidebar === 'boolean' ? entry.translucentSidebar : fallback.translucentSidebar,
    uiType: normalizeType(entry.uiType, fallback.uiType),
    contentType: {
      ...content,
      sameAsUi: (contentType.contentType as { sameAsUi?: unknown } | undefined)?.sameAsUi !== false,
    },
  };
}

/** Ready-made accents, so the common pick needs no colour wheel. */
const ACCENT_PRESETS: readonly { readonly label: string; readonly value: string }[] = [
  { label: '粉色', value: '#e05c93' },
  { label: '天蓝', value: '#4c9cd4' },
  { label: '翠绿', value: '#5aa97c' },
  { label: '石墨', value: '#8a949b' },
];

const PALETTE_STORAGE_KEY = 'watchdog-palette';
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

/** Accept only the required #rrggbb fields, so a bad import cannot half-apply. */
function isThemePalette(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<Record<keyof ThemePalette, unknown>>;
  return (['accent', 'background', 'foreground'] as const).every((key) =>
    typeof entry[key] === 'string' && HEX_COLOR.test(entry[key] as string));
}

/** The CSS font stack behind each choice. */
function fontStack(choice: FontChoice): string {
  if (choice === 'mono') return "var(--mono)";
  if (choice === 'serif') return "Georgia, 'Times New Roman', serif";
  return "'Segoe UI Variable', 'Segoe UI', sans-serif";
}

/** Load the saved overrides; a missing or corrupt entry just means "default". */
function loadPaletteOverrides(): Partial<Record<Theme, ThemePalette>> {
  try {
    const stored = globalThis.localStorage.getItem(PALETTE_STORAGE_KEY);
    if (stored === null) return {};
    const parsed = JSON.parse(stored) as Partial<Record<Theme, unknown>>;
    const overrides: Partial<Record<Theme, ThemePalette>> = {};
    for (const theme of ['light', 'dark'] as const) {
      if (isThemePalette(parsed[theme])) overrides[theme] = normalizePalette(parsed[theme], DEFAULT_PALETTES[theme]);
    }
    return overrides;
  } catch {
    return {};
  }
}

/** Mix a #rrggbb colour toward another; derives the readable accent shade. */
function mixColor(from: string, to: string, amount: number): string {
  const channel = (offset: number) => {
    const a = Number.parseInt(from.slice(offset, offset + 2), 16);
    const b = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * amount).toString(16).padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

const fallbackConfig: WatchdogConfig = {
  enabled: true,
  dryRun: true,
  pollIntervalMs: 2_000,
  defaultIdleTimeoutMs: 120_000,
  defaultCooldownMs: 300_000,
  maxAttemptsPerQuietPeriod: 1,
  tools: {
    claude: {
      enabled: true,
      normalPrompt: '继续',
      stopHook: { enabled: false, leaseTtlMs: 15_000, commandTimeoutMs: 1_500 },
    },
    codex: {
      enabled: true,
      normalPrompt: '继续',
      goalPrompt: '/goal resume',
      goalStatuses: ['active', 'paused'],
    },
    dsh: {
      enabled: true,
      normalPrompt: '继续',
      sessionWindowMs: 3_600_000,
      allowApiInput: true,
    },
  },
  processFilters: { sameUserOnly: true, include: [], exclude: [] },
};

const fallbackHookStatus: ClaudeHookStatusView = {
  installed: false,
  enabled: false,
  restartRequired: false,
  manualReviewRequired: false,
};

const now = Date.now();
const fallbackSessions: SessionView[] = [
  {
    id: 'codex:336756',
    tool: 'codex',
    rootPid: 336_756,
    childPids: [327_660],
    conversationId: '01a01a5d',
    goal: { status: 'active', updatedAtMs: now - 26_000 },
    transport: 'codex-app-server',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 3_420_000,
    lastActivityAtMs: now - 74_000,
    quietForMs: 74_000,
    pendingPrompt: '/goal resume',
    lastDecision: 'awaiting-quiet-period',
  },
  {
    id: 'claude:214052',
    tool: 'claude',
    rootPid: 214_052,
    childPids: [],
    conversationId: 'project-main',
    goal: null,
    transport: 'classic-console',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 1_680_000,
    lastActivityAtMs: now - 18_000,
    quietForMs: 18_000,
    pendingPrompt: '继续',
    lastDecision: 'output-observed',
  },
  {
    id: 'codex:333616',
    tool: 'codex',
    rootPid: 333_616,
    childPids: [177_240],
    conversationId: null,
    goal: null,
    transport: 'monitor-only',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 840_000,
    lastActivityAtMs: now - 132_000,
    quietForMs: 132_000,
    pendingPrompt: '继续',
    lastDecision: 'cannot-inject',
    transportError: 'no-cwd-match',
  },
  {
    id: 'dsh:session-4f21c0a8',
    tool: 'dsh',
    rootPid: 973_680,
    childPids: [973_681],
    conversationId: 'session-4f21c0a8-0e75-4f7a-9f0b-2a63b91d0f52',
    goal: null,
    transport: 'monitor-only',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 1_260_000,
    lastActivityAtMs: now - 42_000,
    quietForMs: 42_000,
    pendingPrompt: '继续',
    lastDecision: 'awaiting-quiet-period',
    transportError: 'dry run keeps DeepSeek Harness input disabled',
    sessionCwd: 'D:\\project\\ai-cli-bypass',
    runningTurn: false,
  },
];

const fallbackEvents: AuditEvent[] = [
  { id: 'sample-1', timestampMs: now - 18_000, type: 'activity', sessionId: 'claude:214052', tool: 'claude' },
  { id: 'sample-2', timestampMs: now - 74_000, type: 'decision', sessionId: 'codex:336756', tool: 'codex', details: { decision: 'awaiting-quiet-period' } },
  { id: 'sample-3', timestampMs: now - 132_000, type: 'skip', sessionId: 'codex:333616', tool: 'codex', details: { reason: 'monitor-only' } },
  { id: 'sample-4', timestampMs: now - 42_000, type: 'activity', sessionId: 'dsh:session-4f21c0a8', tool: 'dsh', details: { source: 'dsh-session' } },
];

function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '--';
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function time(timestampMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(timestampMs);
}

function transportLabel(transport: SessionView['transport']): string {
  const labels: Record<SessionView['transport'], string> = {
    'classic-console': 'Console',
    pty: 'PTY',
    'codex-app-server': 'App Server',
    'claude-stop-hook': 'Stop Hook',
    'dsh-web': 'Harness API',
    'monitor-only': '仅监控',
    'cannot-inject': '不可写入',
    unknown: '待识别',
  };
  return labels[transport];
}

function decisionLabel(decision: string | undefined): { label: string; tone: 'ready' | 'waiting' | 'limited' | 'error' } {
  switch (decision) {
    case 'awaiting-quiet-period': return { label: '等待静默', tone: 'waiting' };
    case 'output-observed': return { label: '输出活跃', tone: 'ready' };
    case 'cannot-inject': return { label: '仅监控', tone: 'limited' };
    case 'transport-error': return { label: '传输错误', tone: 'error' };
    case 'injected': return { label: '已写入', tone: 'ready' };
    case 'activity': return { label: '活动', tone: 'ready' };
    case 'decision': return { label: '决策', tone: 'waiting' };
    case 'skip': return { label: '跳过', tone: 'limited' };
    case 'injection': return { label: '已写入', tone: 'ready' };
    case 'output-recovery': return { label: '输出恢复', tone: 'ready' };
    default: return { label: decision ?? '等待活动', tone: 'waiting' };
  }
}

function canInject(session: SessionView): boolean {
  return session.alive && session.enabled && !['monitor-only', 'cannot-inject', 'unknown'].includes(session.transport);
}

function toolLabel(tool: SessionView['tool']): string {
  if (tool === 'codex') return 'Codex';
  if (tool === 'dsh') return 'DeepSeek Harness';
  return 'Claude';
}

function conversationLabel(session: SessionView): string {
  if (session.tool === 'dsh') return session.runningTurn ? '步骤执行中' : '等待输入';
  return session.goal ? `Goal · ${session.goal.status}` : '普通对话';
}

function transportReason(error: string | undefined): string | null {
  if (!error) return null;
  const reasons: Record<string, string> = {
    'no-cwd-match': '未找到同目录 Codex 线程',
    'no-thread-index': '未找到 Codex 线程索引',
    'resume-id-not-found': 'Codex 恢复线程不存在',
    'multiple-explicit-matches': 'Codex 线程关联不唯一',
    'equally-recent-threads': 'Codex 线程关联不唯一',
    'process working directory is unknown': '无法读取进程目录',
    'no unique recent Claude session was found': '未找到唯一 Claude 会话',
    'ambiguous Claude resume session association': 'Claude 会话关联不唯一',
    'shared classic Console contains multiple discovered CLI sessions': '多个 CLI 共用同一 Console',
    'Codex state database was not found': '未找到 Codex 状态库',
    'DeepSeek Harness exposes no local input transport': 'DeepSeek Harness 暂无本机写入通道',
    'DeepSeek Harness input is disabled in the watchdog settings': '已关闭 Harness 写入',
    'dry run keeps DeepSeek Harness input disabled': 'Dry Run 期间不写入 Harness',
    'the local DeepSeek Harness session API is unavailable': '未找到可认证的 Harness 本机接口',
    'harness rejected the local session credential': 'Harness 拒绝了本机会话凭据',
    'The harness session still has an unfinished step.': 'Harness 仍在执行步骤，不打断',
    'DeepSeek Harness host has no live session': 'Harness 宿主机没有活动会话',
    'DeepSeek Harness session is no longer live': 'Harness 会话已结束',
    'DeepSeek Harness session disappeared during discovery': 'Harness 会话在扫描中结束',
  };
  if (error.startsWith('ambiguous Claude session association')) return 'Claude 会话关联不唯一';
  return reasons[error] ?? error;
}

function nextPrompt(session: SessionView, config: WatchdogConfig): string {
  if (session.pendingPrompt) return session.pendingPrompt;
  if (session.tool === 'codex' && session.goal && config.tools.codex.goalStatuses.includes(session.goal.status)) {
    return config.tools.codex.goalPrompt;
  }
  return config.tools[session.tool].normalPrompt;
}

function parseFilterList(value: string): string[] {
  return value.split(/[\r\n,]+/u).map((entry) => entry.trim()).filter(Boolean);
}

function CapabilityBadge({ session }: { session: SessionView }) {
  const actionable = canInject(session);
  const reason = transportReason(session.transportError);
  return (
    <div className="capability-view">
      <span className={`capability ${actionable ? 'capability--ready' : 'capability--limited'}`}>
        <span className="capability__dot" />
        {transportLabel(session.transport)}
      </span>
      {reason && <span className="capability-detail" title={session.transportError}>{reason}</span>}
    </div>
  );
}

function DecisionChip({ decision }: { decision: string | undefined }) {
  const state = decisionLabel(decision);
  return <span className={`state-chip state-chip--${state.tone}`}><span className="state-chip__dot" />{state.label}</span>;
}

function ToolMark({ tool }: { tool: SessionView['tool'] }) {
  return (
    <span className={`tool-mark tool-mark--${tool}`} aria-hidden="true">
      {tool === 'codex' ? <Terminal size={16} /> : tool === 'dsh' ? <Network size={16} /> : <Bot size={16} />}
    </span>
  );
}

interface SessionActionsProps {
  session: SessionView;
  busy: string | null;
  onPause: (session: SessionView) => void;
  onInject: (session: SessionView) => void;
  onFocus: (session: SessionView) => void;
  /** 电脑操控 can switch the reveal action off for the whole app. */
  allowReveal?: boolean;
}

function SessionActions({ session, busy, onPause, onInject, onFocus, allowReveal = true }: SessionActionsProps) {
  const waiting = busy === session.id;
  return (
    <div className="row-actions">
      <button
        className="icon-button"
        type="button"
        title="打开运行位置"
        aria-label={`打开运行位置 PID ${session.rootPid}`}
        disabled={waiting || !allowReveal || !session.alive || session.host === null || session.host === undefined}
        onClick={() => onFocus(session)}
      >
        <SquareArrowOutUpRight size={17} />
      </button>
      <button
        className="icon-button"
        type="button"
        title={session.paused ? '恢复监控' : '暂停监控'}
        aria-label={session.paused ? `恢复 PID ${session.rootPid}` : `暂停 PID ${session.rootPid}`}
        disabled={waiting || !session.alive}
        onClick={() => onPause(session)}
      >
        {session.paused ? <CirclePlay size={17} /> : <CirclePause size={17} />}
      </button>
      <button
        className="icon-button icon-button--accent"
        type="button"
        title="立即续写"
        aria-label={`立即续写 PID ${session.rootPid}`}
        disabled={waiting || !canInject(session)}
        onClick={() => onInject(session)}
      >
        {waiting ? <RefreshCw className="spin" size={17} /> : <Send size={17} />}
      </button>
    </div>
  );
}

function HostCell({ session }: { session: SessionView }) {
  const host = session.host ?? null;
  if (host === null) return <span className="subtle">未识别宿主</span>;
  return (
    <div className="host-cell">
      <span className={`host-badge host-badge--${host.category}`}>{host.label}</span>
      <span className="subtle" title={host.windowTitle ?? undefined}>
        {host.windowTitle ?? (host.windowHandle === null ? '网页界面' : `PID ${host.processId}`)}
      </span>
    </div>
  );
}

function ProcessTable(props: {
  sessions: SessionView[];
  config: WatchdogConfig;
  busy: string | null;
  onPause: (session: SessionView) => void;
  onInject: (session: SessionView) => void;
  onFocus: (session: SessionView) => void;
  allowReveal?: boolean;
}) {
  return (
    <>
      <div className="process-table-wrap">
        <table className="process-table">
          <thead>
            <tr><th>进程</th><th>运行位置</th><th>能力</th><th>对话</th><th>静默</th><th>下一输入</th><th><span className="sr-only">操作</span></th></tr>
          </thead>
          <tbody>
            {props.sessions.map((session) => (
              <tr key={session.id} className={!session.alive ? 'is-muted' : undefined}>
                <td>
                  <div className="process-id"><ToolMark tool={session.tool} /><div><strong>{toolLabel(session.tool)}</strong><span>PID {session.rootPid}{session.childPids.length > 0 ? ` + ${session.childPids.length}` : ''}{session.sessionCwd ? ` · ${session.sessionCwd}` : ''}</span></div></div>
                </td>
                <td><HostCell session={session} /></td>
                <td><CapabilityBadge session={session} /></td>
                <td><strong className="conversation">{conversationLabel(session)}</strong><span className="subtle">{session.conversationId ?? '未关联'}</span></td>
                <td><strong>{duration(session.quietForMs ?? (session.lastActivityAtMs ? Date.now() - session.lastActivityAtMs : null))}</strong><DecisionChip decision={session.lastDecision} /></td>
                <td><code className="prompt-code">{nextPrompt(session, props.config)}</code></td>
                <td><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} onFocus={props.onFocus} allowReveal={props.allowReveal} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="session-cards">
        {props.sessions.map((session) => (
          <article className="session-card" key={session.id}>
            <header><div className="process-id"><ToolMark tool={session.tool} /><div><strong>{toolLabel(session.tool)}</strong><span>PID {session.rootPid}{session.sessionCwd ? ` · ${session.sessionCwd}` : ''}</span></div></div><CapabilityBadge session={session} /></header>
            <dl>
              <div className="session-card__host"><dt>运行位置</dt><dd><HostCell session={session} /></dd></div>
              <div><dt>对话</dt><dd>{conversationLabel(session)}</dd></div>
              <div><dt>静默</dt><dd>{duration(session.quietForMs ?? 0)}</dd></div>
              <div className="session-card__prompt"><dt>下一输入</dt><dd><code>{nextPrompt(session, props.config)}</code></dd></div>
            </dl>
            <footer><DecisionChip decision={session.lastDecision} /><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} onFocus={props.onFocus} allowReveal={props.allowReveal} /></footer>
          </article>
        ))}
      </div>
    </>
  );
}

function Timeline({ events }: { events: AuditEvent[] }) {
  return (
    <div className="timeline">
      {events.length === 0 && <div className="empty-state">暂无事件</div>}
      {events.map((event) => (
        <div className="timeline__item" key={event.id}>
          <span className={`timeline__icon timeline__icon--${event.type}`}><Activity size={15} /></span>
          <div><div className="timeline__title"><DecisionChip decision={event.type} /><span>{time(event.timestampMs)}</span></div><p>{event.sessionId ?? 'watchdog'}{event.details ? ` · ${Object.values(event.details).join(' · ')}` : ''}</p></div>
        </div>
      ))}
    </div>
  );
}

/**
 * The local environment panel.
 *
 * Mirrors what CC Switch shows for a Windows install: one card per agent CLI
 * with the installed and published version, a state badge, and a one-press
 * upgrade. The install runs on the service, which serializes global npm runs;
 * the manual-command block stays for anyone who prefers to run it themselves.
 */

const ENVIRONMENT_STATE_LABEL: Record<ToolState, string> = {
  outdated: '可升级',
  current: '已就绪',
  missing: '未安装',
  unknown: '未知',
};

function EnvironmentToolCard({ tool, upgrading, busy, onUpgrade }: {
  tool: EnvironmentToolView;
  /** True while this exact tool is the one npm is installing. */
  upgrading: boolean;
  /** True while any install is running; the service serializes them anyway. */
  busy: boolean;
  onUpgrade: () => void;
}) {
  return (
    <article className={`tool-card tool-card--${tool.state}`} data-testid={`tool-${tool.id}`}>
      <header>
        <div className="tool-card__id">
          <strong>{tool.label}</strong>
          <span className="tool-card__package">{tool.packageName}</span>
        </div>
        <span className={`state-chip state-chip--${tool.state === 'current' ? 'ready' : tool.state === 'outdated' ? 'waiting' : tool.state === 'missing' ? 'limited' : 'error'}`}>
          <span className="state-chip__dot" />
          {ENVIRONMENT_STATE_LABEL[tool.state]}
        </span>
      </header>
      <dl className="tool-card__versions">
        <div><dt>当前版本</dt><dd>{tool.installed ?? '未安装'}</dd></div>
        <div><dt>最新版本</dt><dd>{tool.latest ?? '--'}</dd></div>
      </dl>
      {tool.state === 'outdated' && <code className="tool-card__command">{tool.installCommand}</code>}
      {tool.state === 'outdated' && (
        <div className="tool-card__actions">
          <button
            className="button button--primary"
            type="button"
            aria-label={`升级 ${tool.label}`}
            disabled={busy}
            onClick={onUpgrade}
          >
            {upgrading ? <RefreshCw className="spin" size={15} /> : <CircleArrowUp size={15} />}
            {upgrading ? '升级中' : '升级'}
          </button>
        </div>
      )}
    </article>
  );
}

function EnvironmentPanel(props: {
  environment: EnvironmentView | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  /** Id of the tool npm is installing right now, or 'all' for a bulk run. */
  upgrading: string | null;
  onUpgrade: (id: string) => Promise<void>;
  onUpgradeAll: () => Promise<void>;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  /**
   * Copy the whole block as one runnable script.
   *
   * The clipboard is not always available (an insecure context, a denied
   * permission), so the confirmation only appears after the write resolves.
   */
  const copyManualCommands = async (commands: readonly string[]) => {
    try {
      await navigator.clipboard.writeText(commands.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  if (props.environment === null) return null;
  const report = props.environment;
  return (
    <section className="settings-section settings-section--wide environment-panel">
      <div className="section-title">
        <div><span className="eyebrow">Environment</span><h2>本地环境检查</h2></div>
        <div className="section-title__actions">
          {report.upgrades.length > 0 && (
            <button
              className="button button--primary"
              type="button"
              aria-label="全部升级"
              disabled={props.upgrading !== null || props.refreshing}
              onClick={() => void props.onUpgradeAll()}
            >
              {props.upgrading === 'all' ? <RefreshCw className="spin" size={16} /> : <CircleArrowUp size={16} />}
              全部升级 ({report.upgrades.length})
            </button>
          )}
          <button
            className="button button--secondary"
            type="button"
            aria-label="刷新本地环境"
            disabled={props.refreshing || props.upgrading !== null}
            onClick={() => void props.onRefresh()}
          >
            {props.refreshing ? <RefreshCw className="spin" size={16} /> : <RefreshCw size={16} />}
            刷新
          </button>
        </div>
      </div>
      <div className="environment-panel__body">
        <div className="tool-grid">
          {report.tools.map((tool) => (
            <EnvironmentToolCard
              key={tool.id}
              tool={tool}
              upgrading={props.upgrading === tool.id}
              busy={props.upgrading !== null}
              onUpgrade={() => void props.onUpgrade(tool.id)}
            />
          ))}
        </div>
        <div className="manual-commands">
          <button
            className="manual-commands__toggle"
            type="button"
            aria-expanded={manualOpen}
            onClick={() => setManualOpen((current) => !current)}
          >
            <Terminal size={16} />
            手动安装命令
            <span className="manual-commands__chevron">{manualOpen ? '收起' : '展开'}</span>
          </button>
          {manualOpen && (
            <div className="manual-commands__body">
              <div className="manual-commands__actions">
                <button
                  className="button button--secondary"
                  type="button"
                  aria-label="复制安装命令"
                  onClick={() => { void copyManualCommands(report.manualCommands); }}
                >
                  <Copy size={15} />
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <pre data-testid="manual-commands">{report.manualCommands.map((command) => `# ${command.split(' ').at(-1)?.replace('@latest', '') ?? ''}\n${command}`).join('\n')}</pre>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
function CodexEndpointsPanel(props: {
  profiles: CodexProfilesView | null;
  onApply: (fields: CodexProfileFieldView[]) => Promise<void>;
  applying: boolean;
}) {
  const [draft, setDraft] = useState<CodexProfileFieldView[]>([]);
  const profileSignature = JSON.stringify(props.profiles?.current?.fields ?? null);
  useEffect(() => {
    if (props.profiles !== null) setDraft(props.profiles.current?.fields ?? []);
  }, [profileSignature]);
  if (props.profiles === null) return null;
  const profiles = props.profiles;
  const activeByKey = profiles.active;
  const update = (key: string, value: string) => {
    setDraft((current) => {
      const next = current.filter((field) => field.key !== key);
      return [...next, { key, value }];
    });
  };
  const valueOf = (key: string) => draft.find((field) => field.key === key)?.value ?? activeByKey[key] ?? '';
  const apply = async () => {
    const fields = draft.filter((field) => field.value.trim().length > 0);
    if (fields.length === 0) return;
    await props.onApply(fields);
  };
  const switchTo = async (key: string, value: string) => {
    const fields = draft.filter((field) => field.value.trim().length > 0).map((field) => ({ ...field }));
    const index = fields.findIndex((field) => field.key === key);
    if (index === -1) fields.push({ key, value });
    else fields[index] = { key, value };
    setDraft(fields);
    await props.onApply(fields);
  };
  return (
    <section className="settings-section settings-section--wide codex-endpoints">
      <div className="section-title"><div><span className="eyebrow">Codex</span><h2>端点配置</h2></div><Plug size={20} /></div>
      <div className="codex-endpoints__body">
        <p className="hook-disclosure"><CircleAlert size={17} /><span>切换会直接改写 <code>{profiles.path}</code>，并把旧值保留为注释；每次写入前都会生成 .bak 备份。</span></p>
        <div className="field-grid codex-endpoints__fields">
          {[
            { key: 'model', label: '模型' },
            { key: 'review_model', label: '评审模型' },
            { key: 'model_reasoning_effort', label: '推理强度' },
          ].map((entry) => (
            <label key={entry.key}><span>{entry.label}</span><input aria-label={entry.label} value={valueOf(entry.key)} onChange={(event) => update(entry.key, event.target.value)} /></label>
          ))}
        </div>
        {(['base_url', 'experimental_bearer_token'] as const).map((key) => {
          const alternatives = profiles.alternatives[key] ?? [];
          const current = valueOf(key);
          return (
            <div className="field-grid codex-endpoints__fields" key={key}>
              <label><span>{key === 'base_url' ? '接口地址' : '访问令牌'}</span><input aria-label={key === 'base_url' ? '接口地址' : '访问令牌'} value={current} onChange={(event) => update(key, event.target.value)} /></label>
              {alternatives.length > 0 && (
                <div className="codex-endpoints__alternatives">
                  <span>已注释的备选</span>
                  <div className="codex-endpoints__chips">
                    {[...new Set([...alternatives, activeByKey[key]].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))].map((alternative) => (
                      <button key={alternative} className={alternative === current ? 'chip is-active' : 'chip'} type="button" onClick={() => void switchTo(key, alternative)}>{alternative}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="settings-actions"><button className="button button--primary" type="button" disabled={props.applying} onClick={() => void apply()}>{props.applying ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}应用端点配置</button></div>
      </div>
    </section>
  );
}

/**
 * The appearance section.
 *
 * Mirrors the reference's appearance page: three theme previews on a light
 * card, a diff of the values each theme resolves to, then one row per setting
 * (accent, background, foreground, type, contrast) so the page reads as a list
 * of choices rather than a wall of cards.
 */
const THEME_OPTIONS: readonly { readonly id: ThemePreference; readonly label: string; readonly ariaLabel: string }[] = [
  { id: 'system', label: '系统', ariaLabel: '跟随系统' },
  { id: 'light', label: '浅色', ariaLabel: '浅色' },
  { id: 'dark', label: '深色', ariaLabel: '深色' },
];

function ThemePreviewCard(props: {
  readonly id: ThemePreference;
  readonly label: string;
  /** Fuller name for assistive tech; the visible caption stays short. */
  readonly ariaLabel: string;
  readonly scheme: Theme;
  readonly selected: boolean;
  readonly palette: ThemePalette;
  /** For the system card: the light and dark palettes it shows side by side. */
  readonly systems?: readonly [ThemePalette, ThemePalette];
  readonly onSelect: () => void;
}) {
  // A system card shows both schemes at once, split down the middle.
  const [left, right] = props.systems ?? [props.palette, props.palette];
  const card = (scheme: Theme, palette: ThemePalette) => (
    <span className="theme-preview__half" data-scheme={scheme} style={{ background: palette.background }}>
      <span className="theme-preview__shell">
        <span className="theme-preview__rail" style={{ background: mixColor(palette.background, palette.foreground, scheme === 'dark' ? 0.1 : 0.05) }} />
        <span className="theme-preview__sheet" style={{ background: mixColor(palette.background, palette.foreground, scheme === 'dark' ? 0.16 : 0.04) }}>
          <span className="theme-preview__bar" style={{ background: palette.accent }} />
          <span className="theme-preview__line" style={{ background: palette.foreground, opacity: .5 }} />
          <span className="theme-preview__line theme-preview__line--short" style={{ background: palette.foreground, opacity: .3 }} />
        </span>
      </span>
    </span>
  );
  return (
    <button
      className={props.selected ? 'theme-preview is-active' : 'theme-preview'}
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-label={props.ariaLabel}
      onClick={props.onSelect}
    >
      <span className="theme-preview__canvas">
        {props.id === 'system'
          ? <>{card('light', left)}{card('dark', right)}</>
          : card(props.scheme, props.palette)}
      </span>
      <span className="theme-preview__label">{props.label}</span>
    </button>
  );
}

/**
 * The side-by-side code sample.
 *
 * The left pane keeps the stock values so the comparison reads as a diff: what
 * the theme ships with against what the current choices resolve to.
 */
function ThemeDiffPreview(props: {
  readonly palette: ThemePalette;
  readonly activeTheme: Theme;
}) {
  const before = DEFAULT_PALETTES[props.activeTheme];
  const after = props.palette;
  const rows: readonly { readonly from: string; readonly to: string }[] = [
    // A translucent sidebar is a different surface, so it shows up as a diff.
    { from: before.translucentSidebar ? 'sidebar-elevated' : 'sidebar', to: after.translucentSidebar ? 'sidebar-elevated' : 'sidebar' },
    { from: before.accent, to: after.accent },
    { from: String(before.contrast), to: String(after.contrast) },
  ];
  const pane = (values: readonly string[], after: boolean) => (
    <div className={after ? 'theme-diff__pane theme-diff__pane--after' : 'theme-diff__pane'}>
      <span className="theme-diff__gutter" aria-hidden="true" />
      <span className="theme-diff__code">
        <span className="theme-diff__title">const themePreview: ThemeConfig = {'{'}</span>
        <span className="theme-diff__line"><span className="theme-diff__num">2</span>surface: "{values[0]}",</span>
        <span className="theme-diff__line"><span className="theme-diff__num">3</span>accent: "{values[1]}",</span>
        <span className="theme-diff__line"><span className="theme-diff__num">4</span>contrast: {values[2]},</span>
        <span className="theme-diff__title">{'}'};</span>
      </span>
    </div>
  );
  return (
    <div className="theme-diff" data-testid="theme-diff">
      {pane(rows.map((row) => row.from), false)}
      {pane(rows.map((row) => row.to), true)}
    </div>
  );
}

/** One labelled row in the settings list. */
function AppearanceRow(props: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="appearance-row">
      <span className="appearance-row__label">{props.label}</span>
      <div className="appearance-row__control">{props.children}</div>
    </div>
  );
}

function AppearancePanel(props: {
  readonly preference: ThemePreference;
  readonly activeTheme: Theme;
  readonly palette: ThemePalette;
  readonly palettes: Record<Theme, ThemePalette>;
  readonly customized: boolean;
  readonly onPreferenceChange: (theme: ThemePreference) => void;
  readonly onPaletteChange: (patch: Partial<ThemePalette>) => void;
  readonly onPaletteReset: () => void;
  readonly onImport: () => Promise<void>;
  readonly onCopy: () => Promise<void>;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    setCopyState('idle');
    try {
      await props.onCopy();
      setCopyState('done');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      setCopyState('failed');
    }
  };
  const ui = props.palette.uiType;
  const content = props.palette.contentType;
  const setUi = (patch: Partial<TypeSetting>) => props.onPaletteChange({ uiType: { ...ui, ...patch } });
  const setContent = (patch: Partial<TypeSetting & { sameAsUi: boolean }>) =>
    props.onPaletteChange({ contentType: { ...content, ...patch } });
  return (
    <section className="settings-section settings-section--wide appearance-panel">
      <div className="section-title">
        <div><span className="eyebrow">Appearance</span><h2>外观</h2></div>
        <div className="appearance-panel__actions">
          <button className="text-button" type="button" onClick={() => void props.onImport()}>
            <Copy size={14} /> 导入
          </button>
          <button className="text-button" type="button" onClick={() => void copy()}>
            <Copy size={14} /> {copyState === 'done' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制主题'}
          </button>
        </div>
      </div>
      <p className="section-hint">选择应用的外观主题与排版，立即生效。</p>
      <div className="theme-previews" role="radiogroup" aria-label="外观主题">
        {THEME_OPTIONS.map((option) => (
          <ThemePreviewCard
            key={option.id}
            id={option.id}
            label={option.label}
            ariaLabel={option.ariaLabel}
            scheme={option.id === 'system' ? props.activeTheme : option.id}
            selected={props.preference === option.id}
            palette={option.id === 'system' ? props.palettes[props.activeTheme] : props.palettes[option.id as Theme]}
            systems={[props.palettes.light, props.palettes.dark]}
            onSelect={() => props.onPreferenceChange(option.id)}
          />
        ))}
      </div>
      <ThemeDiffPreview palette={props.palette} activeTheme={props.activeTheme} />
      <div className="appearance-list">
        <AppearanceRow label="强调色">
          <select
            aria-label="强调色"
            value={props.palette.accent}
            onChange={(event) => props.onPaletteChange({ accent: event.target.value })}
          >
            {[...new Set([props.palette.accent, ...ACCENT_PRESETS.map((preset) => preset.value)])].map((value) => (
              <option key={value} value={value}>
                {ACCENT_PRESETS.find((preset) => preset.value === value)?.label ?? '当前'}
              </option>
            ))}
          </select>
        </AppearanceRow>
        <AppearanceRow label="背景">
          <span className="appearance-swatch">
            <input
              type="color"
              aria-label="背景"
              value={props.palette.background}
              onChange={(event) => props.onPaletteChange({ background: event.target.value })}
            />
            <code>{props.palette.background.toUpperCase()}</code>
          </span>
        </AppearanceRow>
        <AppearanceRow label="前景">
          <span className="appearance-swatch">
            <input
              type="color"
              aria-label="前景"
              value={props.palette.foreground}
              onChange={(event) => props.onPaletteChange({ foreground: event.target.value })}
            />
            <code>{props.palette.foreground.toUpperCase()}</code>
          </span>
        </AppearanceRow>
        <AppearanceRow label="UI 字体">
          <select aria-label="UI 字体" value={ui.family} onChange={(event) => setUi({ family: event.target.value as FontChoice })}>
            <option value="system">系统默认</option>
            <option value="mono">等宽</option>
            <option value="serif">衬线</option>
          </select>
          <select aria-label="UI 字重" value={String(ui.weight)} onChange={(event) => setUi({ weight: event.target.value === '500' ? 500 : 400 })}>
            <option value="400">常规</option>
            <option value="500">中等</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="内容字体">
          <select
            aria-label="内容字体"
            value={content.sameAsUi ? 'same' : content.family}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'same') setContent({ sameAsUi: true });
              else setContent({ sameAsUi: false, family: value as FontChoice });
            }}
          >
            <option value="same">与界面字体相同</option>
            <option value="system">系统默认</option>
            <option value="mono">等宽</option>
            <option value="serif">衬线</option>
          </select>
          <select
            aria-label="内容字重"
            value={String(content.weight)}
            onChange={(event) => setContent({ weight: event.target.value === '500' ? 500 : 400 })}
          >
            <option value="400">常规</option>
            <option value="500">中等</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="半透明侧边栏">
          <label className="switch">
            <input
              aria-label="半透明侧边栏"
              type="checkbox"
              checked={props.palette.translucentSidebar}
              onChange={(event) => props.onPaletteChange({ translucentSidebar: event.target.checked })}
            />
            <span />
          </label>
        </AppearanceRow>
        <AppearanceRow label="对比度">
          <span className="appearance-slider">
            <input
              type="range"
              aria-label="对比度"
              min="0"
              max="100"
              step="1"
              value={props.palette.contrast}
              onChange={(event) => props.onPaletteChange({ contrast: Number(event.target.value) })}
            />
            <code>{props.palette.contrast}</code>
          </span>
        </AppearanceRow>
      </div>
      {props.customized && (
        <div className="settings-actions">
          <button className="button button--secondary" type="button" onClick={props.onPaletteReset}>恢复默认</button>
        </div>
      )}
    </section>
  );
}

function SettingsPanel(props: {
  config: WatchdogConfig;
  hookStatus: ClaudeHookStatusView;
  profiles: CodexProfilesView | null;
  environment: EnvironmentView | null;
  environmentRefreshing: boolean;
  environmentUpgrading: string | null;
  onRefreshEnvironment: () => Promise<void>;
  onUpgradeTool: (id: string) => Promise<void>;
  onUpgradeAllTools: () => Promise<void>;
  theme: ThemePreference;
  /** The scheme the preference actually resolves to right now. */
  activeTheme: Theme;
  /** The palette in effect for the active scheme. */
  palette: ThemePalette;
  /** Both schemes' effective palettes, for the preview cards. */
  palettes: Record<Theme, ThemePalette>;
  /** True when that palette is a person's override rather than the default. */
  customized: boolean;
  onThemeChange: (theme: ThemePreference) => void;
  onPaletteChange: (patch: Partial<ThemePalette>) => void;
  onPaletteReset: () => void;
  onImportTheme: () => Promise<void>;
  onCopyTheme: () => Promise<void>;
  onApplyProfile: (fields: CodexProfileFieldView[]) => Promise<void>;
  applyingProfile: boolean;
  saving: boolean;
  running: boolean;
  onSave: (config: WatchdogConfig) => Promise<void>;
  onToggle: () => Promise<void>;
  onInstall: () => Promise<void>;
  startupInstalled: boolean;
  onToggleStartup: () => Promise<void>;
  onInstallClaudeHook: () => Promise<void>;
  onUninstallClaudeHook: () => Promise<void>;
  onDisableClaudeHook: () => Promise<void>;
  onUninstall: () => Promise<void>;
  /** Live data the rail sections read. */
  sessions: readonly SessionView[];
  events: readonly AuditEvent[];
  connected: boolean;
  /** Which rail entry is in view; owned by the app so the tray can target one. */
  activeSection: string;
  onSectionChange: (id: string) => void;
  /** Leave the settings page (the rail's 返回应用). */
  onBack: () => void;
  /** Apply a theme/config blob read from the clipboard by the import section. */
  onImportThemeText: (text: string) => Promise<void>;
  onImportConfigText: (text: string) => Promise<void>;
  /** Lets the sidebar brand block adopt the imported 显示名称. */
  onDisplayNameChange: (name: string) => void;
  allowReveal: boolean;
  onAllowRevealChange: (allowed: boolean) => void;
  closeToTray: boolean | null;
  onCloseToTrayChange: (value: boolean) => void;
  preferredTerminal: string | null;
  onPreferredTerminalChange: (value: string) => void;
  desktopBridgeAvailable: boolean;
  parentalLocked: boolean;
  onParentalLockChange: (locked: boolean) => void;
  /** Origin this WebUI is served from. */
  origin: string;
}) {
  const [draft, setDraft] = useState(() => structuredClone(props.config));
  // The rail is the navigation; the app owns which section is in view so a tray
  // command can open the settings page directly on a named section.
  const activeSection = props.activeSection;
  const [includeFilters, setIncludeFilters] = useState(() => props.config.processFilters.include.join(', '));
  const [excludeFilters, setExcludeFilters] = useState(() => props.config.processFilters.exclude.join(', '));
  useEffect(() => {
    setDraft(structuredClone(props.config));
    setIncludeFilters(props.config.processFilters.include.join(', '));
    setExcludeFilters(props.config.processFilters.exclude.join(', '));
  }, [props.config]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void props.onSave({
      ...draft,
      processFilters: {
        ...draft.processFilters,
        include: parseFilterList(includeFilters),
        exclude: parseFilterList(excludeFilters),
      },
    });
  };

  /** The config save bar, shared by the sections that edit the service config. */
  const saveBar = (
    <div className="settings-actions"><button className="button button--primary" type="submit" disabled={props.saving}>{props.saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}保存配置</button><button className="button button--secondary" type="button" onClick={() => void props.onInstall()} disabled={props.saving}><CirclePlay size={17} />安装 Watchdog</button><button className="button button--secondary" type="button" onClick={() => void props.onToggleStartup()} disabled={props.saving}><Power size={17} />{props.startupInstalled ? '移除启动项' : '安装启动项'}</button><button className={`button ${props.running ? 'button--stop' : 'button--start'}`} type="button" onClick={() => void props.onToggle()} disabled={props.saving}>{props.running ? <Power size={17} /> : <CirclePlay size={17} />}{props.running ? '停止 Watchdog' : '启动 Watchdog'}</button><button className="button button--danger" type="button" onClick={() => void props.onUninstall()} disabled={props.saving}><Trash2 size={17} />卸载 Watchdog</button></div>
  );

  return (
    <form className="settings-shell" onSubmit={submit}>
      <SettingsRail active={activeSection} onSelect={props.onSectionChange} onBack={props.onBack} />
      <div className="settings-content">
      {activeSection === 'appearance' && (
        <>
          <AppearancePanel
            preference={props.theme}
            activeTheme={props.activeTheme}
            palette={props.palette}
            palettes={props.palettes}
            customized={props.customized}
            onPreferenceChange={props.onThemeChange}
            onPaletteChange={props.onPaletteChange}
            onPaletteReset={props.onPaletteReset}
            onImport={props.onImportTheme}
            onCopy={props.onCopyTheme}
          />
          <section className="settings-section settings-section--wide">
            <div className="section-title"><div><span className="eyebrow">Locale</span><h2>界面语言</h2></div><Settings2 size={20} /></div>
            <p className="section-hint">当前使用简体中文，其他界面语言暂不支持。</p>
            <div className="segmented segmented--labels" role="group" aria-label="界面语言">
              {['简体中文', '繁體中文', 'English', '日本語'].map((language) => (
                <button
                  key={language}
                  className={language === '简体中文' ? 'segmented__option is-active' : 'segmented__option'}
                  type="button"
                  aria-pressed={language === '简体中文'}
                  disabled={language !== '简体中文'}
                >
                  {language}{language !== '简体中文' && '（暂不支持）'}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      {activeSection === 'general' && (
        <>
      <section className="settings-section settings-section--wide">
        <div className="section-title"><div><span className="eyebrow">Watchdog</span><h2>常规</h2></div><Gauge size={20} /></div>
        <p className="section-hint">检测节奏、续写提示词与进程范围，保存后立即生效。</p>
      </section>
      <section className="settings-section">
        <div className="section-title"><div><span className="eyebrow">Timing</span><h2>检测节奏</h2></div><Gauge size={20} /></div>
        <div className="field-grid">
          <label><span>静默阈值（秒）</span><input type="number" min="1" value={draft.defaultIdleTimeoutMs / 1_000} onChange={(event) => setDraft({ ...draft, defaultIdleTimeoutMs: Number(event.target.value) * 1_000 })} /></label>
          <label><span>冷却时间（秒）</span><input type="number" min="1" value={draft.defaultCooldownMs / 1_000} onChange={(event) => setDraft({ ...draft, defaultCooldownMs: Number(event.target.value) * 1_000 })} /></label>
          <label><span>轮询间隔（毫秒）</span><input type="number" min="250" step="250" value={draft.pollIntervalMs} onChange={(event) => setDraft({ ...draft, pollIntervalMs: Number(event.target.value) })} /></label>
          <label><span>每轮最大尝试</span><input type="number" min="1" value={draft.maxAttemptsPerQuietPeriod} onChange={(event) => setDraft({ ...draft, maxAttemptsPerQuietPeriod: Number(event.target.value) })} /></label>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-title"><div><span className="eyebrow">Prompts</span><h2>续写内容</h2></div><Terminal size={20} /></div>
        <div className="field-stack">
          <label><span>Claude</span><input value={draft.tools.claude.normalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, normalPrompt: event.target.value } } })} /></label>
          <label><span>Codex 普通对话</span><input value={draft.tools.codex.normalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, codex: { ...draft.tools.codex, normalPrompt: event.target.value } } })} /></label>
          <label><span>Codex Goal</span><input value={draft.tools.codex.goalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, codex: { ...draft.tools.codex, goalPrompt: event.target.value } } })} /></label>
          <label><span>DeepSeek Harness</span><input value={draft.tools.dsh.normalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, dsh: { ...draft.tools.dsh, normalPrompt: event.target.value } } })} /></label>
          <label><span>Harness 活动窗口（分钟）</span><input aria-label="Harness 活动窗口（分钟）" type="number" min="1" value={Math.round(draft.tools.dsh.sessionWindowMs / 60_000)} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, dsh: { ...draft.tools.dsh, sessionWindowMs: Math.max(1, Number(event.target.value)) * 60_000 } } })} /></label>
        </div>
        <div className="switch-row"><div><strong>允许续写 DeepSeek Harness</strong><span>通过 Harness 自己的本机会话接口写入，仅在会话已停止且能完成本机认证时生效</span></div><label className="switch"><input aria-label="允许续写 DeepSeek Harness" type="checkbox" checked={draft.tools.dsh.allowApiInput} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, dsh: { ...draft.tools.dsh, allowApiInput: event.target.checked } } })} /><span /></label></div>
        <div className="switch-row"><div><strong>Dry run</strong><span>只记录决策，不写入进程</span></div><label className="switch"><input aria-label="Dry run" type="checkbox" checked={draft.dryRun} onChange={(event) => setDraft({ ...draft, dryRun: event.target.checked })} /><span /></label></div>
      </section>
      <section className="settings-section settings-section--wide hook-settings">
        <div className="section-title hook-settings__title">
          <div><span className="eyebrow">Claude</span><h2>Claude Stop Hook</h2></div>
          <Webhook size={20} />
        </div>
        <div className="hook-status-list" aria-label="Claude Stop Hook 状态">
          <span className={`state-chip ${props.hookStatus.manualReviewRequired ? 'state-chip--error' : props.hookStatus.installed ? 'state-chip--ready' : 'state-chip--limited'}`}>
            <span className="state-chip__dot" />
            {props.hookStatus.manualReviewRequired ? '需人工检查' : props.hookStatus.installed ? '已安装' : '未安装'}
          </span>
          <span className={`state-chip ${props.hookStatus.enabled ? 'state-chip--ready' : 'state-chip--limited'}`}>
            <span className="state-chip__dot" />
            {props.hookStatus.enabled ? '已启用' : '未启用'}
          </span>
          {props.hookStatus.restartRequired && <span className="state-chip state-chip--waiting"><span className="state-chip__dot" />需重启 Claude</span>}
        </div>
        <div className="hook-settings__body">
          <div>
            <div className="field-grid hook-settings__fields">
              <label><span>Lease 有效期（毫秒）</span><input aria-label="Lease 有效期（毫秒）" type="number" min="1" value={draft.tools.claude.stopHook.leaseTtlMs} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, stopHook: { ...draft.tools.claude.stopHook, leaseTtlMs: Number(event.target.value) } } } })} /></label>
              <label><span>命令超时（毫秒）</span><input aria-label="命令超时（毫秒）" type="number" min="1" value={draft.tools.claude.stopHook.commandTimeoutMs} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, stopHook: { ...draft.tools.claude.stopHook, commandTimeoutMs: Number(event.target.value) } } } })} /></label>
            </div>
            <div className="switch-row"><div><strong>启用 Stop Hook 续写</strong><span>仅对唯一关联且已静默的 Claude 会话创建一次性 Lease</span></div><label className="switch"><input aria-label="启用 Claude Stop Hook" type="checkbox" checked={draft.tools.claude.stopHook.enabled} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, stopHook: { ...draft.tools.claude.stopHook, enabled: event.target.checked } } } })} /><span /></label></div>
          </div>
          <div className="hook-settings__control">
            <p className="hook-disclosure"><CircleAlert size={17} /><span>安装会修改 <code>~/.claude/settings.json</code>。已打开的 Claude 会话需要重启后才能加载 Hook。</span></p>
            {props.hookStatus.lastError && <p className="hook-error" role="alert">{props.hookStatus.lastError}</p>}
            <div className="hook-actions">
              {!props.hookStatus.installed && !props.hookStatus.manualReviewRequired && <button className="button button--secondary" type="button" onClick={() => void props.onInstallClaudeHook()} disabled={props.saving}><Plug size={17} />安装 Stop Hook</button>}
              {props.hookStatus.enabled && <button className="button button--stop" type="button" onClick={() => void props.onDisableClaudeHook()} disabled={props.saving}><Power size={17} />停用 Stop Hook</button>}
              {(props.hookStatus.installed || props.hookStatus.manualReviewRequired) && <button className="button button--danger" type="button" onClick={() => void props.onUninstallClaudeHook()} disabled={props.saving}><Unplug size={17} />卸载 Stop Hook</button>}
            </div>
          </div>
        </div>
      </section>
      <section className="settings-section settings-section--wide">
        <div className="section-title"><div><span className="eyebrow">Processes</span><h2>进程范围</h2></div><ShieldAlert size={20} /></div>
        <div className="field-grid">
          <label><span>包含匹配</span><input aria-label="包含匹配" placeholder="例如 Nexus, study-os" value={includeFilters} onChange={(event) => setIncludeFilters(event.target.value)} /></label>
          <label><span>排除匹配</span><input aria-label="排除匹配" placeholder="例如 node_modules" value={excludeFilters} onChange={(event) => setExcludeFilters(event.target.value)} /></label>
        </div>
        <div className="switch-row"><div><strong>仅监控当前用户进程</strong><span>关闭后会发现其他用户进程，但仍只对安全关联且可验证的会话写入</span></div><label className="switch"><input aria-label="仅监控当前用户进程" type="checkbox" checked={draft.processFilters.sameUserOnly} onChange={(event) => setDraft({ ...draft, processFilters: { ...draft.processFilters, sameUserOnly: event.target.checked } })} /><span /></label></div>
      </section>
      <CodexEndpointsPanel profiles={props.profiles} onApply={props.onApplyProfile} applying={props.applyingProfile} />
      {saveBar}
        </>
      )}
      {activeSection === 'notifications' && (
        <>
          <NotificationsSection />
          <TrustedContactSummarySection />
        </>
      )}
      {activeSection === 'import' && (
        <ImportSection onImportTheme={props.onImportThemeText} onImportConfig={props.onImportConfigText} />
      )}
      {activeSection === 'profile' && (
        <ProfileSection onDisplayNameChange={props.onDisplayNameChange} />
      )}
      {activeSection === 'parental' && (
        <ParentalSection locked={props.parentalLocked} onLockChange={props.onParentalLockChange} />
      )}
      {activeSection === 'trusted-contact' && <TrustedContactSection />}
      {activeSection === 'voice' && <VoiceSection />}
      {activeSection === 'personalization' && (
        <PersonalizationSection accent={props.palette.accent} onAccentChange={(accent) => props.onPaletteChange({ accent })} />
      )}
      {activeSection === 'pet' && <PetSection sessionCount={props.sessions.length} />}
      {activeSection === 'shortcuts' && <ShortcutsSection />}
      {activeSection === 'usage' && <UsageSection sessions={props.sessions} events={props.events} />}
      {activeSection === 'account' && (
        <>
          <AccountSection connected={props.connected} running={props.running} version={APP_VERSION} />
          <EnvironmentPanel
            environment={props.environment}
            refreshing={props.environmentRefreshing}
            upgrading={props.environmentUpgrading}
            onRefresh={props.onRefreshEnvironment}
            onUpgrade={props.onUpgradeTool}
            onUpgradeAll={props.onUpgradeAllTools}
          />
        </>
      )}
      {activeSection === 'computer-control' && (
        <ComputerControlSection
          allowReveal={props.allowReveal}
          onAllowRevealChange={props.onAllowRevealChange}
          startupInstalled={props.startupInstalled}
          onToggleStartup={props.onToggleStartup}
          busy={props.saving}
          closeToTray={props.closeToTray}
          onCloseToTrayChange={props.onCloseToTrayChange}
          preferredTerminal={props.preferredTerminal}
          onPreferredTerminalChange={props.onPreferredTerminalChange}
          desktopBridgeAvailable={props.desktopBridgeAvailable}
        />
      )}
      {activeSection === 'snapshots' && (
        <SnapshotsSection sessions={props.sessions} environment={props.environment} />
      )}
      {activeSection === 'plugins' && <PluginsSection />}
      {activeSection === 'browser' && (
        <BrowserSection theme={props.activeTheme} origin={props.origin} />
      )}
      </div>
    </form>
  );
}

export interface AppProps { api?: WatchdogApi }

/** The four menu labels, in the order the reference layout presents them. */
const MENU_LABELS = ['文件', '编辑', '视图', '帮助'] as const;
type MenuLabel = (typeof MENU_LABELS)[number];

/** One row of a dropdown. `role` items without a click are display-only. */
interface MenuEntry {
  readonly label: string;
  /** Items the desktop bridge performs; absent means "renderer action". */
  readonly action?: keyof DesktopShellBridge | 'back-to-app' | 'hide' | 'about';
  /** A zoom step for the `zoom` action. */
  readonly delta?: number;
  readonly url?: string;
  /** True when the item needs a live desktop bridge to do anything. */
  readonly needsBridge?: boolean;
  readonly disabled?: boolean;
  readonly shortcut?: string;
}

const MENU_ITEMS: Record<MenuLabel, readonly (MenuEntry | 'separator')[]> = {
  文件: [
    { label: '返回应用', action: 'back-to-app' },
    'separator',
    // The desktop app hides to the tray; a plain browser has nothing to hide
    // into, so the item is disabled there rather than doing nothing silently.
    { label: '隐藏到托盘', action: 'hide', needsBridge: true },
  ],
  编辑: [
    { label: '撤销', shortcut: 'Ctrl+Z' },
    { label: '重做', shortcut: 'Ctrl+Y' },
    'separator',
    { label: '剪切', shortcut: 'Ctrl+X' },
    { label: '复制', shortcut: 'Ctrl+C' },
    { label: '粘贴', shortcut: 'Ctrl+V' },
    { label: '全选', shortcut: 'Ctrl+A' },
  ],
  视图: [
    { label: '重新加载', action: 'reload', needsBridge: true, shortcut: 'Ctrl+R' },
    'separator',
    { label: '实际大小', action: 'zoom', delta: 0, needsBridge: true, shortcut: 'Ctrl+0' },
    { label: '放大', action: 'zoom', delta: 1, needsBridge: true, shortcut: 'Ctrl+=' },
    { label: '缩小', action: 'zoom', delta: -1, needsBridge: true, shortcut: 'Ctrl+-' },
    'separator',
    { label: '切换全屏', action: 'toggleFullScreen', needsBridge: true, shortcut: 'F11' },
  ],
  帮助: [
    { label: '项目主页', url: 'https://github.com/dieWehmut/Selbstlauf' },
    { label: '关于 Selbstlauf', action: 'about' },
  ],
};

/**
 * The renderer's own title bar row.
 *
 * With `titleBarStyle: 'hidden'` the OS paints nothing but the window buttons,
 * so this row *is* the title bar: the whole row is a drag region and every
 * interactive child opts back out with `no-drag`, otherwise clicks would be
 * swallowed as window drags. The right edge reserves the gutter the native
 * minimise / maximise-restore / close buttons occupy (see the CSS comment).
 */
function TitleBar(props: {
  readonly sidebarCompact: boolean;
  readonly onToggleSidebar: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly bridge: DesktopBridge | null;
  readonly onAction: (entry: MenuEntry) => void;
}) {
  const [openMenu, setOpenMenu] = useState<MenuLabel | null>(null);
  const shell = props.bridge?.shell;

  // Clicking anywhere outside, or pressing Escape, dismisses the open dropdown.
  useEffect(() => {
    if (openMenu === null) return undefined;
    const close = () => setOpenMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    // `mousedown` rather than `click`, so the menu closes on the press that
    // starts outside it instead of waiting for a full click.
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  const open = openMenu === null ? null : MENU_ITEMS[openMenu];

  return (
    <div className="titlebar" role="toolbar" aria-label="窗口工具栏">
      <button
        className="titlebar__button"
        type="button"
        title={props.sidebarCompact ? '展开侧栏' : '收起侧栏'}
        aria-label={props.sidebarCompact ? '展开侧栏' : '收起侧栏'}
        onClick={props.onToggleSidebar}
      >
        {props.sidebarCompact ? <PanelLeftOpen size={17} /> : <PanelLeft size={17} />}
      </button>
      <button
        className="titlebar__button"
        type="button"
        title="后退"
        aria-label="后退"
        disabled={!props.canGoBack}
        aria-disabled={!props.canGoBack}
        onClick={props.onBack}
      >
        <ArrowLeft size={17} />
      </button>
      <button
        className="titlebar__button"
        type="button"
        title="前进"
        aria-label="前进"
        disabled={!props.canGoForward}
        aria-disabled={!props.canGoForward}
        onClick={props.onForward}
      >
        <ArrowRight size={17} />
      </button>

      <div className="titlebar__menus">
        {MENU_LABELS.map((label) => {
          const entries = MENU_ITEMS[label];
          return (
            <div className="titlebar__menu" key={label}>
              <button
                className={openMenu === label ? 'titlebar__menu-button is-open' : 'titlebar__menu-button'}
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenu === label}
                onClick={() => setOpenMenu((current) => (current === label ? null : label))}
              >
                {label}
              </button>
              {openMenu === label && (
                <div className="titlebar__dropdown" role="menu" aria-label={label}>
                  {entries.map((entry, index) => {
                    if (entry === 'separator') {
                      return <div className="titlebar__separator" role="separator" key={`sep-${index}`} />;
                    }
                    // An item that needs the desktop bridge is disabled — with a
                    // real accessible disabled state — in a plain browser.
                    const needsBridge = entry.needsBridge === true && shell === undefined;
                    const disabled = entry.disabled === true || needsBridge;
                    return (
                      <button
                        className="titlebar__item"
                        type="button"
                        role="menuitem"
                        key={entry.label}
                        disabled={disabled}
                        aria-disabled={disabled}
                        title={needsBridge ? '仅在桌面应用中可用' : undefined}
                        onClick={() => {
                          setOpenMenu(null);
                          props.onAction(entry);
                        }}
                      >
                        <span>{entry.label}</span>
                        {entry.shortcut && <span className="titlebar__shortcut">{entry.shortcut}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App({ api: suppliedApi }: AppProps) {
  const api = useMemo(() => suppliedApi ?? createApi(), [suppliedApi]);
  const staticDemo = import.meta.env.VITE_STATIC_DEMO === 'true';
  // Read once: the bridge is installed by the preload before the page script
  // runs, so it never appears or disappears during a session.
  const bridge = useMemo(() => desktopBridge(), []);
  const [page, setPage] = useState<Page>('overview');
  /**
   * In-app page history for the title bar's back/forward arrows.
   *
   * The app is a single route in a loopback page, so `window.history` has
   * nothing to walk; the two stacks are the whole navigation model. `back`
   * holds visited pages oldest-first and `forward` is the redo stack.
   */
  const [history, setHistory] = useState<{ back: Page[]; forward: Page[] }>({ back: [], forward: [] });

  /**
   * Change page and record it, so 后退 can return here.
   *
   * Every in-app navigation goes through this rather than `setPage`, otherwise
   * a jump from the sidebar would be invisible to the arrows.
   */
  const navigate = (next: Page) => {
    setPage((current) => {
      if (current === next) return current;
      setHistory((stack) => ({ back: [...stack.back, current], forward: [] }));
      return next;
    });
  };

  const goBack = () => {
    setHistory((stack) => {
      const previous = stack.back.at(-1);
      if (previous === undefined) return stack;
      setPage(previous);
      return { back: stack.back.slice(0, -1), forward: [page, ...stack.forward] };
    });
  };

  const goForward = () => {
    setHistory((stack) => {
      const [next, ...rest] = stack.forward;
      if (next === undefined) return stack;
      setPage(next);
      return { back: [...stack.back, page], forward: rest };
    });
  };

  /** Open the settings page on a named section (used by the rail and the tray). */
  const openSettings = (section?: string) => {
    if (section !== undefined && SETTINGS_SECTION_IDS.includes(section)) setSettingsSection(section);
    navigate('settings');
    setSidebarOpen(false);
  };
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem('watchdog-theme');
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
  });
  // Per-scheme palette overrides, so a custom dark palette survives a switch
  // to light and back.
  const [paletteOverrides, setPaletteOverrides] = useState<Partial<Record<Theme, ThemePalette>>>(() => loadPaletteOverrides());
  const [prefersLight, setPrefersLight] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(THEME_QUERY).matches);
  const theme = resolveTheme(themePreference, prefersLight);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  /** Which settings rail entry is in view; the tray can open one by name. */
  const [settingsSection, setSettingsSection] = useState<string>(DEFAULT_SETTINGS_SECTION);
  /** The name the sidebar brand block shows once 个人资料 sets one. */
  const [displayName, setDisplayName] = useState(() => readPref<ProfilePref>(PREF_KEYS.profile, PROFILE_DEFAULTS, isProfilePref).displayName);
  /** Parental control: while locked, saving the config requires the PIN again. */
  const [parentalLocked, setParentalLocked] = useState(() => readPref(PREF_KEYS.parental, PARENTAL_DEFAULTS, isParentalPref).enabled);
  /** 电脑操控: whether the process table may reveal a session's window. */
  const [allowReveal, setAllowReveal] = useState(() => readPref(PREF_KEYS.computerControl, { allowReveal: true }, isRevealPref).allowReveal);
  /** Desktop-shell preferences, mirrored from the main process when available. */
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [preferredTerminal, setPreferredTerminal] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthView>({ ok: false, running: false, dryRun: true, lastPollAtMs: null });
  const [startupInstalled, setStartupInstalled] = useState(false);
  const [hookStatus, setHookStatus] = useState<ClaudeHookStatusView>(fallbackHookStatus);
  const [codexProfiles, setCodexProfiles] = useState<CodexProfilesView | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentView | null>(null);
  const [environmentRefreshing, setEnvironmentRefreshing] = useState(false);
  // 'all' while a bulk run is in flight, otherwise the tool id, otherwise null.
  const [environmentUpgrading, setEnvironmentUpgrading] = useState<string | null>(null);
  const [applyingProfile, setApplyingProfile] = useState(false);
  const [config, setConfig] = useState(fallbackConfig);
  const [sessions, setSessions] = useState<SessionView[]>(staticDemo ? fallbackSessions : []);
  const [events, setEvents] = useState<AuditEvent[]>(staticDemo ? fallbackEvents : []);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Each scheme keeps its own palette, so a preview card shows that scheme's
  // colours rather than whatever scheme happens to be active.
  const palettes: Record<Theme, ThemePalette> = {
    light: paletteOverrides.light ?? DEFAULT_PALETTES.light,
    dark: paletteOverrides.dark ?? DEFAULT_PALETTES.dark,
  };
  const palette = palettes[theme];
  const paletteCustomized = paletteOverrides[theme] !== undefined;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /**
   * Mark the document when the page really is inside the desktop shell.
   *
   * The right-hand gutter for the native window buttons is only reserved then;
   * in a plain browser the title bar row uses ordinary padding instead of
   * leaving a dead 148px strip under nothing.
   */
  useEffect(() => {
    if (bridge === null) return undefined;
    document.documentElement.dataset.shell = 'desktop';
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, [bridge]);

  /**
   * Follow commands from the native menu bar and the tray.
   *
   * The main process sends these over the bridge; the same two commands arrive
   * from `文件 -> 返回应用` and from the tray's settings entries, so the
   * renderer has one place that knows what "go to the app" and "open settings"
   * mean. An unknown section falls back to simply opening the settings page.
   */
  useEffect(() => {
    if (bridge?.onCommand === undefined) return undefined;
    return bridge.onCommand((payload) => {
      if (payload.command === 'back-to-app') {
        navigate('overview');
        setSidebarOpen(false);
        return;
      }
      if (payload.command === 'open-settings') {
        openSettings(payload.section);
      }
    });
  }, [bridge]);

  /**
   * Mirror the desktop shell's own preferences.
   *
   * `closeToTray` and `preferredTerminal` live in the main process because they
   * drive the window lifecycle, so they are read once and written back through
   * the bridge. In a plain browser the bridge is absent and both stay null, which
   * is exactly what makes the matching rows render disabled instead of lying.
   */
  useEffect(() => {
    const settings = bridge?.settings;
    if (settings === undefined) return undefined;
    let active = true;
    void (async () => {
      try {
        const current = await settings.get();
        if (!active) return;
        setCloseToTray(current.closeToTray ?? null);
        setPreferredTerminal(current.preferredTerminal ?? null);
      } catch {
        // An older bridge without these fields leaves the rows disabled.
      }
    })();
    return () => { active = false; };
  }, [bridge]);

  const changeCloseToTray = (value: boolean) => {
    setCloseToTray(value);
    void bridge?.settings?.set({ closeToTray: value }).catch(() => setNotice('关闭行为保存失败'));
  };

  const changePreferredTerminal = (value: string) => {
    setPreferredTerminal(value);
    void bridge?.settings?.set({ preferredTerminal: value }).catch(() => setNotice('首选终端保存失败'));
  };

  const changeAllowReveal = (allowed: boolean) => {
    setAllowReveal(allowed);
    writePref(PREF_KEYS.computerControl, { allowReveal: allowed });
  };

  /**
   * Keyboard shortcuts, exactly the set the 键盘快捷键 section documents.
   *
   * Ctrl+1..3 switch page. They are ignored while a text field has focus, so the
   * bindings cannot steal a typing or IME shortcut. Adding a binding here means
   * adding the matching row to `SHORTCUTS` in `./settings/sections`.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const shortcutPages: Record<string, Page> = { '1': 'overview', '2': 'timeline', '3': 'settings' };
      const next = shortcutPages[event.key];
      if (next === undefined) return;
      event.preventDefault();
      navigate(next);
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page]);

  /**
   * Notification preferences.
   *
   * Read on every render rather than held in state: the panel toggles them on a
   * different page, and this way the timeline limit and the notice strip follow
   * a change without the app having to be remounted.
   */
  const notifications = readPref(PREF_KEYS.notifications, NOTIFICATIONS_DEFAULTS, isNotificationsPref);
  const visibleEvents = useMemo(() => events.slice(0, notifications.timelineLimit), [events, notifications.timelineLimit]);

  /**
   * Run a title bar menu item.
   *
   * Items that need the desktop bridge are already disabled without it, so this
   * only ever calls into `shell` when it exists.
   */
  const runMenuAction = (entry: MenuEntry) => {
    const shell = bridge?.shell;
    if (entry.action === 'back-to-app') {
      // Back to the overview and out of the mobile drawer, so the page the
      // person lands on is the one they can actually see.
      navigate('overview');
      setSidebarOpen(false);
      return;
    }
    if (entry.action === 'about') {
      navigate('settings');
      setSidebarOpen(false);
      return;
    }
    if (entry.action === 'hide') {
      // "隐藏到托盘" is the same gesture as the window's own close button: the
      // desktop shell turns `close` into a hide (see the main process lifecycle),
      // which is why this never calls the bridge's quit action — the tray owns
      // the only real quit. In a plain browser the item is disabled anyway.
      window.close();
      return;
    }
    if (entry.url !== undefined) {
      // External links go through the shell when there is one, so they open in
      // the OS browser rather than navigating the app's own window.
      if (shell?.openExternal !== undefined) void shell.openExternal(entry.url);
      else window.open(entry.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (entry.action === 'zoom') shell?.zoom?.(entry.delta ?? 0);
    if (entry.action === 'reload') shell?.reload?.();
    if (entry.action === 'toggleFullScreen') shell?.toggleFullScreen?.();
    if (entry.action === 'quit') shell?.quit?.();
  };

  /**
   * Paint the chosen palette onto the document root.
   *
   * Inline custom properties win over the [data-theme] blocks, so one set of
   * values covers everything the stylesheet already derives from them.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', palette.accent);
    root.style.setProperty('--accent-strong', mixColor(palette.accent, theme === 'dark' ? '#ffffff' : '#000000', 0.28));
    root.style.setProperty('--bg', palette.background);
    root.style.setProperty('--text', palette.foreground);

    // The slider drives how far surfaces and borders sit from the background.
    // Surfaces always lift toward white, which is the direction both schemes
    // use: a dark page gains a lighter card, a light page gains a white one.
    const lift = (weight: number) => mixColor(palette.background, '#ffffff', weight + palette.contrast / 1400);
    root.style.setProperty('--panel', lift(0.012));
    root.style.setProperty('--panel-soft', lift(0.004));
    root.style.setProperty('--panel-raised', lift(0.022));
    root.style.setProperty('--line', mixColor(palette.background, palette.foreground, 0.1 + palette.contrast / 420));

    const uiType = fontStack(palette.uiType.family);
    const content = palette.contentType.sameAsUi ? uiType : fontStack(palette.contentType.family);
    root.style.setProperty('--ui-font', uiType);
    root.style.setProperty('--content-font', content);
    root.style.setProperty('--ui-weight', String(palette.uiType.weight));
    root.style.setProperty('--content-weight', String(palette.contentType.weight));

    root.dataset.sidebar = palette.translucentSidebar ? 'translucent' : 'solid';
  }, [palette, theme]);

  /**
   * Keep the native window-button strip on the same surface as the title bar.
   *
   * The bar is `--panel-soft`, which the palette effect above derives from the
   * background, contrast and accent. Rather than duplicate that formula (and let
   * the two drift), this reads the colour the browser actually resolved and
   * reports it; the main process repaints the OS strip to match. In a plain
   * browser the bridge is absent and this does nothing.
   */
  useEffect(() => {
    const setOverlay = bridge?.shell?.setTitleBarOverlay;
    if (setOverlay === undefined || typeof document === 'undefined') return;
    const bar = document.querySelector('.titlebar');
    if (bar === null) return;
    const background = window.getComputedStyle(bar).backgroundColor;
    const channels = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(background);
    if (channels === null) return;
    const color = `#${[1, 2, 3]
      .map((index) => Number(channels[index]).toString(16).padStart(2, '0'))
      .join('')}`;
    // The glyph colour follows the text token so the buttons stay legible on
    // both the dark and the light palette.
    const foreground = window.getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
    setOverlay({
      color,
      ...(HEX_COLOR.test(foreground) ? { symbolColor: foreground } : {}),
    });
  }, [bridge, palette, theme]);

  useEffect(() => {
    localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(paletteOverrides));
  }, [paletteOverrides]);

  // The stored value is the preference, so "system" survives a reload and
  // re-resolves against whatever the OS reports then.
  useEffect(() => {
    localStorage.setItem('watchdog-theme', themePreference);
  }, [themePreference]);

  // Follow the OS while "system" is selected, and stop listening otherwise.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(THEME_QUERY);
    const apply = () => setPrefersLight(query.matches);
    apply();
    query.addEventListener?.('change', apply);
    return () => query.removeEventListener?.('change', apply);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (!sidebarOpen) {
      document.body.style.overflow = '';
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [sidebarOpen]);

  const refresh = async () => {
    try {
      const [nextHealth, nextConfig, nextSessions, nextStartup, nextHookStatus, nextCodexProfiles] = await Promise.all([
        api.health(),
        api.config(),
        api.sessions(),
        api.startup(),
        api.claudeHook(),
        api.codexProfiles(),
      ]);
      setHealth(nextHealth);
      setConfig(nextConfig);
      setSessions(nextSessions);
      setStartupInstalled(nextStartup.installed);
      setHookStatus(nextHookStatus);
      setCodexProfiles(nextCodexProfiles);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  };

  useEffect(() => {
    if (staticDemo && suppliedApi === undefined) return undefined;
    let active = true;
    let environmentPending = false;
    // npm diagnostics can be slow; they must not hold up monitoring or controls.
    const loadEnvironment = async () => {
      if (environmentPending) return;
      environmentPending = true;
      try {
        const report = await api.environment();
        if (active) setEnvironment(report);
      } catch {
        // Keep the last report and let the next poll retry independently.
      } finally { environmentPending = false; }
    };
    void refresh();
    void loadEnvironment();
    const unsubscribe = api.subscribe((event: WatchdogEvent) => {
      if (event.kind === 'audit') setEvents((current) => [event.event, ...current].slice(0, 100));
      else void refresh();
    });
    const timer = window.setInterval(() => {
      void refresh();
      void loadEnvironment();
    }, 10_000);
    return () => { active = false; unsubscribe(); window.clearInterval(timer); };
  }, [api, staticDemo]);

  const mutateSession = async (session: SessionView, action: 'pause' | 'inject') => {
    setBusy(session.id); setNotice(null);
    try {
      if (action === 'inject') await api.inject(session.id);
      else if (session.paused) await api.resume(session.id);
      else await api.pause(session.id);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败');
    } finally { setBusy(null); }
  };

  const focusSession = async (session: SessionView) => {
    // 电脑操控 can switch the reveal action off; the buttons are disabled too, so
    // this is the belt-and-braces half of the same rule.
    if (!allowReveal) {
      setNotice('“打开运行位置”已在 电脑操控 中被关闭');
      return;
    }
    setBusy(session.id); setNotice(null);
    try {
      const result = await api.focus(session.id);
      setNotice(result.focused
        ? `已打开 ${session.host?.label ?? '运行位置'}`
        : `已置顶 ${session.host?.label ?? '运行位置'}（系统未授予前台焦点）`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法打开运行位置');
    } finally { setBusy(null); }
  };

  /**
   * Re-probe the machine instead of reusing the service's cached scan.
   * The probe shells out to npm, so the button reports its own progress.
   */
  const refreshEnvironment = async () => {
    setEnvironmentRefreshing(true); setNotice(null);
    try {
      setEnvironment(await api.refreshEnvironment());
      setNotice('本地环境已刷新');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '刷新失败');
    } finally { setEnvironmentRefreshing(false); }
  };
  /**
   * Install one agent CLI, then re-read the report.
   *
   * The panel must show what actually got installed, so the service's fresh
   * scan replaces the optimistic view instead of the button just disappearing.
   */
  const upgradeTool = async (id: string) => {
    setEnvironmentUpgrading(id); setNotice(null);
    try {
      const result = await api.upgradeTool(id);
      setEnvironment(await api.environment());
      setNotice(result.ok ? `${id} 升级完成` : `${id} 升级失败：${result.error ?? '未知错误'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '升级失败');
    } finally { setEnvironmentUpgrading(null); }
  };

  const upgradeAllTools = async () => {
    setEnvironmentUpgrading('all'); setNotice(null);
    try {
      const outcome = await api.upgradeAllTools();
      setEnvironment(await api.environment());
      const failed = outcome.results.filter((result) => !result.ok);
      setNotice(failed.length === 0
        ? `${outcome.results.length} 个工具已升级`
        : `${outcome.results.length - failed.length} 个成功，${failed.length} 个失败`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '全部升级失败');
    } finally { setEnvironmentUpgrading(null); }
  };

  /**
   * Change one field of the palette for the scheme in effect.
   *
   * The override belongs to that scheme, so switching to light keeps the
   * custom dark accent where it was set.
   */
  const changePalette = (patch: Partial<ThemePalette>) => {
    setPaletteOverrides((current) => ({
      ...current,
      [theme]: { ...(current[theme] ?? DEFAULT_PALETTES[theme]), ...patch },
    }));
  };

  const resetPalette = () => {
    setPaletteOverrides((current) => {
      const next = { ...current };
      delete next[theme];
      return next;
    });
  };

  const importTheme = async () => {
    setNotice(null);
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text) as unknown;
      if (!isThemePalette(parsed)) throw new TypeError('剪贴板里不是有效的主题配置');
      const imported = normalizePalette(parsed, DEFAULT_PALETTES[theme]);
      setPaletteOverrides((current) => ({ ...current, [theme]: imported }));
      setNotice('主题已导入');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入失败');
    }
  };

  const copyTheme = async () => {
    await navigator.clipboard.writeText(JSON.stringify(palette, null, 2));
    setNotice('主题已复制');
  };

  /**
   * Apply a theme blob the import section read from the clipboard.
   *
   * The section owns reading and parsing; applying it stays here so it uses the
   * same palette-override path as the appearance panel's own import button.
   */
  const importThemeText = async (text: string) => {
    const parsed = JSON.parse(text) as unknown;
    if (!isThemePalette(parsed)) throw new TypeError('剪贴板里不是有效的主题配置');
    setPaletteOverrides((current) => ({ ...current, [theme]: normalizePalette(parsed, DEFAULT_PALETTES[theme]) }));
    setNotice('主题已导入');
  };

  /** Apply a config blob from the clipboard through the normal save path. */
  const importConfigText = async (text: string) => {
    await saveConfig(JSON.parse(text) as WatchdogConfig);
  };

  /**
   * Save the service config.
   *
   * When 家长控制 is on this first demands the PIN: the read view is never
   * hidden, only the ability to persist an edited draft. The supplied PIN is
   * obfuscated with the same function the section used, so the plaintext only
   * ever exists in the prompt.
   */
  const saveConfig = async (nextConfig: WatchdogConfig) => {
    if (parentalLocked) {
      const stored = readPref(PREF_KEYS.parental, PARENTAL_DEFAULTS, isParentalPref);
      const supplied = window.prompt('家长控制已启用，请输入 PIN 以保存配置');
      if (supplied === null) return;
      if (stored.pinHash === null || hashPin(supplied) !== stored.pinHash) {
        setNotice('PIN 不正确，未保存配置');
        return;
      }
    }
    setSaving(true); setNotice(null);
    try {
      const saved = await api.updateConfig(nextConfig);
      setConfig(saved);
      setHookStatus((current) => ({ ...current, enabled: saved.tools.claude.stopHook.enabled }));
      setNotice('配置已保存');
    }
    catch (error) { setNotice(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };

  const applyCodexProfile = async (fields: CodexProfileFieldView[]) => {
    setApplyingProfile(true); setNotice(null);
    try {
      await api.applyCodexProfile(fields);
      setCodexProfiles(await api.codexProfiles());
      setNotice('Codex 端点已切换');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换失败');
    } finally { setApplyingProfile(false); }
  };

  const updateClaudeHook = async (action: 'disable' | 'install' | 'uninstall') => {
    setSaving(true);
    setNotice(null);
    try {
      const status = action === 'install'
        ? await api.installClaudeHook()
        : action === 'uninstall'
          ? await api.uninstallClaudeHook()
          : await api.disableClaudeHook();
      setHookStatus(status);
      if (action === 'disable') {
        setConfig((current) => ({
          ...current,
          tools: {
            ...current.tools,
            claude: {
              ...current.tools.claude,
              stopHook: { ...current.tools.claude.stopHook, enabled: false },
            },
          },
        }));
      }
      if (status.manualReviewRequired) {
        setNotice(status.lastError ?? 'Stop Hook 需要人工检查');
      } else if (action === 'install') {
        setNotice(status.restartRequired ? 'Stop Hook 已安装；需重启 Claude' : 'Stop Hook 已安装');
      } else if (action === 'uninstall') {
        setNotice('Stop Hook 已卸载');
      } else {
        setNotice('Stop Hook 已停用并清空待处理 Lease');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Stop Hook 操作失败');
    } finally {
      setSaving(false);
    }
  };

  const uninstall = async () => {
    if (!window.confirm('停止并卸载 Continuation Watchdog？')) return;
    setSaving(true);
    try { await api.uninstall(); setHealth({ ok: false, running: false, dryRun: config.dryRun, lastPollAtMs: null }); setNotice('卸载已启动'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '卸载失败'); }
    finally { setSaving(false); }
  };

  const install = async () => {
    setSaving(true);
    setNotice(null);
    try { await api.install(); setNotice('Watchdog 已安装'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '安装失败'); }
    finally { setSaving(false); }
  };

  const toggleStartup = async () => {
    setSaving(true);
    setNotice(null);
    try {
      if (startupInstalled) {
        await api.uninstallStartup();
        setStartupInstalled(false);
        setNotice('启动项已移除');
      } else {
        await api.installStartup();
        setStartupInstalled(true);
        setNotice('启动项已安装');
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : '启动项操作失败'); }
    finally { setSaving(false); }
  };

  const emergencyStop = async () => {
    await stopWatchdog();
  };

  const stopWatchdog = async () => {
    setSaving(true);
    try { await api.stop(); setHealth((current) => ({ ...current, running: false })); setNotice('Watchdog 已停止'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '停止失败'); }
    finally { setSaving(false); }
  };

  const startWatchdog = async () => {
    setSaving(true);
    try { await api.start(); setHealth((current) => ({ ...current, ok: true, running: true })); setNotice('Watchdog 已启动'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '启动失败'); }
    finally { setSaving(false); }
  };

  const toggleWatchdog = () => health.running ? stopWatchdog() : startWatchdog();

  const ready = sessions.filter(canInject).length;
  const goalCount = sessions.filter((session) => session.tool === 'codex' && session.goal && ['active', 'paused'].includes(session.goal.status)).length;

  const nav = [
    { id: 'overview' as const, label: '进程', icon: LayoutDashboard },
    { id: 'timeline' as const, label: '事件', icon: ListTree },
    { id: 'settings' as const, label: '设置', icon: Settings2 },
  ];

  return (
    <div className={`app-shell ${sidebarCompact ? 'app-shell--compact' : ''}`}>
      {/* Row 1 spans both grid columns: it is the window's title bar, so the
          sidebar must not sit beside it. */}
      <TitleBar
        sidebarCompact={sidebarCompact}
        onToggleSidebar={() => setSidebarCompact((current) => !current)}
        canGoBack={history.back.length > 0}
        canGoForward={history.forward.length > 0}
        onBack={goBack}
        onForward={goForward}
        bridge={bridge}
        onAction={runMenuAction}
      />
      <button className={`mobile-overlay ${sidebarOpen ? 'is-open' : ''}`} type="button" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)} />
      <aside id="watchdog-sidebar" className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="brand"><span className="brand__mark" data-testid="brand-mark"><img src={brandIcon} alt="" width={34} height={34} /></span><div><strong>{displayName.trim().length > 0 ? displayName : 'Selbstlauf'}</strong><span>continuation watchdog</span></div><button className="sidebar-close icon-button" type="button" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <nav aria-label="主导航">{nav.map((item) => <button key={item.id} className={`nav-button ${page === item.id ? 'is-active' : ''}`} type="button" aria-current={page === item.id ? 'page' : undefined} title={sidebarCompact ? item.label : undefined} onClick={() => { navigate(item.id); setSidebarOpen(false); }}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
        <div className="sidebar__footer"><div className="service-mini"><span className={`status-light ${connected ? 'is-online' : ''}`} /><div><strong>{connected ? '服务在线' : staticDemo ? '离线预览' : '服务未连接'}</strong><span>{sessions.length} 个进程</span></div></div><button className="nav-button" type="button" title={theme === 'dark' ? '切换亮色' : '切换暗色'} onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}<span>{theme === 'dark' ? '亮色' : '暗色'}</span></button><button className="compact-toggle icon-button" type="button" title={sidebarCompact ? '展开侧栏' : '收起侧栏'} aria-label={sidebarCompact ? '展开侧栏' : '收起侧栏'} onClick={() => setSidebarCompact(!sidebarCompact)}>{sidebarCompact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button></div>
      </aside>

      <main className="workspace">
        <header className="topbar"><div className="topbar__title"><button className="mobile-menu icon-button" type="button" aria-label="打开菜单" aria-controls="watchdog-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div><span className="eyebrow">Local control</span><h1>{page === 'overview' ? '进程监控' : page === 'timeline' ? '事件记录' : 'Watchdog 设置'}</h1></div></div><div className="topbar__actions"><span className="poll-age" aria-label="Last watchdog poll"><Activity size={14} />轮询 {health.lastPollAtMs === null ? '--' : duration(Math.max(0, Date.now() - health.lastPollAtMs))} 前</span>{config.dryRun && <span className="mode-badge"><ShieldAlert size={15} />DRY RUN</span>}<button className="icon-button" type="button" title="刷新" aria-label="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></button>{health.running ? <button className="button button--stop" type="button" onClick={() => void emergencyStop()} disabled={saving}><Power size={16} />紧急停止</button> : <button className="button button--start" type="button" onClick={() => void startWatchdog()} disabled={saving}><CirclePlay size={16} />启动 Watchdog</button>}</div></header>

        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="关闭通知" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        {page === 'overview' && <div className="page-content">
          <section className="metric-strip" aria-label="运行概览"><div><span>发现进程</span><strong>{sessions.length}</strong></div><div><span>可写入</span><strong>{ready}</strong></div><div><span>Codex Goal</span><strong>{goalCount}</strong></div><div><span>服务状态</span><strong className={health.running ? 'text-ready' : 'text-warn'}>{health.running ? '运行中' : connected ? '已停止' : '离线'}</strong></div></section>
          <section className="content-section"><div className="section-heading"><div><span className="eyebrow">Sessions</span><h2>独立进程</h2></div><span className="section-meta"><span className={`status-light ${connected ? 'is-online' : ''}`} />{connected ? '实时同步' : staticDemo ? '样例数据' : '等待连接'}</span></div><ProcessTable sessions={sessions} config={config} busy={busy} allowReveal={allowReveal} onPause={(session) => void mutateSession(session, 'pause')} onInject={(session) => void mutateSession(session, 'inject')} onFocus={(session) => void focusSession(session)} /></section>
          <section className="content-section compact-events"><div className="section-heading"><div><span className="eyebrow">Recent</span><h2>最近事件</h2></div><button className="text-button" type="button" onClick={() => navigate('timeline')}>查看全部</button></div><Timeline events={visibleEvents.slice(0, 5)} /></section>
        </div>}

        {page === 'timeline' && <div className="page-content"><section className="content-section"><div className="section-heading"><div><span className="eyebrow">Audit</span><h2>决策与写入</h2></div><span className="section-meta">{visibleEvents.length} 条</span></div><Timeline events={visibleEvents} /></section></div>}
        {page === 'settings' && <div className="page-content"><SettingsPanel config={config} theme={themePreference} activeTheme={theme} palette={palette} palettes={palettes} customized={paletteCustomized} onThemeChange={setThemePreference} onPaletteChange={changePalette} onPaletteReset={resetPalette} onImportTheme={importTheme} onCopyTheme={copyTheme} environment={environment} environmentRefreshing={environmentRefreshing} onRefreshEnvironment={refreshEnvironment} environmentUpgrading={environmentUpgrading} onUpgradeTool={upgradeTool} onUpgradeAllTools={upgradeAllTools} hookStatus={hookStatus} profiles={codexProfiles} applyingProfile={applyingProfile} onApplyProfile={applyCodexProfile} saving={saving} running={health.running} onSave={saveConfig} onToggle={toggleWatchdog} onInstall={install} startupInstalled={startupInstalled} onToggleStartup={toggleStartup} onInstallClaudeHook={() => updateClaudeHook('install')} onUninstallClaudeHook={() => updateClaudeHook('uninstall')} onDisableClaudeHook={() => updateClaudeHook('disable')} onUninstall={uninstall} sessions={sessions} events={events} connected={connected} activeSection={settingsSection} onSectionChange={setSettingsSection} onBack={() => { navigate('overview'); setSidebarOpen(false); }} onImportThemeText={importThemeText} onImportConfigText={importConfigText} onDisplayNameChange={setDisplayName} allowReveal={allowReveal} onAllowRevealChange={changeAllowReveal} closeToTray={closeToTray} onCloseToTrayChange={changeCloseToTray} preferredTerminal={preferredTerminal} onPreferredTerminalChange={changePreferredTerminal} desktopBridgeAvailable={bridge !== null} parentalLocked={parentalLocked} onParentalLockChange={setParentalLocked} origin={window.location.origin} /></div>}
      </main>
    </div>
  );
}
