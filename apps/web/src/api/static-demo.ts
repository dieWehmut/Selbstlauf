import type {
  AuditEvent,
  ClaudeHookStatusView,
  EnvironmentToolView,
  EnvironmentView,
  HealthView,
  SessionView,
  WatchdogApi,
  WatchdogConfig,
} from './client';
// Use the service parser so an imported Pages config has the same constraints as
// the live HTTP API, including legacy defaults and resumable goal statuses.
import { parseConfig } from '../../../cli/src/domain/config';

const initialConfig: WatchdogConfig = {
  enabled: true,
  dryRun: true,
  pollIntervalMs: 2_000,
  defaultIdleTimeoutMs: 120_000,
  defaultCooldownMs: 300_000,
  maxAttemptsPerQuietPeriod: 1,
  tools: {
    claude: {
      enabled: true,
      normalPrompt: '继续',
      stopHook: { enabled: false, leaseTtlMs: 15_000, commandTimeoutMs: 1_500 },
    },
    codex: { enabled: true, normalPrompt: '继续', goalPrompt: '/goal resume', goalStatuses: ['active', 'paused'] },
    dsh: { enabled: true, normalPrompt: '继续', sessionWindowMs: 3_600_000, allowApiInput: true },
  },
  processFilters: { sameUserOnly: true, include: [], exclude: [] },
};

const now = Date.now();
const initialSessions: SessionView[] = [
  { id: 'codex:336756', tool: 'codex', rootPid: 336756, childPids: [327660], conversationId: 'demo-goal', goal: { status: 'active', updatedAtMs: now - 26000 }, transport: 'codex-app-server', alive: true, enabled: true, paused: false, startedAtMs: now - 3420000, lastActivityAtMs: now - 74000, quietForMs: 74000, pendingPrompt: '/goal resume', lastDecision: 'awaiting-quiet-period', host: { processId: 31192, executableName: 'Tabby.exe', label: 'Tabby', category: 'terminal', windowHandle: 65_001, windowTitle: ' Orchester' } },
  { id: 'claude:214052', tool: 'claude', rootPid: 214052, childPids: [], conversationId: 'demo-project', goal: null, transport: 'classic-console', alive: true, enabled: true, paused: false, startedAtMs: now - 1680000, lastActivityAtMs: now - 18000, quietForMs: 18000, pendingPrompt: '继续', lastDecision: 'output-observed', host: { processId: 25664, executableName: 'Code.exe', label: 'Visual Studio Code', category: 'editor', windowHandle: 65_002, windowTitle: 'config.toml - Nexus - Visual Studio Code' } },
  { id: 'codex:333616', tool: 'codex', rootPid: 333616, childPids: [177240], conversationId: null, goal: null, transport: 'monitor-only', transportError: 'no-cwd-match', alive: true, enabled: true, paused: false, startedAtMs: now - 840000, lastActivityAtMs: now - 132000, quietForMs: 132000, pendingPrompt: '继续', lastDecision: 'cannot-inject', host: null },
  { id: 'dsh:session-4f21c0a8', tool: 'dsh', rootPid: 973680, childPids: [973681], conversationId: 'session-4f21c0a8-0e75-4f7a-9f0b-2a63b91d0f52', goal: null, transport: 'dsh-web', alive: true, enabled: true, paused: false, startedAtMs: now - 1260000, lastActivityAtMs: now - 42000, quietForMs: 42000, pendingPrompt: '继续', lastDecision: 'awaiting-quiet-period', sessionCwd: 'D:\\project\\ai-cli-bypass', runningTurn: false, host: { processId: 35544, executableName: 'msedge.exe', label: 'Microsoft Edge', category: 'browser', windowHandle: 65_003, windowTitle: '帮我优化排版 — DSH' } },
];

