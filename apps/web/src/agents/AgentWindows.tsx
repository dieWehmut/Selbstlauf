import { useI18n, translate, type Locale } from '../i18n';
import { componentError } from '../i18n/component-errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CirclePlay, RefreshCw, Square, SquareArrowOutUpRight, X } from 'lucide-react';
import type { AgentApi, AgentSession } from '../api/agents';
import { ToolIcon } from '../sidebar/ToolIcon';
import { AgentTerminal } from './AgentTerminal';
import { storeString } from './browser-storage';
import './agents.css';

export function agentStatus(session: AgentSession, locale?: Locale): string {
  return session.status === 'running' ? translate('运行中', {}, locale) : session.status === 'stopping' ? translate('正在退出', {}, locale) : translate('已结束 · 退出码 {code}', { code: session.exitCode ?? translate('未知', {}, locale) }, locale);
}

interface AgentListScope {
  readonly api: AgentApi;
  active: boolean;
  revision: number;
  readonly actions: Set<string>;
  refresh(): Promise<void>;
}

export function AgentWindows(props: {
  api: AgentApi;
  demo?: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onLaunch: () => void;
  onOpenWindow?: (session: AgentSession) => void;
}) {
  const { t, locale } = useI18n();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const currentSessions = useRef(sessions);
  const scopeRef = useRef<AgentListScope | null>(null);
  const selection = useRef({ id: props.selectedId, onSelect: props.onSelect });
  selection.current = { id: props.selectedId, onSelect: props.onSelect };
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const applySessions = useCallback((next: AgentSession[]) => {
    currentSessions.current = next;
    setSessions(next);
  }, []);

  useEffect(() => {
    if (props.demo) return;
    let pending = false;
    let refreshAgain = false;
    const scope: AgentListScope = {
      api: props.api, active: true, revision: 0, actions: new Set(),
      refresh: async () => {
        if (!scope.active) return;
        if (pending) { refreshAgain = true; return; }
        pending = true;
        refreshAgain = false;
        const revision = scope.revision;
        try {
          const next = await scope.api.list();
          if (scope.active && revision === scope.revision) {
            applySessions(next); setRefreshError(null); setLoaded(true);
          }
        } catch (cause) {
          if (scope.active && revision === scope.revision) {
            setRefreshError(cause instanceof Error ? cause.message : String(cause)); setLoaded(true);
          }
        } finally { pending = false; if (scope.active && refreshAgain) void scope.refresh(); }
      },
    };
    scopeRef.current = scope;
    applySessions([]); setLoaded(false); setError(null); setRefreshError(null); setBusy(new Set());
    void scope.refresh();
    const unsubscribe = scope.api.subscribeSessions(() => { scope.revision += 1; void scope.refresh(); });
    const timer = window.setInterval(() => void scope.refresh(), 5000);
    return () => { scope.active = false; scopeRef.current = null; unsubscribe(); window.clearInterval(timer); };
  }, [props.api, props.demo, applySessions]);

  const selected = props.selectedId === null ? sessions[0] ?? null : sessions.find((session) => session.id === props.selectedId) ?? null;

  const action = async (session: AgentSession, remove: boolean) => {
    const scope = scopeRef.current;
    if (!scope?.active || scope.api !== props.api || scope.actions.has(session.id)) return;
    scope.actions.add(session.id);
    setBusy(new Set(scope.actions));
    setError(null);
    try {
      if (remove) await scope.api.remove(session.id);
      else await scope.api.terminate(session.id);
      if (!scope.active) return;
      // Acknowledged mutations invalidate every list requested before their result was known.
      scope.revision += 1;
      if (remove) {
        const current = currentSessions.current;
        const wasSelected = (selection.current.id ?? current[0]?.id) === session.id;
        const next = current.filter((entry) => entry.id !== session.id);
        applySessions(next);
        storeString('sessionStorage', `selbstlauf-agent-draft:${session.id}`, null);
        if (wasSelected) selection.current.onSelect(next[0]?.id ?? null);
      }
      void scope.refresh();
    } catch (cause) {
      if (scope.active) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      scope.actions.delete(session.id);
      if (scope.active) setBusy(new Set(scope.actions));
    }
  };

  const updateSession = (updated: AgentSession) => {
    const scope = scopeRef.current;
    if (!scope?.active || scope.api !== props.api) return;
    const current = currentSessions.current;
    const previous = current.find((entry) => entry.id === updated.id);
    if (previous === undefined) return;
    applySessions(current.map((entry) => entry.id === updated.id ? updated : entry));
    if (previous.status !== updated.status || previous.cols !== updated.cols || previous.rows !== updated.rows) {
      scope.revision += 1;
      void scope.refresh();
    }
  };

  if (props.demo) return <div className="empty-state">{t("智能体窗口需要本地服务或桌面版。在线演示不会启动进程。")}</div>;

  const displayedError = error ?? refreshError;
  return (
    <section className="agent-windows" aria-label={t("智能体窗口")}>
      {displayedError && <p className="agent-error" role="alert">{componentError(displayedError, locale)}</p>}
      <div className="agent-windows__tabbar"><div className="agent-windows__tabs" role="tablist" aria-label={t("已启动的智能体")}>
        {sessions.map((session) => (
          <button key={session.id} id={`tab-${session.id}`} type="button" role="tab" aria-selected={selected?.id === session.id}
            aria-controls={`panel-${session.id}`} tabIndex={selected?.id === session.id || (selected === null && sessions[0]?.id === session.id) ? 0 : -1}
            className="agent-window-tab" onClick={() => props.onSelect(session.id)} onKeyDown={(event) => {
              const index = sessions.findIndex((entry) => entry.id === session.id);
              const next = event.key === 'ArrowRight' ? (index + 1) % sessions.length : event.key === 'ArrowLeft' ? (index - 1 + sessions.length) % sessions.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); props.onSelect(sessions[next].id); document.getElementById(`tab-${sessions[next].id}`)?.focus();
            }}>
            <ToolIcon tool={session.tool} size={16} /><span>{session.title}</span><span className={`agent-dot agent-dot--${session.status}`} aria-hidden="true" />
          </button>
        ))}
      </div><button className="button button--ghost" type="button" onClick={props.onLaunch}><CirclePlay size={16} />{t("新建窗口")}</button></div>
      {selected === null && <div className="empty-state"><p>{loaded ? sessions.length === 0 ? t("还没有智能体窗口") : t("所选窗口不存在或已被关闭，请选择其他窗口。") : t("正在读取窗口…")}</p><p className="subtle">{t("选择 Claude、OpenCode 或其他智能体即可启动。")}</p></div>}
      {sessions.map((session) => (
        <section key={session.id} className="agent-window" role="tabpanel" hidden={selected?.id !== session.id} id={`panel-${session.id}`} aria-labelledby={`tab-${session.id}`}>
          <header className="agent-window__header">
            <div><strong>{session.title}</strong><span className="subtle">PID {session.pid} · {agentStatus(session, locale)}</span></div>
            <div className="agent-window__actions">
              {props.onOpenWindow && <button className="button button--ghost" type="button" onClick={() => props.onOpenWindow?.(session)}><SquareArrowOutUpRight size={15} />{t("独立窗口")}</button>}
              <button className="button button--secondary" type="button" disabled={busy.has(session.id)}
                onClick={() => void action(session, session.status === 'exited')}>
                {busy.has(session.id) ? <RefreshCw size={15} className="spin" /> : session.status === 'exited' ? <X size={15} /> : <Square size={15} />}
                {session.status === 'exited' ? t("关闭窗口") : t("结束进程")}
              </button>
            </div>
          </header>
          <dl className="agent-window__metadata"><div><dt>{t("工作目录")}</dt><dd>{session.cwd}</dd></div><div><dt>{t("启动命令")}</dt><dd>{session.command}{session.args.length > 0 ? ` ${session.args.join(' ')}` : ''}</dd></div></dl>
          <AgentTerminal api={props.api} session={session} visible={selected?.id === session.id}
            onSession={updateSession} />
        </section>
      ))}
    </section>
  );
}
