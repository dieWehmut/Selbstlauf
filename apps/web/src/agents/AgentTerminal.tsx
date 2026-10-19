import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, RefreshCw, Send } from 'lucide-react';
import type { Terminal, ITheme } from '@xterm/xterm';
import type { AgentApi, AgentSession } from '../api/agents';
import { TerminalInputQueue } from './terminal-input';
import '@xterm/xterm/css/xterm.css';

function terminalTheme(): ITheme {
  const style = window.getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: color('--panel', '#10151b'), foreground: color('--text', '#e8edf2'),
    cursor: color('--accent', '#82cfa3'), selectionBackground: '#7f9ca455',
    black: '#20262e', red: '#e57474', green: '#84c596', yellow: '#d8b476',
    blue: '#79a9d6', magenta: '#be94da', cyan: '#78bcc0', white: '#cfd7df',
    brightBlack: '#77818b', brightRed: '#f29393', brightGreen: '#a4deaf', brightYellow: '#edcc96',
    brightBlue: '#9ac5e9', brightMagenta: '#d2b0e8', brightCyan: '#9fd4d6', brightWhite: '#f4f7fa',
  };
}

export function AgentTerminal(props: {
  api: AgentApi;
  session: AgentSession;
  visible?: boolean;
  onSession: (session: AgentSession) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const queue = useRef<TerminalInputQueue | null>(null);
  const callback = useRef(props.onSession);
  callback.current = props.onSession;
  const draftKey = `selbstlauf-agent-draft:${props.session.id}`;
  const [draft, setDraft] = useState(() => sessionStorage.getItem(draftKey) ?? '');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const changeDraft = (value: string) => {
    setDraft(value);
    if (value.length === 0) sessionStorage.removeItem(draftKey);
    else sessionStorage.setItem(draftKey, value);
  };

  useEffect(() => {
    let active = true;
    let dispose: () => void = () => undefined;
    setConnected(false);
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([xterm, addon]) => {
      if (!active || surface.current === null) return;
      const element = surface.current;
      const term = new xterm.Terminal({
        cols: props.session.cols, rows: props.session.rows, fontSize: 13, lineHeight: 1.2,
        fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace", cursorBlink: true,
        scrollback: 5000, screenReaderMode: true, disableStdin: true, theme: terminalTheme(),
      });
      const fit = new addon.FitAddon();
      term.loadAddon(fit);
      term.open(element);
      terminal.current = term;
      const input = new TerminalInputQueue((data) => props.api.input(props.session.id, data));
      queue.current = input;
      let canInput = false;
      let online = false;
      let cursor = 0;
      let status = props.session.status;
      let resizeTail = Promise.resolve();
      const report = (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); };
      const dataListener = term.onData((data) => {
        if (!canInput || status !== 'running') return;
        void input.send(data).catch(report);
      });
      term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.key.toLowerCase() === 'c' && term.hasSelection()));
      element.querySelector('textarea')?.setAttribute('aria-label', `${props.session.title} 终端输入`);
      const resize = term.onResize(({ cols, rows }) => {
        if (status !== 'running') return;
        resizeTail = resizeTail.then(async () => {
          if (!active || status !== 'running') return;
          try { await props.api.resize(props.session.id, cols, rows); } catch (cause) { report(cause); }
        });
      });
      const refit = () => { if (active && element.clientWidth > 0) fit.fit(); };
      const observer = new ResizeObserver(refit);
      observer.observe(element);
      const theme = new MutationObserver(() => { term.options.theme = terminalTheme(); });
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
      const unsubscribe = props.api.subscribeOutput(props.session.id, (output) => {
        if (!active) return;
        online = true;
        status = output.session.status;
        canInput = status === 'running';
        term.options.disableStdin = !canInput;
        callback.current(output.session);
        if (output.reset) { term.reset(); cursor = output.fromOffset; }
        const data = output.data.slice(Math.max(0, cursor - output.fromOffset));
        const afterWrite = () => {
          if (!active) return;
          canInput = online && status === 'running';
          term.options.disableStdin = !canInput;
          setConnected(online);
        };
        if (data.length > 0) term.write(data, afterWrite);
        else afterWrite();
        cursor = output.offset;
        element.dataset.outputOffset = String(cursor);
      }, (connection) => {
        if (!active) return;
        online = connection;
        // CLI startup can issue DSR/DA queries before rendering a prompt. Their replies use onData too.
        canInput = online && status === 'running';
        term.options.disableStdin = !canInput;
        setConnected(online);
        if (online) input.resetFailure();
      });
      refit();
      void document.fonts?.ready.then(refit);
      if (props.visible !== false) term.focus();
      dispose = () => {
        unsubscribe(); input.dispose(); dataListener.dispose(); resize.dispose(); observer.disconnect(); theme.disconnect();
        term.dispose(); terminal.current = null; queue.current = null;
      };
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; dispose(); };
  }, [props.api, props.session.id, generation]);

  const send = async () => {
    const term = terminal.current;
    const input = queue.current;
    if (!connected || props.session.status !== 'running' || term === null || input === null || busy || draft.trim().length === 0) return;
    setBusy(true);
    setError(null);
    input.resetFailure();
    try {
      // xterm applies the process's current bracketed-paste mode, preserving multiline prompts in TUIs.
      term.paste(draft);
      await input.send('\r');
      changeDraft('');
      term.focus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return (
    <div className="agent-terminal">
      <div className="agent-terminal__connection"><span>{connected ? '终端已连接' : '正在连接终端…'}</span>
        <button className="text-button" type="button" onClick={() => { setError(null); setGeneration((value) => value + 1); }}><RefreshCw size={13} />重新连接</button>
      </div>
      <div ref={surface} className="agent-terminal__surface" role="region" aria-label={`${props.session.title} 终端`} data-session-id={props.session.id} />
      {error && <p className="agent-error" role="alert">{error}</p>}
      <form className="agent-terminal__composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor={`prompt-${props.session.id}`}>发送到 {props.session.title} 的内容</label>
        <textarea id={`prompt-${props.session.id}`} value={draft} onChange={(event) => changeDraft(event.target.value)} maxLength={32768} rows={3}
          disabled={props.session.status !== 'running' || busy} placeholder="输入任务或多行内容，也可直接在上方终端操作" onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void send(); }
          }} />
        <button className="button button--primary" type="submit" disabled={!connected || busy || props.session.status !== 'running' || draft.trim().length === 0}>
          {busy ? <RefreshCw size={16} className="spin" /> : <Send size={16} />}发送
        </button>
      </form>
      <p className="agent-help"><CornerDownLeft size={12} /> Ctrl+Enter 发送。多行内容使用智能体的粘贴模式，方向键、Tab、Ctrl+C 可直接在终端使用。</p>
    </div>
  );
}
