import { useEffect, useState } from 'react';
import { CirclePlay, RefreshCw, Square, X } from 'lucide-react';
import type { AgentApi, AgentSession } from '../api/agents';
import { ToolIcon } from '../sidebar/ToolIcon';
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
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (props.demo) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await props.api.list();
        if (active) { setSessions(next); setError(null); setLoaded(true); }
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setLoaded(true); }
      } finally { pending = false; }
    };
    void refresh();
    const unsubscribe = props.api.subscribeSessions(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; unsubscribe(); window.clearInterval(timer); };
  }, [props.api, props.demo]);

  const selected = sessions.find((session) => session.id === props.selectedId) ?? sessions[0] ?? null;

  const action = async (session: AgentSession, remove: boolean) => {
    setBusy(session.id);
    setError(null);
    try {
      if (remove) await props.api.remove(session.id);
      else await props.api.terminate(session.id);
      setSessions(await props.api.list());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  if (props.demo) return <div className="empty-state">智能体窗口需要本地服务或桌面版。在线演示不会启动进程。</div>;

  return (
    <section className="agent-windows" aria-label="智能体窗口">
      {error && <p className="agent-error" role="alert">{error}</p>}
      <div className="agent-windows__tabs" role="tablist" aria-label="已启动的智能体">
        {sessions.map((session) => (
          <button key={session.id} id={`tab-${session.id}`} type="button" role="tab" aria-selected={selected?.id === session.id}
            aria-controls={`panel-${session.id}`} className="agent-window-tab" onClick={() => props.onSelect(session.id)}>
            <ToolIcon tool={session.tool} size={16} /><span>{session.title}</span><span className={`agent-dot agent-dot--${session.status}`} aria-hidden="true" />
          </button>
        ))}
        <button className="button button--ghost" type="button" onClick={props.onLaunch}><CirclePlay size={16} />新建窗口</button>
      </div>
      {selected === null ? <div className="empty-state"><p>{loaded ? '还没有智能体窗口' : '正在读取窗口…'}</p><p className="subtle">选择 Claude、OpenCode 或其他智能体即可启动。</p></div> : (
        <section className="agent-window" role="tabpanel" id={`panel-${selected.id}`} aria-labelledby={`tab-${selected.id}`}>
          <header className="agent-window__header">
            <div><strong>{selected.title}</strong><span className="subtle">PID {selected.pid} · {agentStatus(selected)}</span></div>
            <button className="button button--secondary" type="button" disabled={busy === selected.id || selected.status === 'stopping'}
              onClick={() => void action(selected, selected.status === 'exited')}>
              {busy === selected.id ? <RefreshCw size={15} className="spin" /> : selected.status === 'exited' ? <X size={15} /> : <Square size={15} />}
              {selected.status === 'exited' ? '关闭窗口' : '结束进程'}
            </button>
          </header>
          <dl className="agent-window__metadata"><div><dt>工作目录</dt><dd>{selected.cwd}</dd></div><div><dt>启动命令</dt><dd>{selected.command}{selected.args.length > 0 ? ` ${selected.args.join(' ')}` : ''}</dd></div></dl>
        </section>
      )}
    </section>
  );
}
