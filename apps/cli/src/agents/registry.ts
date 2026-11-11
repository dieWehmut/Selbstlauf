import type { AgentTool } from './types.js';

export type AgentKind = 'cli' | 'desktop' | 'extension' | 'shell' | 'custom';

/** Publisher identity and launch/install instructions shared by both catalogs. */
export interface AgentDefinition {
  readonly id: AgentTool;
  readonly label: string;
  readonly kind: AgentKind;
  readonly command?: string;
  readonly packageName?: string;
  readonly installCommand?: string;
  readonly windowsInstallCommand?: string;
  readonly installUrl?: string;
  readonly docsUrl?: string;
  readonly guideUrls?: readonly string[];
  readonly defaultArgs?: readonly string[];
  /** Only reviewed npm options; never interpreted by a shell. */
  readonly installArgs?: readonly string[];
}

const guide = (page: string) => `https://agentrouter.org/docs/${page}.html`;

/** AgentRouter's complete tool navigation and existing supported agents, checked 2026-11-11. */
export const AGENT_REGISTRY: readonly AgentDefinition[] = Object.freeze(([
  { id: 'claude', label: 'Claude Code', kind: 'cli', command: 'claude', packageName: '@anthropic-ai/claude-code',
    installUrl: 'https://code.claude.com/docs/en/setup', docsUrl: 'https://code.claude.com/docs/',
    guideUrls: [guide('claude-code'), guide('claude-code-vscode')] },
  { id: 'codex', label: 'Codex', kind: 'cli', command: 'codex', packageName: '@openai/codex',
    installUrl: 'https://github.com/openai/codex', docsUrl: 'https://developers.openai.com/codex/', guideUrls: [guide('codex')] },
  { id: 'gemini', label: 'Gemini CLI', kind: 'cli', command: 'gemini', packageName: '@google/gemini-cli',
    installUrl: 'https://geminicli.com/docs/get-started/installation/', docsUrl: 'https://geminicli.com/docs/', guideUrls: ['https://agentrouter.org/docs/'] },
  { id: 'grok', label: 'Grok Build', kind: 'cli', command: 'grok', packageName: '@xai-official/grok',
    installUrl: 'https://www.npmjs.com/package/@xai-official/grok' },
  { id: 'opencode', label: 'OpenCode', kind: 'cli', command: 'opencode', packageName: 'opencode-ai',
    installUrl: 'https://opencode.ai/docs/', docsUrl: 'https://opencode.ai/docs/', guideUrls: [guide('opencode')] },
  { id: 'openclaw', label: 'OpenClaw', kind: 'cli', command: 'openclaw', packageName: 'openclaw', defaultArgs: ['tui'],
    installUrl: 'https://docs.openclaw.ai/install', docsUrl: 'https://docs.openclaw.ai/', guideUrls: [guide('openclaw')] },
  { id: 'qwen', label: 'Qwen Code', kind: 'cli', command: 'qwen', packageName: '@qwen-code/qwen-code',
    installUrl: 'https://github.com/QwenLM/qwen-code', docsUrl: 'https://qwenlm.github.io/qwen-code-docs/', guideUrls: [guide('qwencode')] },
  { id: 'hermes', label: 'Hermes Agent', kind: 'cli', command: 'hermes',
    installCommand: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    windowsInstallCommand: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)',
    installUrl: 'https://github.com/NousResearch/hermes-agent#installation', docsUrl: 'https://hermes-agent.nousresearch.com/docs/', guideUrls: [guide('hermes')] },
  { id: 'pi', label: 'Pi', kind: 'cli', command: 'pi', packageName: '@earendil-works/pi-coding-agent', installArgs: ['--ignore-scripts'],
    installUrl: 'https://pi.dev/', docsUrl: 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent', guideUrls: [guide('pi')] },
  { id: 'crush', label: 'Crush', kind: 'cli', command: 'crush', packageName: '@charmland/crush',
    installUrl: 'https://github.com/charmbracelet/crush#installation', docsUrl: 'https://github.com/charmbracelet/crush', guideUrls: [guide('crush')] },
  { id: 'dsh', label: 'DeepSeek Harness', kind: 'cli', command: 'dsh', packageName: '@deepseek-ai/dsh',
    installUrl: 'https://github.com/deepseek-ai/deepseek-harness' },
  { id: 'cline', label: 'Cline', kind: 'cli', command: 'cline', packageName: 'cline',
    installUrl: 'https://github.com/cline/cline', docsUrl: 'https://docs.cline.bot/', guideUrls: [guide('cline')] },
  { id: 'kilo', label: 'Kilo Code', kind: 'cli', command: 'kilo', packageName: '@kilocode/cli',
    installUrl: 'https://github.com/Kilo-Org/kilocode', docsUrl: 'https://kilo.ai/docs/', guideUrls: [guide('kilocode')] },
  { id: 'roo', label: 'Roo Code', kind: 'extension',
    installUrl: 'https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline', docsUrl: 'https://roocodeinc.github.io/Roo-Code/', guideUrls: [guide('roocode')] },
  { id: 'claude-app', label: 'Claude App', kind: 'desktop',
    installUrl: 'https://claude.ai/download', docsUrl: 'https://support.claude.com/', guideUrls: [guide('claude-app')] },
  { id: 'trae', label: 'Trae', kind: 'desktop',
    installUrl: 'https://www.trae.cn/', docsUrl: 'https://www.trae.cn/', guideUrls: [guide('trae')] },
  { id: 'zcode', label: 'ZCode', kind: 'desktop',
    installUrl: 'https://zcode.z.ai/cn', docsUrl: 'https://zcode.z.ai/cn', guideUrls: [guide('zcode')] },
  // The publisher's sites identify CN/international editions separately.
  // These are installation choices; a running WorkBuddy process does not prove its edition.
  { id: 'workbuddy', label: 'WorkBuddy 国内版', kind: 'desktop',
    installUrl: 'https://www.workbuddy.cn/', docsUrl: 'https://www.workbuddy.cn/docs/workbuddy/', guideUrls: [guide('workbuddy')] },
  { id: 'workbuddy-intl', label: 'WorkBuddy 国际版', kind: 'desktop',
    installUrl: 'https://www.workbuddy.ai/', docsUrl: 'https://www.workbuddy.ai/docs/workbuddy/' },
  { id: 'craft-agents', label: 'Craft Agents', kind: 'desktop',
    installUrl: 'https://github.com/craft-ai-agents/craft-agents-oss/releases', docsUrl: 'https://github.com/craft-ai-agents/craft-agents-oss', guideUrls: [guide('craft-agents')] },
  { id: 'antigravity', label: 'Antigravity', kind: 'desktop',
    installUrl: 'https://antigravity.google/download', docsUrl: 'https://antigravity.google/' },
  { id: 'cursor', label: 'Cursor', kind: 'desktop',
    installUrl: 'https://cursor.com/downloads', docsUrl: 'https://cursor.com/docs' },
  { id: 'shell', label: '终端', kind: 'shell' },
  { id: 'custom', label: '自定义智能体', kind: 'custom' },
] satisfies AgentDefinition[]).map((entry) => Object.freeze(entry)));

export function npmInstallCommand(entry: AgentDefinition): string | undefined {
  if (entry.packageName === undefined) return undefined;
  return ['npm i -g', `${entry.packageName}@latest`, ...(entry.installArgs ?? [])].join(' ');
}

export function agentInstallCommand(entry: AgentDefinition, platform: NodeJS.Platform = process.platform): string | undefined {
  return npmInstallCommand(entry) ?? (platform === 'win32' ? entry.windowsInstallCommand ?? entry.installCommand : entry.installCommand);
}
