import {
  Activity,
  Bot,
  CirclePause,
  CirclePlay,
  Gauge,
  LayoutDashboard,
  ListTree,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  RefreshCw,
  Save,
  Send,
  Settings2,
  ShieldAlert,
  Sun,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  createApi,
  type AuditEvent,
  type HealthView,
  type SessionView,
  type WatchdogApi,
  type WatchdogConfig,
} from './api/client';

type Page = 'overview' | 'timeline' | 'settings';
type Theme = 'light' | 'dark';

const fallbackConfig: WatchdogConfig = {
  enabled: true,
  dryRun: true,
  pollIntervalMs: 2_000,
  defaultIdleTimeoutMs: 120_000,
  defaultCooldownMs: 300_000,
  maxAttemptsPerQuietPeriod: 1,
  tools: {
    claude: { enabled: true, normalPrompt: '继续' },
    codex: {
      enabled: true,
      normalPrompt: '继续',
      goalPrompt: '/goal resume',
      goalStatuses: ['active', 'paused'],
    },
  },
  processFilters: { sameUserOnly: true, include: [], exclude: [] },
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
];

const fallbackEvents: AuditEvent[] = [
  { id: 'sample-1', timestampMs: now - 18_000, type: 'activity', sessionId: 'claude:214052', tool: 'claude' },
  { id: 'sample-2', timestampMs: now - 74_000, type: 'decision', sessionId: 'codex:336756', tool: 'codex', details: { decision: 'awaiting-quiet-period' } },
  { id: 'sample-3', timestampMs: now - 132_000, type: 'skip', sessionId: 'codex:333616', tool: 'codex', details: { reason: 'monitor-only' } },
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
      {tool === 'codex' ? <Terminal size={16} /> : <Bot size={16} />}
    </span>
  );
}

interface SessionActionsProps {
  session: SessionView;
  busy: string | null;
  onPause: (session: SessionView) => void;
  onInject: (session: SessionView) => void;
}

