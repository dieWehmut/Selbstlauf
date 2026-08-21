export type ToolName = 'claude' | 'codex';
export type TransportKind =
  | 'classic-console'
  | 'pty'
  | 'codex-app-server'
  | 'monitor-only'
  | 'cannot-inject'
  | 'unknown';

export interface GoalView {
  status: string;
  updatedAtMs?: number;
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
}

export interface WatchdogConfig {
  enabled: boolean;
  dryRun: boolean;
  pollIntervalMs: number;
  defaultIdleTimeoutMs: number;
  defaultCooldownMs: number;
  maxAttemptsPerQuietPeriod: number;
  tools: {
    claude: { enabled: boolean; normalPrompt: string };
    codex: { enabled: boolean; normalPrompt: string; goalPrompt: string; goalStatuses: readonly string[] };
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

export type WatchdogEvent =
  | { readonly kind: 'audit'; readonly event: AuditEvent }
  | { readonly kind: 'health' | 'sessions' | 'config' | 'ready'; readonly data: unknown };

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
  inject(id: string): Promise<void>;
  install(): Promise<void>;
  startup(): Promise<StartupTaskView>;
  installStartup(): Promise<void>;
  uninstallStartup(): Promise<void>;
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
    inject: (id) => request<void>(`/sessions/${encodeURIComponent(id)}/inject`, { method: 'POST' }),
    install: () => request<void>('/install', { method: 'POST' }),
    startup: () => request<StartupTaskView>('/startup'),
    installStartup: () => request<void>('/startup/install', { method: 'POST' }),
    uninstallStartup: () => request<void>('/startup/uninstall', { method: 'POST' }),
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
      const listeners = (['audit', 'health', 'sessions', 'config', 'ready'] as const).map((kind) => {
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
