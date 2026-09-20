export type ToolName = 'claude' | 'codex' | 'dsh';
export type TransportKind =
  | 'classic-console'
  | 'pty'
  | 'codex-app-server'
  | 'claude-stop-hook'
  | 'dsh-web'
  | 'monitor-only'
  | 'cannot-inject'
  | 'unknown';

export interface GoalView {
  status: string;
  updatedAtMs?: number;
}

export interface SessionHostView {
  processId: number;
  executableName: string;
  label: string;
  category: 'terminal' | 'editor' | 'desktop-app' | 'browser' | 'console' | 'shell' | 'unknown';
  windowHandle: number | null;
  windowTitle: string | null;
}

export interface SessionView {
  id: string;
  tool: ToolName;
  rootPid: number;
  childPids: number[];
  conversationId: string | null;
  goal: GoalView | null;
  transport: TransportKind;
  alive: boolean;
  enabled: boolean;
  paused: boolean;
  startedAtMs: number;
  lastActivityAtMs: number | null;
  quietForMs?: number;
  pendingPrompt?: string | null;
  lastDecision?: string;
  transportError?: string;
  /** DeepSeek Harness sessions report the workspace they are attached to. */
  sessionCwd?: string | null;
  /** DeepSeek Harness sessions report whether a step is still running. */
  runningTurn?: boolean;
  /** The application the session runs inside, when it could be resolved. */
  host?: SessionHostView | null;
}

export interface WatchdogConfig {
  enabled: boolean;
  dryRun: boolean;
  pollIntervalMs: number;
  defaultIdleTimeoutMs: number;
  defaultCooldownMs: number;
  maxAttemptsPerQuietPeriod: number;
  tools: {
    claude: {
      enabled: boolean;
      normalPrompt: string;
      stopHook: {
        enabled: boolean;
        leaseTtlMs: number;
        commandTimeoutMs: number;
      };
    };
    codex: { enabled: boolean; normalPrompt: string; goalPrompt: string; goalStatuses: readonly string[] };
    dsh: { enabled: boolean; normalPrompt: string; sessionWindowMs: number; allowApiInput: boolean };
  };
  processFilters: { sameUserOnly: boolean; include: readonly string[]; exclude: readonly string[] };
}

