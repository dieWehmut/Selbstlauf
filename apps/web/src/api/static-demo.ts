import type {
  AuditEvent,
  ClaudeHookStatusView,
  HealthView,
  SessionView,
  WatchdogApi,
  WatchdogConfig,
} from './client';

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

export function createStaticDemoApi(): WatchdogApi {
  let currentConfig = structuredClone(initialConfig);
  let currentSessions = structuredClone(initialSessions);
  const currentHealth = structuredClone(initialHealth);
  let startupInstalled = false;
  let codexProfileFields = [
    { key: 'base_url', value: 'https://external-api-platform.hkgai.net/v1' },
  ];
  let codexAlternatives: Record<string, string[]> = {
    base_url: ['https://www.sevnx.lol', 'https://agentrouter.org/v1'],
    model: ['gpt-6-astra'],
  };

  let hookInstallation: Omit<ClaudeHookStatusView, 'enabled'> = {
    installed: false,
    restartRequired: false,
    manualReviewRequired: false,
  };
  const hookStatus = (): ClaudeHookStatusView => ({
    ...structuredClone(hookInstallation),
    enabled: currentConfig.tools.claude.stopHook.enabled,
  });
  return {
    health: async () => structuredClone(currentHealth),
    config: async () => structuredClone(currentConfig),
    updateConfig: async (next) => { currentConfig = structuredClone(next); return structuredClone(currentConfig); },
    sessions: async () => structuredClone(currentSessions),
    pause: async (id) => { currentSessions = currentSessions.map((session) => session.id === id ? { ...session, paused: !session.paused } : session); },
    resume: async (id) => { currentSessions = currentSessions.map((session) => session.id === id ? { ...session, paused: false } : session); },
    inject: async () => undefined,
    focus: async () => ({ focused: true }),
    install: async () => undefined,
    startup: async () => ({ installed: startupInstalled, name: 'Selbstlauf Continuation Watchdog' }),
    installStartup: async () => { startupInstalled = true; },
    uninstallStartup: async () => { startupInstalled = false; },
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
      return { ok: true, changes };
    },
    claudeHook: async () => hookStatus(),
    installClaudeHook: async () => {
      hookInstallation = { installed: true, restartRequired: true, manualReviewRequired: false };
      return hookStatus();
    },
    uninstallClaudeHook: async () => {
      hookInstallation = { installed: false, restartRequired: false, manualReviewRequired: false };
      return hookStatus();
    },
    disableClaudeHook: async () => {
      currentConfig.tools.claude.stopHook.enabled = false;
      return hookStatus();
    },
    start: async () => { currentHealth.running = true; },
    stop: async () => { currentHealth.running = false; },
    uninstall: async () => { currentHealth.running = false; },
    subscribe: () => () => undefined,
  };
}
