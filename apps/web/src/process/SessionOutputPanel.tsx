import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import { validateSessionOutput, type SessionOutputView } from '../api/client';
import './session-output.css';

const REASONS: Record<string, string> = {
  'association-required': '尚未唯一关联到这一个进程的对话。关联成功后会显示真实输出。',
  'transcript-missing': '暂未找到该会话的记录。智能体写入会话记录后会自动显示。',
  'transcript-unreadable': '当前无法读取该会话的记录。',
  'transcript-invalid': '会话记录正在写入或暂时无法解析，请稍后刷新。',
  'projection-too-large': '该会话记录过大，请在智能体的原窗口中查看。',
  'projection-format-unsupported': '当前智能体版本未提供可读取的会话输出。',
};

export function SessionOutputPanel(props: {
  sessionId: string;
  requestOutput?: (id: string) => Promise<SessionOutputView>;
}) {
  const [output, setOutput] = useState<SessionOutputView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = useRef<() => void>(() => undefined);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    let active = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setOutput(null); setError(null); setPending(false); follow.current = true;
    const load = async () => {
      if (loading || !active || props.requestOutput === undefined) return;
      clearTimeout(timer);
      loading = true; setPending(true);
      try {
        const result = validateSessionOutput(await props.requestOutput(props.sessionId), props.sessionId);
        if (active) { setOutput(result); setError(null); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        loading = false;
        if (active) { setPending(false); timer = setTimeout(() => void load(), 3000); }
      }
    };
    refresh.current = () => void load();
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [props.sessionId, props.requestOutput]);

  useEffect(() => {
    if (follow.current && list.current !== null) list.current.scrollTop = list.current.scrollHeight;
  }, [output]);
  const current = output?.sessionId === props.sessionId ? output : null;

  return (
    <section className="session-output" aria-label="会话输出">
      <div className="session-output__head"><h3><Terminal size={15} />会话输出</h3>
        <span className="subtle">每 3 秒更新</span>
        <button className="text-button" type="button" disabled={pending || props.requestOutput === undefined} onClick={() => refresh.current()} aria-label="刷新会话输出"><RefreshCw size={14} />刷新</button>
      </div>
      {error && <p className="session-output__error">{error}</p>}
      {props.requestOutput === undefined ? <p className="subtle">连接本机服务后可查看会话输出。</p>
        : current?.state === 'unavailable' ? <p className="subtle">{REASONS[current.reason ?? ''] ?? '暂时无法读取该会话的输出。'}</p>
        : current === null ? <p className="subtle">正在读取会话输出…</p>
        : current.entries.length === 0 ? <p className="subtle">该会话尚无可显示的对话输出。</p>
        : <div className="session-output__entries" ref={list} role="log" aria-live="off" onScroll={() => {
          const element = list.current;
          if (element !== null) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}>
          {current.truncated && <p className="subtle">当前显示最近的输出。</p>}
          {current.entries.map((entry) => <article key={entry.id} className={`session-output__entry session-output__entry--${entry.role}`}>
            <header><strong>{entry.role === 'user' ? '你' : entry.role === 'assistant' ? '智能体' : '工具'}</strong>
              {entry.timestampMs !== null && <time>{new Date(entry.timestampMs).toLocaleTimeString('zh-CN')}</time>}
            </header><pre>{entry.text}</pre>
          </article>)}
        </div>}
    </section>
  );
}
