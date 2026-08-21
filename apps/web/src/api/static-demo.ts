import type { WatchdogApi, WatchdogConfig, SessionView, AuditEvent, HealthView } from './client';

const initialConfig: WatchdogConfig = {
  enabled: true,
  dryRun: true,
  pollIntervalMs: 2_000,
  defaultIdleTimeoutMs: 120_000,
  defaultCooldownMs: 300_000,
  maxAttemptsPerQuietPeriod: 1,
  tools: {
    claude: { enabled: true, normalPrompt: '继续' },
    codex: { enabled: true, normalPrompt: '继续', goalPrompt: '/goal resume', goalStatuses: ['active', 'paused'] },
  },
  processFilters: { sameUserOnly: true, include: [], exclude: [] },
};

const now = Date.now();
const initialSessions: SessionView[] = [
  { id: 'codex:336756', tool: 'codex', rootPid: 336756, childPids: [327660], conversationId: 'demo-goal', goal: { status: 'active', updatedAtMs: now - 26000 }, transport: 'codex-app-server', alive: true, enabled: true, paused: false, startedAtMs: now - 3420000, lastActivityAtMs: now - 74000, quietForMs: 74000, pendingPrompt: '/goal resume', lastDecision: 'awaiting-quiet-period' },
  { id: 'claude:214052', tool: 'claude', rootPid: 214052, childPids: [], conversationId: 'demo-project', goal: null, transport: 'classic-console', alive: true, enabled: true, paused: false, startedAtMs: now - 1680000, lastActivityAtMs: now - 18000, quietForMs: 18000, pendingPrompt: '继续', lastDecision: 'output-observed' },
  { id: 'codex:333616', tool: 'codex', rootPid: 333616, childPids: [177240], conversationId: null, goal: null, transport: 'monitor-only', transportError: 'no-cwd-match', alive: true, enabled: true, paused: false, startedAtMs: now - 840000, lastActivityAtMs: now - 132000, quietForMs: 132000, pendingPrompt: '继续', lastDecision: 'cannot-inject' },
];

const events: AuditEvent[] = [
  { id: 'demo-1', timestampMs: now - 18000, type: 'activity', sessionId: 'claude:214052', tool: 'claude' },
  { id: 'demo-2', timestampMs: now - 74000, type: 'decision', sessionId: 'codex:336756', tool: 'codex', details: { decision: 'awaiting-quiet-period' } },
  { id: 'demo-3', timestampMs: now - 132000, type: 'skip', sessionId: 'codex:333616', tool: 'codex', details: { reason: 'monitor-only' } },
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
  return {
    health: async () => structuredClone(currentHealth),
    config: async () => structuredClone(currentConfig),
    updateConfig: async (next) => { currentConfig = structuredClone(next); return structuredClone(currentConfig); },
    sessions: async () => structuredClone(currentSessions),
    pause: async (id) => { currentSessions = currentSessions.map((session) => session.id === id ? { ...session, paused: !session.paused } : session); },
    resume: async (id) => { currentSessions = currentSessions.map((session) => session.id === id ? { ...session, paused: false } : session); },
    inject: async () => undefined,
    install: async () => undefined,
    start: async () => { currentHealth.running = true; },
    stop: async () => { currentHealth.running = false; },
    uninstall: async () => { currentHealth.running = false; },
    subscribe: () => () => undefined,
  };
}