const events: AuditEvent[] = [
  { id: 'demo-1', timestampMs: now - 18000, type: 'activity', sessionId: 'claude:214052', tool: 'claude' },
  { id: 'demo-2', timestampMs: now - 74000, type: 'decision', sessionId: 'codex:336756', tool: 'codex', details: { decision: 'awaiting-quiet-period' } },
  { id: 'demo-3', timestampMs: now - 132000, type: 'skip', sessionId: 'codex:333616', tool: 'codex', details: { reason: 'monitor-only' } },
  { id: 'demo-4', timestampMs: now - 42000, type: 'activity', sessionId: 'dsh:session-4f21c0a8', tool: 'dsh', details: { source: 'dsh-session' } },
];

const initialHealth: HealthView = {
  ok: true,
  running: true,
  dryRun: true,
  lastPollAtMs: now - 1_000,
  version: 'pages-demo',
};

/**
 * Sample environment data for the hosted Pages demo.
 *
 * The demo never probes a real machine, so this mirrors what a typical Windows
 * install reports: a few agents behind their published release, Codex current,
 * and one agent that is not installed at all. The upgrade actions move those
 * versions too, so the Pages build shows the same working buttons as the app.
 */
const demoToolSeed: EnvironmentToolView[] = [
  { id: 'claude', label: 'Claude Code', packageName: '@anthropic-ai/claude-code', installed: '2.1.274', latest: '2.1.276', state: 'outdated', installCommand: 'npm i -g @anthropic-ai/claude-code@latest' },
  { id: 'codex', label: 'Codex', packageName: '@openai/codex', installed: '0.155.0', latest: '0.155.0', state: 'current', installCommand: 'npm i -g @openai/codex@latest' },
  { id: 'gemini', label: 'Gemini CLI', packageName: '@google/gemini-cli', installed: '0.50.0', latest: '0.60.0', state: 'outdated', installCommand: 'npm i -g @google/gemini-cli@latest' },
  { id: 'grok', label: 'Grok Build', packageName: '@xai-official/grok', installed: null, latest: '1.0.34', state: 'missing', installCommand: 'npm i -g @xai-official/grok@latest' },
  { id: 'opencode', label: 'OpenCode', packageName: 'opencode-ai', installed: '1.17.15', latest: '1.18.31', state: 'outdated', installCommand: 'npm i -g opencode-ai@latest' },
  { id: 'openclaw', label: 'OpenClaw', packageName: 'openclaw', installed: '2026.3.28', latest: '2026.9.4', state: 'outdated', installCommand: 'npm i -g openclaw@latest' },
];

function buildEnvironmentReport(tools: readonly EnvironmentToolView[]): EnvironmentView {
  return {
    tools,
    upgrades: tools.filter((tool) => tool.state === 'outdated').map((tool) => tool.id),
    missing: tools.filter((tool) => tool.state === 'missing').map((tool) => tool.id),
    manualCommands: tools.map((tool) => tool.installCommand),
    checkedAtMs: Date.now(),
  };
}

/**
 * Model one install: a demo upgrade moves the installed version to the
 * published one, so the card flips to current exactly like a real install.
 */
function upgradedTools(tools: readonly EnvironmentToolView[], id: string): EnvironmentToolView[] {
  return tools.map((tool) => tool.id === id && tool.latest !== null
    ? { ...tool, installed: tool.latest, state: 'current' as const }
    : tool);
}

export const STATIC_DEMO_STORAGE_KEY = 'selbstlauf-pages-demo-v1';
type DemoStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface DemoPreferences {
  schema: 1;
  config: WatchdogConfig;
  running: boolean;
  startupInstalled: boolean;
  codexProfileFields: { key: string; value: string }[];
  codexAlternatives: Record<string, string[]>;
  hookInstallation: Omit<ClaudeHookStatusView, 'enabled'>;
  installedTools: Record<string, string | null>;
}

