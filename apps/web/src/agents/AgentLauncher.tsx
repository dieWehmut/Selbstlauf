import { useEffect, useId, useRef, useState } from 'react';
import { CirclePlay, RefreshCw, X } from 'lucide-react';
import type { AgentApi, AgentCatalog, AgentSession, AgentTool } from '../api/agents';
import './agents.css';

export function AgentLauncher(props: {
  api: AgentApi;
  demo?: boolean;
  initialTool?: AgentTool;
  onClose: () => void;
  onLaunch: (session: AgentSession) => void;
  onInstall: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [tool, setTool] = useState<AgentTool>(props.initialTool ?? 'claude');
  const [cwd, setCwd] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (typeof element?.showModal === 'function') element.showModal();
    else element?.setAttribute('open', '');
    return () => { if (typeof element?.close === 'function') element.close(); };
  }, []);

  useEffect(() => {
    if (props.demo) return;
    let active = true;
    void props.api.catalog().then((value) => {
      if (!active) return;
      setCatalog(value);
      setCwd(value.defaultCwd);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : '无法连接本机智能体服务。');
    });
    return () => { active = false; };
  }, [props.api, props.demo]);

  const selected = catalog?.tools.find((entry) => entry.id === tool);
  const missing = selected?.available === false && command.trim().length === 0;
  const customMissing = tool === 'custom' && command.trim().length === 0;
  const disabled = busy || props.demo === true || catalog === null || missing || customMissing || cwd.trim().length === 0;

  const launch = async () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const session = await props.api.launch({
        tool, cwd: cwd.trim(),
        ...(command.trim().length === 0 ? {} : { command: command.trim() }),
        ...(args.length === 0 ? {} : { args: args.split(/\r?\n/u).filter((arg) => arg.length > 0) }),
        ...(title.trim().length === 0 ? {} : { title: title.trim() }),
      });
      props.onLaunch(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return (
    <dialog ref={dialog} className="agent-launcher" aria-labelledby={titleId} onCancel={(event) => {
      event.preventDefault();
      if (!busy) props.onClose();
    }}>
      <div className="agent-launcher__head">
        <h2 id={titleId}>启动智能体</h2>
        <button className="icon-button" type="button" aria-label="关闭启动面板" disabled={busy} onClick={props.onClose}><X size={18} /></button>
      </div>
      {props.demo ? <p className="agent-help">在线演示无法启动本机进程。请运行本地服务或桌面版后使用智能体窗口。</p> : (
        <form className="agent-launcher__form" onSubmit={(event) => { event.preventDefault(); void launch(); }}>
          <label>智能体
            <select value={tool} disabled={busy || catalog === null} onChange={(event) => { setTool(event.target.value as AgentTool); setCommand(''); setError(null); }}>
              {(catalog?.tools ?? [{ id: tool, label: '正在检测本机工具…', available: false }]).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}{entry.available ? '' : '（未找到）'}</option>
              ))}
            </select>
          </label>
          <label>工作目录
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="要让智能体工作的项目目录" maxLength={4096} disabled={busy} required />
          </label>
          <label>窗口名称（可选）<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={busy} placeholder={selected?.label ?? '智能体窗口'} /></label>
          <details className="agent-launcher__advanced" open={tool === 'custom' || missing ? true : undefined}>
            <summary>启动命令与参数</summary>
            <label>启动命令
              <input value={command} onChange={(event) => setCommand(event.target.value)} disabled={busy} maxLength={4096} placeholder={selected?.command ?? '可执行文件的完整路径，例如 /usr/local/bin/opencode'} />
            </label>
            <label>额外启动参数（每行一个）
              <textarea value={args} onChange={(event) => setArgs(event.target.value)} disabled={busy} maxLength={32768} rows={3} placeholder={'例如：\n--model\n模型名称'} />
            </label>
            <p className="agent-help">每行作为一个参数原样传入，包含空格也无需加引号。</p>
          </details>
          {missing && <div className="agent-help" role="status">
            没有在本机找到 {selected?.label}。可填写完整路径，或先到环境设置中安装。
            {selected?.installCommand && <code>{selected.installCommand}</code>}
            <button className="text-button" type="button" onClick={props.onInstall}>打开环境设置</button>
          </div>}
          {error && <p className="agent-error" role="alert">{error}</p>}
          <p className="agent-help">启动后，每个窗口连接自己的进程。工具的登录、模型选择和交互提示会显示在窗口中。</p>
          <button className="button button--primary" type="submit" disabled={disabled}>
            {busy ? <RefreshCw size={16} className="spin" /> : <CirclePlay size={16} />} {busy ? '正在启动…' : '启动'}
          </button>
        </form>
      )}
    </dialog>
  );
}
