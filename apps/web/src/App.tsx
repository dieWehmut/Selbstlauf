import {
  Activity,
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

type Page = 'overview' | 'timeline' | 'settings';
/** What the person chose; 'system' resolves against the OS preference. */
type ThemePreference = 'light' | 'dark' | 'system';
type Theme = 'light' | 'dark';

/** Settings sections, in the order the reference panel presents them. */
type SettingsTabId = 'general' | 'monitor' | 'about';

const SETTINGS_TABS: readonly { readonly id: SettingsTabId; readonly label: string }[] = Object.freeze([
  Object.freeze({ id: 'general' as const, label: '通用' }),
  Object.freeze({ id: 'monitor' as const, label: '监控' }),
  Object.freeze({ id: 'about' as const, label: '关于' }),
]);
const THEME_QUERY = '(prefers-color-scheme: light)';

/** Resolve a stored preference to the colour scheme actually applied. */
function resolveTheme(preference: ThemePreference, prefersLight: boolean): Theme {
  if (preference === 'system') return prefersLight ? 'light' : 'dark';
  return preference;
}

/** A per-theme palette override chosen in the appearance section. */
interface ThemePalette {
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
}

/** The palette each theme starts from; also what reset returns to. */
const DEFAULT_PALETTES: Record<Theme, ThemePalette> = {
  dark: { accent: '#e6b65b', background: '#0d1216', foreground: '#e9eef0' },
  light: { accent: '#a56a08', background: '#eef2f1', foreground: '#1c262b' },
};

/** Ready-made accents, so the common pick needs no colour wheel. */
const ACCENT_PRESETS: readonly { readonly label: string; readonly value: string }[] = [
  { label: '粉色', value: '#e05c93' },
  { label: '天蓝', value: '#4c9cd4' },
  { label: '翠绿', value: '#5aa97c' },
  { label: '石墨', value: '#8a949b' },
];

const PALETTE_STORAGE_KEY = 'watchdog-palette';
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

/** Accept only a complete #rrggbb palette, so a bad import cannot half-apply. */
function isThemePalette(value: unknown): value is ThemePalette {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<Record<keyof ThemePalette, unknown>>;
  return (['accent', 'background', 'foreground'] as const).every((key) =>
    typeof entry[key] === 'string' && HEX_COLOR.test(entry[key] as string));
}

/** Load the saved overrides; a missing or corrupt entry just means "default". */
function loadPaletteOverrides(): Partial<Record<Theme, ThemePalette>> {
  try {
    const stored = globalThis.localStorage.getItem(PALETTE_STORAGE_KEY);
    if (stored === null) return {};
    const parsed = JSON.parse(stored) as Partial<Record<Theme, unknown>>;
    const overrides: Partial<Record<Theme, ThemePalette>> = {};
    for (const theme of ['light', 'dark'] as const) {
      if (isThemePalette(parsed[theme])) overrides[theme] = parsed[theme] as ThemePalette;
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
}

function SessionActions({ session, busy, onPause, onInject, onFocus }: SessionActionsProps) {
  const waiting = busy === session.id;
  return (
    <div className="row-actions">
      <button
        className="icon-button"
        type="button"
        title="打开运行位置"
        aria-label={`打开运行位置 PID ${session.rootPid}`}
        disabled={waiting || !session.alive || session.host === null || session.host === undefined}
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
                <td><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} onFocus={props.onFocus} /></td>
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
            <footer><DecisionChip decision={session.lastDecision} /><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} onFocus={props.onFocus} /></footer>
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
 * Mirrors the reference's appearance page: three theme previews, a diff of the
 * variables each theme resolves to, and the accent picker. The previews are
 * drawn from the same palette the app uses, so picking one is not a leap of
 * faith about what the app will look like.
 */
const THEME_OPTIONS: readonly { readonly id: ThemePreference; readonly label: string; readonly ariaLabel: string }[] = [
  { id: 'system', label: '系统', ariaLabel: '跟随系统' },
  { id: 'light', label: '浅色', ariaLabel: '浅色' },
  { id: 'dark', label: '深色', ariaLabel: '深色' },
];

/** The vars each preview card paints itself from. */
function previewPalette(theme: Theme, palettes: Record<Theme, ThemePalette>): ThemePalette {
  return palettes[theme];
}

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
      <span className="theme-preview__bar" style={{ background: palette.accent }} />
      <span className="theme-preview__line" style={{ background: palette.foreground, opacity: .55 }} />
      <span className="theme-preview__line theme-preview__line--short" style={{ background: palette.foreground, opacity: .32 }} />
      <span className="theme-preview__block" style={{ background: mixColor(palette.background, palette.foreground, scheme === 'dark' ? 0.14 : 0.06) }} />
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

function ThemeDiffPreview(props: {
  readonly palette: ThemePalette;
  readonly activeTheme: Theme;
}) {
  // The left pane is always the stock palette, so the comparison reads as a diff.
  const before = DEFAULT_PALETTES[props.activeTheme];
  const after = props.palette;
  const rows: readonly { readonly key: string; readonly label: string; readonly from: string; readonly to: string }[] = [
    { key: 'surface', label: 'surface', from: before.background, to: after.background },
    { key: 'accent', label: 'accent', from: before.accent, to: after.accent },
    { key: 'contrast', label: 'foreground', from: before.foreground, to: after.foreground },
  ];
  return (
    <div className="theme-diff" data-testid="theme-diff">
      <div className="theme-diff__pane">
        <span className="theme-diff__pane-title">当前主题</span>
        <pre>{rows.map((row) => `${row.label}: "${row.from}"`).join('\n')}</pre>
      </div>
      <span className="theme-diff__arrow" aria-hidden="true">→</span>
      <div className="theme-diff__pane theme-diff__pane--after">
        <span className="theme-diff__pane-title">修改后</span>
        <pre>{rows.map((row) => `${row.label}: "${row.to}"`).join('\n')}</pre>
      </div>
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
  return (
    <section className="settings-section settings-section--wide appearance-panel">
      <div className="section-title"><div><span className="eyebrow">Appearance</span><h2>外观</h2></div><Sun size={20} /></div>
      <p className="section-hint">选择应用的外观主题，立即生效。</p>
      <div className="theme-previews" role="radiogroup" aria-label="外观主题">
        {THEME_OPTIONS.map((option) => (
          <ThemePreviewCard
            key={option.id}
            id={option.id}
            label={option.label}
            ariaLabel={option.ariaLabel}
            scheme={option.id === 'system' ? props.activeTheme : option.id}
            selected={props.preference === option.id}
            palette={previewPalette(option.id === 'system' ? props.activeTheme : option.id, props.palettes)}
            systems={[props.palettes.light, props.palettes.dark]}
            onSelect={() => props.onPreferenceChange(option.id)}
          />
        ))}
      </div>
      <ThemeDiffPreview palette={props.palette} activeTheme={props.activeTheme} />
      <div className="appearance-actions">
        <label className="appearance-color">
          <span>强调色</span>
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
        </label>
        <label className="appearance-color">
          <span>背景</span>
          <input
            type="color"
            aria-label="背景"
            value={props.palette.background}
            onChange={(event) => props.onPaletteChange({ background: event.target.value })}
          />
          <code>{props.palette.background}</code>
        </label>
        <label className="appearance-color">
          <span>前景</span>
          <input
            type="color"
            aria-label="前景"
            value={props.palette.foreground}
            onChange={(event) => props.onPaletteChange({ foreground: event.target.value })}
          />
          <code>{props.palette.foreground}</code>
        </label>
      </div>
      <div className="theme-actions">
        <button className="text-button" type="button" onClick={() => void props.onImport()}>
          <Copy size={14} /> 导入
        </button>
        <button className="text-button" type="button" onClick={() => void copy()}>
          <Copy size={14} /> {copyState === 'done' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制主题'}
        </button>
        {props.customized && (
          <button className="text-button" type="button" onClick={props.onPaletteReset}>恢复默认</button>
        )}
      </div>
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
}) {
  const [draft, setDraft] = useState(() => structuredClone(props.config));
  // Monitoring is the working view, so it is what the page opens on; the
  // tab bar is how a person reaches appearance, locale, and about.
  const [activeTab, setActiveTab] = useState<SettingsTabId>('monitor');
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

  return (
    <form className="settings-grid" onSubmit={submit}>
      <div className="settings-tabs" role="tablist" aria-label="设置分区">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={tab.id === activeTab ? 'settings-tab is-active' : 'settings-tab'}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === 'general' && (
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
            <p className="section-hint">切换后立即预览界面语言，保存后永久生效。</p>
            <div className="segmented segmented--labels" role="group" aria-label="界面语言">
              {['简体中文', '繁體中文', 'English', '日本語'].map((language) => (
                <button
                  key={language}
                  className={language === '简体中文' ? 'segmented__option is-active' : 'segmented__option'}
                  type="button"
                  aria-pressed={language === '简体中文'}
                >
                  {language}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      {activeTab === 'monitor' && (
        <>
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
      <div className="settings-actions"><button className="button button--primary" type="submit" disabled={props.saving}>{props.saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}保存配置</button><button className="button button--secondary" type="button" onClick={() => void props.onInstall()} disabled={props.saving}><CirclePlay size={17} />安装 Watchdog</button><button className="button button--secondary" type="button" onClick={() => void props.onToggleStartup()} disabled={props.saving}><Power size={17} />{props.startupInstalled ? '移除启动项' : '安装启动项'}</button><button className={`button ${props.running ? 'button--stop' : 'button--start'}`} type="button" onClick={() => void props.onToggle()} disabled={props.saving}>{props.running ? <Power size={17} /> : <CirclePlay size={17} />}{props.running ? '停止 Watchdog' : '启动 Watchdog'}</button><button className="button button--danger" type="button" onClick={() => void props.onUninstall()} disabled={props.saving}><Trash2 size={17} />卸载 Watchdog</button></div>
        </>
      )}
      {activeTab === 'about' && (
        <section className="settings-section settings-section--wide">
          <div className="section-title"><div><span className="eyebrow">About</span><h2>关于</h2></div><CircleAlert size={20} /></div>
          <p className="section-hint">查看版本信息与更新状态。</p>
          <div className="about-card">
            <img src={brandIcon} alt="" width={44} height={44} />
            <div className="about-card__id">
              <strong>Selbstlauf</strong>
              <span className="state-chip state-chip--ready"><span className="state-chip__dot" />版本 0.1.0</span>
            </div>
          </div>
        </section>
      )}
      {activeTab === 'about' && (
        <EnvironmentPanel
          environment={props.environment}
          refreshing={props.environmentRefreshing}
          upgrading={props.environmentUpgrading}
          onRefresh={props.onRefreshEnvironment}
          onUpgrade={props.onUpgradeTool}
          onUpgradeAll={props.onUpgradeAllTools}
        />
      )}
    </form>
  );
}

export interface AppProps { api?: WatchdogApi }

export default function App({ api: suppliedApi }: AppProps) {
  const api = useMemo(() => suppliedApi ?? createApi(), [suppliedApi]);
  const staticDemo = import.meta.env.VITE_STATIC_DEMO === 'true';
  const [page, setPage] = useState<Page>('overview');
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
  const [sessions, setSessions] = useState<SessionView[]>(fallbackSessions);
  const [events, setEvents] = useState<AuditEvent[]>(fallbackEvents);
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
  }, [palette, theme]);

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
      const [nextHealth, nextConfig, nextSessions, nextStartup, nextHookStatus, nextCodexProfiles, nextEnvironment] = await Promise.all([
        api.health(),
        api.config(),
        api.sessions(),
        api.startup(),
        api.claudeHook(),
        api.codexProfiles(),
        api.environment(),
      ]);
      setHealth(nextHealth);
      setConfig(nextConfig);
      setSessions(nextSessions);
      setStartupInstalled(nextStartup.installed);
      setHookStatus(nextHookStatus);
      setCodexProfiles(nextCodexProfiles);
      setEnvironment(nextEnvironment);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  };

  useEffect(() => {
    if (staticDemo && suppliedApi === undefined) return undefined;
    void refresh();
    const unsubscribe = api.subscribe((event: WatchdogEvent) => {
      if (event.kind === 'audit') setEvents((current) => [event.event, ...current].slice(0, 100));
      else void refresh();
    });
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { unsubscribe(); window.clearInterval(timer); };
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
      setPaletteOverrides((current) => ({ ...current, [theme]: parsed }));
      setNotice('主题已导入');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入失败');
    }
  };

  const copyTheme = async () => {
    await navigator.clipboard.writeText(JSON.stringify(palette, null, 2));
    setNotice('主题已复制');
  };

  const saveConfig = async (nextConfig: WatchdogConfig) => {
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
      <button className={`mobile-overlay ${sidebarOpen ? 'is-open' : ''}`} type="button" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)} />
      <aside id="watchdog-sidebar" className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="brand"><span className="brand__mark" data-testid="brand-mark"><img src={brandIcon} alt="" width={34} height={34} /></span><div><strong>Selbstlauf</strong><span>continuation watchdog</span></div><button className="sidebar-close icon-button" type="button" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <nav aria-label="主导航">{nav.map((item) => <button key={item.id} className={`nav-button ${page === item.id ? 'is-active' : ''}`} type="button" aria-current={page === item.id ? 'page' : undefined} title={sidebarCompact ? item.label : undefined} onClick={() => { setPage(item.id); setSidebarOpen(false); }}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
        <div className="sidebar__footer"><div className="service-mini"><span className={`status-light ${connected ? 'is-online' : ''}`} /><div><strong>{connected ? '服务在线' : '离线预览'}</strong><span>{sessions.length} 个进程</span></div></div><button className="nav-button" type="button" title={theme === 'dark' ? '切换亮色' : '切换暗色'} onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}<span>{theme === 'dark' ? '亮色' : '暗色'}</span></button><button className="compact-toggle icon-button" type="button" title={sidebarCompact ? '展开侧栏' : '收起侧栏'} aria-label={sidebarCompact ? '展开侧栏' : '收起侧栏'} onClick={() => setSidebarCompact(!sidebarCompact)}>{sidebarCompact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button></div>
      </aside>

      <main className="workspace">
        <header className="topbar"><div className="topbar__title"><button className="mobile-menu icon-button" type="button" aria-label="打开菜单" aria-controls="watchdog-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div><span className="eyebrow">Local control</span><h1>{page === 'overview' ? '进程监控' : page === 'timeline' ? '事件记录' : 'Watchdog 设置'}</h1></div></div><div className="topbar__actions"><span className="poll-age" aria-label="Last watchdog poll"><Activity size={14} />轮询 {health.lastPollAtMs === null ? '--' : duration(Math.max(0, Date.now() - health.lastPollAtMs))} 前</span>{config.dryRun && <span className="mode-badge"><ShieldAlert size={15} />DRY RUN</span>}<button className="icon-button" type="button" title="刷新" aria-label="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></button>{health.running ? <button className="button button--stop" type="button" onClick={() => void emergencyStop()} disabled={saving}><Power size={16} />紧急停止</button> : <button className="button button--start" type="button" onClick={() => void startWatchdog()} disabled={saving}><CirclePlay size={16} />启动 Watchdog</button>}</div></header>

        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="关闭通知" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        {page === 'overview' && <div className="page-content">
          <section className="metric-strip" aria-label="运行概览"><div><span>发现进程</span><strong>{sessions.length}</strong></div><div><span>可写入</span><strong>{ready}</strong></div><div><span>Codex Goal</span><strong>{goalCount}</strong></div><div><span>服务状态</span><strong className={health.running ? 'text-ready' : 'text-warn'}>{health.running ? '运行中' : connected ? '已停止' : '离线'}</strong></div></section>
          <section className="content-section"><div className="section-heading"><div><span className="eyebrow">Sessions</span><h2>独立进程</h2></div><span className="section-meta"><span className={`status-light ${connected ? 'is-online' : ''}`} />{connected ? '实时同步' : '样例数据'}</span></div><ProcessTable sessions={sessions} config={config} busy={busy} onPause={(session) => void mutateSession(session, 'pause')} onInject={(session) => void mutateSession(session, 'inject')} onFocus={(session) => void focusSession(session)} /></section>
          <section className="content-section compact-events"><div className="section-heading"><div><span className="eyebrow">Recent</span><h2>最近事件</h2></div><button className="text-button" type="button" onClick={() => setPage('timeline')}>查看全部</button></div><Timeline events={events.slice(0, 5)} /></section>
        </div>}

        {page === 'timeline' && <div className="page-content"><section className="content-section"><div className="section-heading"><div><span className="eyebrow">Audit</span><h2>决策与写入</h2></div><span className="section-meta">{events.length} 条</span></div><Timeline events={events} /></section></div>}
        {page === 'settings' && <div className="page-content"><SettingsPanel config={config} theme={themePreference} activeTheme={theme} palette={palette} palettes={palettes} customized={paletteCustomized} onThemeChange={setThemePreference} onPaletteChange={changePalette} onPaletteReset={resetPalette} onImportTheme={importTheme} onCopyTheme={copyTheme} environment={environment} environmentRefreshing={environmentRefreshing} onRefreshEnvironment={refreshEnvironment} environmentUpgrading={environmentUpgrading} onUpgradeTool={upgradeTool} onUpgradeAllTools={upgradeAllTools} hookStatus={hookStatus} profiles={codexProfiles} applyingProfile={applyingProfile} onApplyProfile={applyCodexProfile} saving={saving} running={health.running} onSave={saveConfig} onToggle={toggleWatchdog} onInstall={install} startupInstalled={startupInstalled} onToggleStartup={toggleStartup} onInstallClaudeHook={() => updateClaudeHook('install')} onUninstallClaudeHook={() => updateClaudeHook('uninstall')} onDisableClaudeHook={() => updateClaudeHook('disable')} onUninstall={uninstall} /></div>}
      </main>
    </div>
  );
}