function browserStorage(): DemoStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadPreferences(storage: DemoStorage | null): DemoPreferences | null {
  try {
    const raw = storage?.getItem(STATIC_DEMO_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.schema !== 1 || typeof value.running !== 'boolean'
      || typeof value.startupInstalled !== 'boolean' || !Array.isArray(value.codexProfileFields)
      || value.codexProfileFields.some((field) => !record(field) || typeof field.key !== 'string' || typeof field.value !== 'string')
      || !record(value.codexAlternatives) || Object.values(value.codexAlternatives).some((entries) => !Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string'))
      || !record(value.hookInstallation)
      || typeof value.hookInstallation.installed !== 'boolean'
      || typeof value.hookInstallation.restartRequired !== 'boolean'
      || typeof value.hookInstallation.manualReviewRequired !== 'boolean'
      || !record(value.installedTools) || Object.values(value.installedTools).some((version) => version !== null && typeof version !== 'string')) return null;
    const config = structuredClone(parseConfig(value.config));
    return { ...value, config } as unknown as DemoPreferences;
  } catch {
    // Old, truncated or manually edited local data must never blank the demo.
    return null;
  }
}

/** Persist settings only; sample sessions and host/process identities reset on reload. */
export function createStaticDemoApi(storageOption?: DemoStorage | null): WatchdogApi {
  const storage = storageOption === undefined ? browserStorage() : storageOption;
  const saved = loadPreferences(storage);
  let currentConfig: WatchdogConfig = saved?.config ?? structuredClone(initialConfig);
  let currentSessions = structuredClone(initialSessions);
  let currentTools = structuredClone(demoToolSeed).map((tool) => {
    const installed = saved?.installedTools[tool.id];
    if (installed === undefined) return tool;
    return { ...tool, installed, state: installed === null ? 'missing' as const : installed === tool.latest ? 'current' as const : 'outdated' as const };
  });
  const currentHealth = structuredClone(initialHealth);
  currentHealth.running = saved?.running ?? currentHealth.running;
  let startupInstalled = saved?.startupInstalled ?? false;
  let codexProfileFields = saved?.codexProfileFields ?? [
    { key: 'base_url', value: 'https://external-api-platform.hkgai.net/v1' },
  ];
  let codexAlternatives: Record<string, string[]> = saved?.codexAlternatives ?? {
    base_url: ['https://www.sevnx.lol', 'https://agentrouter.org/v1'],
    model: ['gpt-6-astra'],
  };

  let hookInstallation: Omit<ClaudeHookStatusView, 'enabled'> = saved?.hookInstallation ?? {
    installed: false,
    restartRequired: false,
    manualReviewRequired: false,
  };
  const hookStatus = (): ClaudeHookStatusView => ({
    ...structuredClone(hookInstallation),
    enabled: currentConfig.tools.claude.stopHook.enabled,
  });
  const preferences = (): DemoPreferences => ({
      schema: 1, config: currentConfig, running: currentHealth.running,
      startupInstalled, codexProfileFields, codexAlternatives, hookInstallation,
      installedTools: Object.fromEntries(currentTools.map((tool) => [tool.id, tool.installed])),
  });
  let lastSaved = structuredClone(preferences());
  const persist = () => {
    // null explicitly opts into isolated memory state for fixtures/HTTP mocks.
    if (storageOption === null) return;
    try {
      if (!storage) throw new Error('storage unavailable');
      storage.setItem(STATIC_DEMO_STORAGE_KEY, JSON.stringify(preferences()));
      lastSaved = structuredClone(preferences());
    } catch {
      // Failed persistence must not become an apparently applied setting at the
      // next poll after the UI correctly reported a save error.
      currentConfig = structuredClone(lastSaved.config);
      currentHealth.running = lastSaved.running;
      startupInstalled = lastSaved.startupInstalled;
      codexProfileFields = structuredClone(lastSaved.codexProfileFields);
      codexAlternatives = structuredClone(lastSaved.codexAlternatives);
      hookInstallation = structuredClone(lastSaved.hookInstallation);
      currentTools = currentTools.map((tool) => {
        const installed = lastSaved.installedTools[tool.id];
        return { ...tool, installed, state: installed === null ? 'missing' : installed === tool.latest ? 'current' : 'outdated' };
      });
      throw new Error('浏览器无法保存演示设置，请检查本地存储权限或空间');
    }
  };
  return {
    health: async () => structuredClone(currentHealth),
    config: async () => structuredClone(currentConfig),
    updateConfig: async (next) => { currentConfig = structuredClone(parseConfig(next)); persist(); return structuredClone(currentConfig); },
    sessions: async () => structuredClone(currentSessions),
    pause: async (id) => { currentSessions = currentSessions.map((session) => session.id === id ? { ...session, paused: !session.paused } : session); },
    resume: async (id) => { currentSessions = currentSessions.map((session) => session.id === id ? { ...session, paused: false } : session); },
    // The demo cannot write to a process, even if the saved Dry Run toggle is off.
    inject: async () => ({ dryRun: true }),
    focus: async () => { throw new Error('在线演示无法打开本机运行位置，请使用本地服务或桌面版'); },
    install: async () => undefined,
    startup: async () => ({ installed: startupInstalled, name: 'Selbstlauf Continuation Watchdog' }),
    installStartup: async () => { startupInstalled = true; persist(); },
    uninstallStartup: async () => { startupInstalled = false; persist(); },
    codexProfiles: async () => {
      const active = Object.fromEntries(codexProfileFields.map((field) => [field.key, field.value]));
      const baseUrl = active.base_url ?? '';
      let name = 'current';
      if (baseUrl.length > 0) {
        try {
          name = new URL(baseUrl).host;
        } catch {
          name = baseUrl;
        }
      }
      return {
        path: 'C:\\Users\\demo\\.codex\\config.toml',
        exists: true,
        active,
        alternatives: structuredClone(codexAlternatives),
        current: codexProfileFields.length === 0 ? null : { name, fields: structuredClone(codexProfileFields) },
      };
    },
    applyCodexProfile: async (fields) => {
      const changes = fields.map((field) => {
        const previous = codexProfileFields.find((entry) => entry.key === field.key)?.value;
        if (previous !== undefined && previous !== field.value) {
          codexAlternatives[field.key] = [...new Set([...(codexAlternatives[field.key] ?? []), previous])];
        }
        return { key: field.key, action: 'uncommented', value: field.value };
      });
      codexProfileFields = fields.map((field) => ({ key: field.key, value: field.value }));
      persist();
      return { ok: true, changes };
    },
    claudeHook: async () => hookStatus(),
    environment: async () => buildEnvironmentReport(structuredClone(currentTools)),
    refreshEnvironment: async () => buildEnvironmentReport(structuredClone(currentTools)),
    upgradeTool: async (id) => {
      const tool = currentTools.find((entry) => entry.id === id);
      if (tool === undefined) return { id, ok: false, error: `unknown tool: ${id}` };
      currentTools = upgradedTools(currentTools, id);
      persist();
      return { id, ok: true, output: '演示状态已保存；未安装本机软件包' };
    },
    upgradeAllTools: async () => {
      const outdated = currentTools.filter((tool) => tool.state === 'outdated');
      for (const tool of outdated) currentTools = upgradedTools(currentTools, tool.id);
      persist();
      return { ok: true, results: outdated.map((tool) => ({ id: tool.id, ok: true, output: '演示状态已保存；未安装本机软件包' })) };
    },
    installClaudeHook: async () => {
      hookInstallation = { installed: true, restartRequired: true, manualReviewRequired: false };
      persist();
      return hookStatus();
    },
    uninstallClaudeHook: async () => {
      hookInstallation = { installed: false, restartRequired: false, manualReviewRequired: false };
      persist();
      return hookStatus();
    },
    disableClaudeHook: async () => {
      currentConfig.tools.claude.stopHook.enabled = false;
      persist();
      return hookStatus();
    },
    start: async () => { currentHealth.running = true; persist(); },
    stop: async () => { currentHealth.running = false; persist(); },
    uninstall: async () => { currentHealth.running = false; persist(); },
    subscribe: () => () => undefined,
  };
}
