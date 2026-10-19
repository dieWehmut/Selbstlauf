import { useEffect, useState } from 'react';
import { CirclePlay, RefreshCw, Square, SquareArrowOutUpRight, X } from 'lucide-react';
import type { AgentApi, AgentSession } from '../api/agents';
import { ToolIcon } from '../sidebar/ToolIcon';
import { AgentTerminal } from './AgentTerminal';
import './agents.css';

export function agentStatus(session: AgentSession): string {
  return session.status === 'running' ? '运行中' : session.status === 'stopping' ? '正在退出' : `已结束 · 退出码 ${session.exitCode ?? '未知'}`;
}

export function AgentWindows(props: {
  api: AgentApi;
  demo?: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onLaunch: () => void;
  onOpenWindow?: (session: AgentSession) => void;
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (props.demo) return;
    let active = true;
    let pending = false;
    let refreshAgain = false;
    const refresh = async () => {
      if (pending) { refreshAgain = true; return; }
      pending = true;
      refreshAgain = false;
      try {
        const next = await props.api.list();
        if (active) { setSessions(next); setError(null); setLoaded(true); }
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setLoaded(true); }
      } finally { pending = false; if (active && refreshAgain) void refresh(); }
    };
    void refresh();
    const unsubscribe = props.api.subscribeSessions(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; unsubscribe(); window.clearInterval(timer); };
  }, [props.api, props.demo]);

  const selected = props.selectedId === null ? sessions[0] ?? null : sessions.find((session) => session.id === props.selectedId) ?? null;

  const action = async (session: AgentSession, remove: boolean) => {
    setBusy(session.id);
    setError(null);
    try {
      if (remove) await props.api.remove(session.id);
      else await props.api.terminate(session.id);
      const next = await props.api.list();
      setSessions(next);
      if (remove) { sessionStorage.removeItem(`selbstlauf-agent-draft:${session.id}`); props.onSelect(next[0]?.id ?? null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  if (props.demo) return <div className="empty-state">智能体窗口需要本地服务或桌面版。在线演示不会启动进程。</div>;

  return (
    <section className="agent-windows" aria-label="智能体窗口">
      {error && <p className="agent-error" role="alert">{error}</p>}
      <div className="agent-windows__tabbar"><div className="agent-windows__tabs" role="tablist" aria-label="已启动的智能体">
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
      </div><button className="button button--ghost" type="button" onClick={props.onLaunch}><CirclePlay size={16} />新建窗口</button></div>
      {selected === null && <div className="empty-state"><p>{loaded ? sessions.length === 0 ? '还没有智能体窗口' : '所选窗口不存在或已被关闭，请选择其他窗口。' : '正在读取窗口…'}</p><p className="subtle">选择 Claude、OpenCode 或其他智能体即可启动。</p></div>}
      {sessions.map((session) => (
        <section key={session.id} className="agent-window" role="tabpanel" hidden={selected?.id !== session.id} id={`panel-${session.id}`} aria-labelledby={`tab-${session.id}`}>
          <header className="agent-window__header">
            <div><strong>{session.title}</strong><span className="subtle">PID {session.pid} · {agentStatus(session)}</span></div>
            <div className="agent-window__actions">
              {props.onOpenWindow && <button className="button button--ghost" type="button" onClick={() => props.onOpenWindow?.(session)}><SquareArrowOutUpRight size={15} />独立窗口</button>}
              <button className="button button--secondary" type="button" disabled={busy === session.id || session.status === 'stopping'}
                onClick={() => void action(session, session.status === 'exited')}>
                {busy === session.id ? <RefreshCw size={15} className="spin" /> : session.status === 'exited' ? <X size={15} /> : <Square size={15} />}
                {session.status === 'exited' ? '关闭窗口' : '结束进程'}
              </button>
            </div>
          </header>
          <dl className="agent-window__metadata"><div><dt>工作目录</dt><dd>{session.cwd}</dd></div><div><dt>启动命令</dt><dd>{session.command}{session.args.length > 0 ? ` ${session.args.join(' ')}` : ''}</dd></div></dl>
          <AgentTerminal api={props.api} session={session} visible={selected?.id === session.id}
            onSession={(updated) => setSessions((current) => current.map((entry) => entry.id === updated.id ? updated : entry))} />
        </section>
      ))}
    </section>
  );
}