function SessionActions({ session, busy, onPause, onInject }: SessionActionsProps) {
  const waiting = busy === session.id;
  return (
    <div className="row-actions">
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

function ProcessTable(props: {
  sessions: SessionView[];
  config: WatchdogConfig;
  busy: string | null;
  onPause: (session: SessionView) => void;
  onInject: (session: SessionView) => void;
}) {
  return (
    <>
      <div className="process-table-wrap">
        <table className="process-table">
          <thead>
            <tr><th>进程</th><th>能力</th><th>对话</th><th>静默</th><th>下一输入</th><th><span className="sr-only">操作</span></th></tr>
          </thead>
          <tbody>
            {props.sessions.map((session) => (
              <tr key={session.id} className={!session.alive ? 'is-muted' : undefined}>
                <td>
                  <div className="process-id"><ToolMark tool={session.tool} /><div><strong>{session.tool === 'codex' ? 'Codex' : 'Claude'}</strong><span>PID {session.rootPid}{session.childPids.length > 0 ? ` + ${session.childPids.length}` : ''}</span></div></div>
                </td>
                <td><CapabilityBadge session={session} /></td>
                <td><strong className="conversation">{session.goal ? `Goal · ${session.goal.status}` : '普通对话'}</strong><span className="subtle">{session.conversationId ?? '未关联'}</span></td>
                <td><strong>{duration(session.quietForMs ?? (session.lastActivityAtMs ? Date.now() - session.lastActivityAtMs : null))}</strong><DecisionChip decision={session.lastDecision} /></td>
                <td><code className="prompt-code">{nextPrompt(session, props.config)}</code></td>
                <td><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="session-cards">
        {props.sessions.map((session) => (
          <article className="session-card" key={session.id}>
            <header><div className="process-id"><ToolMark tool={session.tool} /><div><strong>{session.tool === 'codex' ? 'Codex' : 'Claude'}</strong><span>PID {session.rootPid}</span></div></div><CapabilityBadge session={session} /></header>
            <dl>
              <div><dt>对话</dt><dd>{session.goal ? `Goal · ${session.goal.status}` : '普通对话'}</dd></div>
              <div><dt>静默</dt><dd>{duration(session.quietForMs ?? 0)}</dd></div>
              <div className="session-card__prompt"><dt>下一输入</dt><dd><code>{nextPrompt(session, props.config)}</code></dd></div>
            </dl>
            <footer><DecisionChip decision={session.lastDecision} /><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} /></footer>
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

function SettingsPanel(props: {
  config: WatchdogConfig;
  saving: boolean;
  running: boolean;
  onSave: (config: WatchdogConfig) => Promise<void>;
  onToggle: () => Promise<void>;
  onUninstall: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => structuredClone(props.config));
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
        </div>
        <div className="switch-row"><div><strong>Dry run</strong><span>只记录决策，不写入进程</span></div><label className="switch"><input aria-label="Dry run" type="checkbox" checked={draft.dryRun} onChange={(event) => setDraft({ ...draft, dryRun: event.target.checked })} /><span /></label></div>
      </section>
      <section className="settings-section settings-section--wide">
        <div className="section-title"><div><span className="eyebrow">Processes</span><h2>进程范围</h2></div><ShieldAlert size={20} /></div>
        <div className="field-grid">
          <label><span>包含匹配</span><input aria-label="包含匹配" placeholder="例如 Nexus, study-os" value={includeFilters} onChange={(event) => setIncludeFilters(event.target.value)} /></label>
          <label><span>排除匹配</span><input aria-label="排除匹配" placeholder="例如 node_modules" value={excludeFilters} onChange={(event) => setExcludeFilters(event.target.value)} /></label>
        </div>
        <div className="switch-row"><div><strong>仅监控当前用户进程</strong><span>关闭后会发现其他用户进程，但仍只对安全关联且可验证的会话写入</span></div><label className="switch"><input aria-label="仅监控当前用户进程" type="checkbox" checked={draft.processFilters.sameUserOnly} onChange={(event) => setDraft({ ...draft, processFilters: { ...draft.processFilters, sameUserOnly: event.target.checked } })} /><span /></label></div>
      </section>
      <div className="settings-actions"><button className="button button--primary" type="submit" disabled={props.saving}>{props.saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}保存配置</button><button className={`button ${props.running ? 'button--stop' : 'button--start'}`} type="button" onClick={() => void props.onToggle()} disabled={props.saving}>{props.running ? <Power size={17} /> : <CirclePlay size={17} />}{props.running ? '停止 Watchdog' : '启动 Watchdog'}</button><button className="button button--danger" type="button" onClick={() => void props.onUninstall()} disabled={props.saving}><Trash2 size={17} />卸载 Watchdog</button></div>
    </form>
  );
}

export interface AppProps { api?: WatchdogApi }

export default function App({ api: suppliedApi }: AppProps) {
  const api = useMemo(() => suppliedApi ?? createApi(), [suppliedApi]);
  const staticDemo = import.meta.env.VITE_STATIC_DEMO === 'true';
  const [page, setPage] = useState<Page>('overview');
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('watchdog-theme') as Theme) || 'dark');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [health, setHealth] = useState<HealthView>({ ok: false, running: false, dryRun: true, lastPollAtMs: null });
  const [config, setConfig] = useState(fallbackConfig);
  const [sessions, setSessions] = useState<SessionView[]>(fallbackSessions);
  const [events, setEvents] = useState<AuditEvent[]>(fallbackEvents);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('watchdog-theme', theme);
  }, [theme]);

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
      const [nextHealth, nextConfig, nextSessions] = await Promise.all([api.health(), api.config(), api.sessions()]);
      setHealth(nextHealth); setConfig(nextConfig); setSessions(nextSessions); setConnected(true);
    } catch {
      setConnected(false);
    }
  };

  useEffect(() => {
    if (staticDemo && suppliedApi === undefined) return undefined;
    void refresh();
    const unsubscribe = api.subscribe((event) => setEvents((current) => [event, ...current].slice(0, 100)));
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

  const saveConfig = async (nextConfig: WatchdogConfig) => {
    setSaving(true); setNotice(null);
    try { setConfig(await api.updateConfig(nextConfig)); setNotice('配置已保存'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };

  const uninstall = async () => {
    if (!window.confirm('停止并卸载 Continuation Watchdog？')) return;
    setSaving(true);
    try { await api.uninstall(); setHealth({ ok: false, running: false, dryRun: config.dryRun, lastPollAtMs: null }); setNotice('卸载已启动'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '卸载失败'); }
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
        <div className="brand"><span className="brand__mark"><Activity size={20} /></span><div><strong>Selbstlauf</strong><span>continuation watchdog</span></div><button className="sidebar-close icon-button" type="button" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <nav aria-label="主导航">{nav.map((item) => <button key={item.id} className={`nav-button ${page === item.id ? 'is-active' : ''}`} type="button" aria-current={page === item.id ? 'page' : undefined} title={sidebarCompact ? item.label : undefined} onClick={() => { setPage(item.id); setSidebarOpen(false); }}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
        <div className="sidebar__footer"><div className="service-mini"><span className={`status-light ${connected ? 'is-online' : ''}`} /><div><strong>{connected ? '服务在线' : '离线预览'}</strong><span>{sessions.length} 个进程</span></div></div><button className="nav-button" type="button" title={theme === 'dark' ? '切换亮色' : '切换暗色'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}<span>{theme === 'dark' ? '亮色' : '暗色'}</span></button><button className="compact-toggle icon-button" type="button" title={sidebarCompact ? '展开侧栏' : '收起侧栏'} aria-label={sidebarCompact ? '展开侧栏' : '收起侧栏'} onClick={() => setSidebarCompact(!sidebarCompact)}>{sidebarCompact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button></div>
      </aside>

      <main className="workspace">
        <header className="topbar"><div className="topbar__title"><button className="mobile-menu icon-button" type="button" aria-label="打开菜单" aria-controls="watchdog-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div><span className="eyebrow">Local control</span><h1>{page === 'overview' ? '进程监控' : page === 'timeline' ? '事件记录' : 'Watchdog 设置'}</h1></div></div><div className="topbar__actions"><span className="poll-age" aria-label="Last watchdog poll"><Activity size={14} />轮询 {health.lastPollAtMs === null ? '--' : duration(Math.max(0, Date.now() - health.lastPollAtMs))} 前</span>{config.dryRun && <span className="mode-badge"><ShieldAlert size={15} />DRY RUN</span>}<button className="icon-button" type="button" title="刷新" aria-label="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></button>{health.running ? <button className="button button--stop" type="button" onClick={() => void emergencyStop()} disabled={saving}><Power size={16} />紧急停止</button> : <button className="button button--start" type="button" onClick={() => void startWatchdog()} disabled={saving}><CirclePlay size={16} />启动 Watchdog</button>}</div></header>

        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="关闭通知" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        {page === 'overview' && <div className="page-content">
          <section className="metric-strip" aria-label="运行概览"><div><span>发现进程</span><strong>{sessions.length}</strong></div><div><span>可写入</span><strong>{ready}</strong></div><div><span>Codex Goal</span><strong>{goalCount}</strong></div><div><span>服务状态</span><strong className={health.running ? 'text-ready' : 'text-warn'}>{health.running ? '运行中' : connected ? '已停止' : '离线'}</strong></div></section>
          <section className="content-section"><div className="section-heading"><div><span className="eyebrow">Sessions</span><h2>独立进程</h2></div><span className="section-meta"><span className={`status-light ${connected ? 'is-online' : ''}`} />{connected ? '实时同步' : '样例数据'}</span></div><ProcessTable sessions={sessions} config={config} busy={busy} onPause={(session) => void mutateSession(session, 'pause')} onInject={(session) => void mutateSession(session, 'inject')} /></section>
          <section className="content-section compact-events"><div className="section-heading"><div><span className="eyebrow">Recent</span><h2>最近事件</h2></div><button className="text-button" type="button" onClick={() => setPage('timeline')}>查看全部</button></div><Timeline events={events.slice(0, 5)} /></section>
        </div>}

        {page === 'timeline' && <div className="page-content"><section className="content-section"><div className="section-heading"><div><span className="eyebrow">Audit</span><h2>决策与写入</h2></div><span className="section-meta">{events.length} 条</span></div><Timeline events={events} /></section></div>}
        {page === 'settings' && <div className="page-content"><SettingsPanel config={config} saving={saving} running={health.running} onSave={saveConfig} onToggle={toggleWatchdog} onUninstall={uninstall} /></div>}
      </main>
    </div>
  );
}
