import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { AGENT_REGISTRY } from '../../../cli/src/agents/registry';
import type { AgentApi, AgentCatalog } from '../api/agents';
import { useI18n } from '../i18n';
import { ToolIcon } from '../sidebar/ToolIcon';
import { AgentInstallationDetails } from './AgentInstallationDetails';
import './agents.css';

// Publisher metadata is safe to show without a native service; its installation state remains unknown.
const unknownTools: AgentCatalog['tools'] = AGENT_REGISTRY
  .filter((entry) => entry.kind !== 'shell' && entry.kind !== 'custom')
  .map((entry) => ({ id: entry.id, label: entry.label, kind: entry.kind, command: null, available: false }));

export function AgentInstallationInventory({ api, demo = false }: { api: AgentApi; demo?: boolean }) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCatalog(null);
    setError(null);
    if (demo) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    void api.catalog().then((value) => {
      if (active) setCatalog(value);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, demo, revision]);

  const tools = (demo ? unknownTools : catalog?.tools ?? unknownTools)
    .filter((entry) => entry.id !== 'shell' && entry.id !== 'custom' && entry.kind !== 'shell' && entry.kind !== 'custom');
  return <section className="settings-section settings-section--wide agent-inventory" aria-busy={loading}>
    <div className="section-title">
      <h2>{t('本机智能体应用')}</h2>
      {!demo && <button className="button button--secondary" type="button" disabled={loading}
        aria-label={t('重新检测智能体应用')} onClick={() => setRevision((current) => current + 1)}>
        <RefreshCw size={16} className={loading ? 'spin' : undefined} />{t('重新检测')}
      </button>}
    </div>
    <p className="agent-help">{demo ? t('在线演示无法检测本机安装状态，请使用本地服务或桌面版。')
      : loading ? t('正在检测本机应用…') : t('安装状态来自本机检测，运行中的会话请在进程列表查看。')}</p>
    {error && <p className="agent-error" role="status">{t('安装检测失败，状态未知：{detail}', { detail: error })}</p>}
    <div className="agent-inventory__grid">
      {tools.map((tool) => <article className="agent-inventory__card" key={tool.id} data-testid={`agent-inventory-${tool.id}`}>
        <header><strong><ToolIcon tool={tool.id} size={18} />{tool.label}</strong>
          <span>{tool.kind === 'desktop' ? t('桌面应用') : tool.kind === 'extension' ? t('编辑器扩展') : t('命令行工具')}</span>
        </header>
        <AgentInstallationDetails tool={tool} />
        {tool.kind === 'cli' && <p className="agent-help">{tool.command
          ? <>{t('启动命令')} <code>{tool.command}</code></>
          : tool.installation === undefined || tool.installation.status === 'unknown'
            ? t('启动命令未知') : t('启动命令未找到')}</p>}
      </article>)}
    </div>
  </section>;
}