export interface AuditEvent {
  id: string;
  timestampMs: number;
  type: string;
  sessionId?: string;
  tool?: ToolName;
  prompt?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface HealthView {
  ok: boolean;
  running: boolean;
  dryRun: boolean;
  lastPollAtMs: number | null;
  version?: string;
}

export interface StartupTaskView {
  installed: boolean;
  name?: string;
}

export interface ClaudeHookStatusView {
  installed: boolean;
  enabled: boolean;
  restartRequired: boolean;
  manualReviewRequired: boolean;
  lastError?: string;
}

export interface CodexProfileFieldView {
  key: string;
  value: string;
}

export interface CodexProfilesView {
  path: string;
  exists: boolean;
  active: Record<string, string>;
  alternatives: Record<string, string[]>;
  current: { name: string; fields: CodexProfileFieldView[] } | null;
}

export interface CodexProfileChangeView {
  key: string;
  action: string;
  value: string;
}

export interface CodexProfileApplyView {
  ok: boolean;
  changes: CodexProfileChangeView[];
}

export type ToolState = 'current' | 'outdated' | 'missing' | 'unknown';

export interface EnvironmentToolView {
  readonly id: string;
  readonly label: string;
  readonly packageName: string;
  readonly installed: string | null;
  readonly latest: string | null;
  readonly state: ToolState;
  readonly installCommand: string;
}

export interface EnvironmentView {
  readonly tools: readonly EnvironmentToolView[];
  readonly upgrades: readonly string[];
  readonly missing: readonly string[];
  readonly manualCommands: readonly string[];
  readonly checkedAtMs: number;
}

/** One install outcome exactly as the service reports it. */
export interface UpgradeResultView {
  readonly id: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
}

export interface UpgradeAllView {
  readonly ok: boolean;
  readonly results: readonly UpgradeResultView[];
}


export type WatchdogEvent =
  | { readonly kind: 'audit'; readonly event: AuditEvent }
  | { readonly kind: 'health' | 'sessions' | 'config' | 'claude-hook' | 'ready'; readonly data: unknown };

interface ServiceHealthResponse {
  readonly ok?: unknown;
  readonly running?: unknown;
  readonly watchdogRunning?: unknown;
  readonly dryRun?: unknown;
  readonly lastPollAtMs?: unknown;
  readonly version?: unknown;
}

export interface WatchdogApi {
  health(): Promise<HealthView>;
  config(): Promise<WatchdogConfig>;
  updateConfig(config: WatchdogConfig): Promise<WatchdogConfig>;
  sessions(): Promise<SessionView[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  inject(id: string, prompt?: string): Promise<void>;
  focus(id: string): Promise<{ focused: boolean; reason?: string }>;
  install(): Promise<void>;
  startup(): Promise<StartupTaskView>;
  installStartup(): Promise<void>;
  uninstallStartup(): Promise<void>;
  codexProfiles(): Promise<CodexProfilesView>;
  applyCodexProfile(fields: readonly CodexProfileFieldView[]): Promise<CodexProfileApplyView>;
  environment(): Promise<EnvironmentView>;
  refreshEnvironment(): Promise<EnvironmentView>;
  upgradeTool(id: string): Promise<UpgradeResultView>;
  upgradeAllTools(): Promise<UpgradeAllView>;
  claudeHook(): Promise<ClaudeHookStatusView>;
  installClaudeHook(): Promise<ClaudeHookStatusView>;
  uninstallClaudeHook(): Promise<ClaudeHookStatusView>;
  disableClaudeHook(): Promise<ClaudeHookStatusView>;
  start(): Promise<void>;
  stop(): Promise<void>;
  uninstall(): Promise<void>;
  subscribe(onEvent: (event: WatchdogEvent) => void): () => void;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`API ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function createApi(): WatchdogApi {
  return {
    health: async () => {
      const response = await request<ServiceHealthResponse>('/health');
      return {
        ok: response.ok === true,
        running: response.running === true || response.watchdogRunning === true,
        dryRun: response.dryRun === true,
        lastPollAtMs: typeof response.lastPollAtMs === 'number' && Number.isFinite(response.lastPollAtMs)
          ? response.lastPollAtMs
          : null,
        ...(typeof response.version === 'string' ? { version: response.version } : {}),
      };
    },
    config: () => request<WatchdogConfig>('/config'),
    updateConfig: (config) => request<WatchdogConfig>('/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
    sessions: async () => {
      const response = await request<SessionView[] | { readonly sessions?: SessionView[] }>('/sessions');
      return Array.isArray(response) ? response : response.sessions ?? [];
    },
    pause: (id) => request<void>(`/sessions/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
    resume: (id) => request<void>(`/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    /**
   * Write text into a session.
   *
   * With no `prompt` the service uses the configured continuation prompt, which is what the
   * one-click action does. Supplying one sends that line instead — the service accepts any single
   * line up to 4096 characters and refuses empty or multi-line text, so the validation lives there
   * rather than being duplicated here.
   */
  inject: (id, prompt) => request<void>(
    `/sessions/${encodeURIComponent(id)}/inject`,
    {
      method: 'POST',
      ...(prompt === undefined ? {} : { body: JSON.stringify({ prompt }) }),
    },
  ),
    focus: (id) => request<{ focused: boolean; reason?: string }>(
      `/sessions/${encodeURIComponent(id)}/focus`,
      { method: 'POST' },
    ),
    install: () => request<void>('/install', { method: 'POST' }),
    startup: () => request<StartupTaskView>('/startup'),
    installStartup: () => request<void>('/startup/install', { method: 'POST' }),
    uninstallStartup: () => request<void>('/startup/uninstall', { method: 'POST' }),
    codexProfiles: () => request<CodexProfilesView>('/codex/profiles'),
    applyCodexProfile: (fields) => request<CodexProfileApplyView>('/codex/profiles', {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    }),
    environment: () => request<EnvironmentView>('/environment'),
    refreshEnvironment: () => request<EnvironmentView>('/environment/refresh', { method: 'POST' }),
    upgradeTool: (id) => request<UpgradeResultView>('/environment/upgrade', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
    upgradeAllTools: () => request<UpgradeAllView>('/environment/upgrade-all', { method: 'POST' }),
    claudeHook: () => request<ClaudeHookStatusView>('/claude-hook'),
    installClaudeHook: () => request<ClaudeHookStatusView>('/claude-hook/install', { method: 'POST' }),
    uninstallClaudeHook: () => request<ClaudeHookStatusView>('/claude-hook/uninstall', { method: 'POST' }),
    disableClaudeHook: () => request<ClaudeHookStatusView>('/claude-hook/disable', { method: 'POST' }),
    start: () => request<void>('/watchdog/start', { method: 'POST' }),
    stop: () => request<void>('/watchdog/stop', { method: 'POST' }),
    uninstall: () => request<void>('/uninstall', { method: 'POST' }),
    subscribe: (onEvent) => {
      if (typeof EventSource === 'undefined') return () => undefined;
      const source = new EventSource('/api/events');
      const receive = (kind: WatchdogEvent['kind'], message: MessageEvent<string>) => {
        try {
          const event = JSON.parse(message.data) as unknown;
          if (kind === 'audit' && isAuditEvent(event)) onEvent({ kind, event });
          else if (kind !== 'audit') onEvent({ kind, data: event });
        } catch {
          // Ignore malformed external events; the next poll repairs the view.
        }
      };
      const listeners = (['audit', 'health', 'sessions', 'config', 'claude-hook', 'ready'] as const).map((kind) => {
        const listener = (message: MessageEvent<string>) => receive(kind, message);
        source.addEventListener(kind, listener);
        return { kind, listener };
      });
      return () => {
        for (const { kind, listener } of listeners) source.removeEventListener(kind, listener);
        source.close();
      };
    },
  };
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return value !== null && typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string';
}
