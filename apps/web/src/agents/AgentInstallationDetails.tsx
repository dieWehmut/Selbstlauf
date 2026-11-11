import type { AgentCatalog } from '../api/agents';
import { useI18n } from '../i18n';

type CatalogTool = AgentCatalog['tools'][number];

/** An installation result never establishes that an agent is running or has a usable CLI. */
export function installationLabel(tool: CatalogTool): '已安装' | '未找到' | '未知' {
  if (tool.installation?.status === 'installed') return '已安装';
  if (tool.installation?.status === 'not-found') return '未找到';
  return '未知';
}

export function AgentInstallationDetails({ tool }: { tool: CatalogTool }) {
  const { t } = useI18n();
  const result = tool.installation;
  const state = result?.status ?? 'unknown';
  return <div className="agent-installation" data-testid={`agent-installation-${tool.id}`}>
    <p className="agent-installation__status">
      <span>{t('安装状态')}</span>
      <span className={`agent-installation__badge agent-installation__badge--${state}`}>{t(installationLabel(tool))}</span>
    </p>
    {result?.path && <dl className="agent-installation__paths"><div>
      <dt>{t('检测路径')}</dt><dd><code>{result.path}</code></dd>
    </div></dl>}
    {(result?.extensions?.length ?? 0) > 0 && <dl className="agent-installation__paths">
      {result?.extensions?.map((extension) => <div key={`${extension.id}:${extension.path}`}>
        <dt>{t('编辑器扩展')} <code>{extension.id}</code></dt><dd><code>{extension.path}</code></dd>
      </div>)}
    </dl>}
    {result?.reason && <p className="agent-help">{t('检测说明：{detail}', { detail: t(result.reason) })}</p>}
  </div>;
}
