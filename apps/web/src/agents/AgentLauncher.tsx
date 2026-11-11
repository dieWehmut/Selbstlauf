import { useI18n } from '../i18n';
import { componentError } from '../i18n/component-errors';
import { useEffect, useId, useRef, useState } from 'react';
import { CirclePlay, ExternalLink, RefreshCw, X } from 'lucide-react';
import type { AgentApi, AgentCatalog, AgentSession, AgentTool } from '../api/agents';
import { ToolIcon } from '../sidebar/ToolIcon';
import './agents.css';

export function AgentLauncher(props: {
  api: AgentApi;
  demo?: boolean;
  initialTool?: AgentTool;
  onClose: () => void;
  onLaunch: (session: AgentSession) => void;
  onInstall: () => void;
}) {
  const { t, locale } = useI18n();
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
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refreshCatalog = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const value = await props.api.catalog();
      if (mounted.current) setCatalog(value);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current) setRefreshing(false); }
  };

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
  const guided = selected?.launchable === false || selected?.kind === 'desktop' || selected?.kind === 'extension';
  const missing = !guided && selected?.available === false && command.trim().length === 0;
  const customMissing = tool === 'custom' && command.trim().length === 0;
  const disabled = busy || refreshing || guided || props.demo === true || catalog === null || missing || customMissing || cwd.trim().length === 0;

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
        <h2 id={titleId}>{t("启动智能体")}</h2>
        <button className="icon-button" type="button" aria-label={t("关闭启动面板")} disabled={busy} onClick={props.onClose}><X size={18} /></button>
      </div>
      {props.demo ? <p className="agent-help">{t("在线演示无法启动本机进程。请运行本地服务或桌面版后使用智能体窗口。")}</p> : (
        <form className="agent-launcher__form" onSubmit={(event) => { event.preventDefault(); void launch(); }}>
          <label>{t("智能体")}<select aria-label={t("智能体")} value={tool} disabled={busy || catalog === null} onChange={(event) => { setTool(event.target.value as AgentTool); setCommand(''); setError(null); }}>
              {(catalog?.tools ?? [{ id: tool, label: '正在检测本机工具…', available: false, kind: undefined }]).map((entry) => (
                <option key={entry.id} value={entry.id}>{t(entry.label)}{entry.kind === 'desktop' ? t('（桌面应用）') : entry.kind === 'extension' ? t('（编辑器扩展）') : entry.available ? '' : t("（未找到）")}</option>
              ))}
            </select>
          </label>
          {selected && <div className="agent-launcher__tool" aria-live="polite">
            <ToolIcon tool={selected.id} size={28} />
            <strong>{selected.label}</strong>
            <button className="text-button" type="button" disabled={busy || refreshing} onClick={() => void refreshCatalog()} aria-label={t('重新检测本机工具')}>
              <RefreshCw size={14} className={refreshing ? 'spin' : undefined} />{t('重新检测')}
            </button>
          </div>}
          {guided && <p className="agent-help">{selected?.kind === 'extension'
            ? t('在编辑器中安装并打开此扩展，然后按接入指南配置模型。')
            : t('安装并打开此桌面应用，然后按接入指南配置模型。')}</p>}
          {!guided && <>
          <label>{t("工作目录")}<input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={t("要让智能体工作的项目目录")} maxLength={4096} disabled={busy} required />
          </label>
          <label>{t("窗口名称（可选）")}<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={busy} placeholder={t(selected?.label ?? '智能体窗口')} /></label>
          <details className="agent-launcher__advanced" open={tool === 'custom' || missing ? true : undefined}>
            <summary>{t("启动命令与参数")}</summary>
            <label>{t("启动命令")}<input value={command} onChange={(event) => setCommand(event.target.value)} disabled={busy} maxLength={4096} placeholder={selected?.command ?? t("可执行文件的完整路径，例如 /usr/local/bin/opencode")} />
            </label>
            <label>{t("额外启动参数（每行一个）")}<textarea value={args} onChange={(event) => setArgs(event.target.value)} disabled={busy} maxLength={32768} rows={3} placeholder={t("例如：\n--model\n模型名称")} />
            </label>
            <p className="agent-help">{t("每行作为一个参数原样传入，包含空格也无需加引号。")}</p>
            {(selected?.defaultArgs?.length ?? 0) > 0 && <p className="agent-help">{t('默认启动参数')} <code>{selected?.defaultArgs?.join(' ')}</code></p>}
          </details>
          {missing && <div className="agent-help" role="status">
            {t('没有在本机找到 {tool}。可填写完整路径，或先到环境设置中安装。', { tool: t(selected?.label ?? '智能体') })}{selected?.installCommand && <code>{selected.installCommand}</code>}
            <button className="text-button" type="button" onClick={props.onInstall}>{t("打开环境设置")}</button>
          </div>}
          </>}
          {(selected?.installUrl || selected?.docsUrl || selected?.guideUrls?.length) && <div className="agent-launcher__links">
            {selected.installUrl && <a href={selected.installUrl} target="_blank" rel="noreferrer">{t('官方安装')}<ExternalLink size={13} /></a>}
            {selected.docsUrl && <a href={selected.docsUrl} target="_blank" rel="noreferrer">{t('官方文档')}<ExternalLink size={13} /></a>}
            {selected.guideUrls?.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">{t('AgentRouter 接入指南')}{index > 0 ? ` ${index + 1}` : ''}<ExternalLink size={13} /></a>)}
          </div>}
          {error && <p className="agent-error" role="alert">{componentError(error, locale)}</p>}
          {!guided && <>
          <p className="agent-help">{t("启动后，每个窗口连接自己的进程。工具的登录、模型选择和交互提示会显示在窗口中。")}</p>
          <button className="button button--primary" type="submit" disabled={disabled}>
            {busy ? <RefreshCw size={16} className="spin" /> : <CirclePlay size={16} />} {busy ? t("正在启动…") : t("启动")}
          </button>
          </>}
        </form>
      )}
    </dialog>
  );
}
