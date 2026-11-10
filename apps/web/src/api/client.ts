import { subscribeLiveEvent } from './live-socket';

export type ToolName = 'claude' | 'codex' | 'dsh' | 'gemini' | 'antigravity' | 'cursor';
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
  /** Null when the service has no last-activity time to measure from — `lastActivityAtMs === null`. */
  quietForMs?: number | null;
  pendingPrompt?: string | null;
  lastDecision?: string;
  transportError?: string;
  /** The workspace resolved from the process or its associated conversation. */
  sessionCwd?: string | null;
  /** The associated conversation title, never a terminal window title. */
  conversationTitle?: string | null;
  /** Native execution platform; distribution identifies WSL regardless of filesystem. */
  platform?: string;
  /** Known turn state from the agent; absent means unknown. */
  runningTurn?: boolean;
  /** The application the session runs inside, when it could be resolved. */
  host?: SessionHostView | null;
  /**
   * The WSL distribution the session runs in, or absent for a Windows process.
   *
   * Its presence is what explains the absent host: a Linux pid has no Win32 window, so the session cannot be
   * previewed or revealed, and saying "WSL: <distro>" is more useful than "host unrecognised".
   */
  distribution?: string;
}

export interface WatchdogConfig {
  enabled: boolean;
  dryRun: boolean;
  pollIntervalMs: number;
  defaultIdleTimeoutMs: number;
  defaultCooldownMs: number;
  maxAttemptsPerQuietPeriod: number;
  /**
   * The WSL distribution to look inside, or an empty string for "do not".
   *
   * Optional so a client built before WSL support still type-checks against an older service response.
   */
  wslDistribution?: string;
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
    /** Optional for older services; the settings editor supplies current defaults. */
    gemini?: { enabled: boolean; normalPrompt: string };
    antigravity?: { enabled: boolean; normalPrompt: string };
    cursor?: { enabled: boolean; normalPrompt: string };
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

export interface RemoteControlSettings {
  readonly host: string;
  readonly port: number;
  readonly name: string;
}
export type RemoteControlView = (RemoteControlSettings & { readonly enabled: false; readonly error?: string }) | (RemoteControlSettings & {
  readonly enabled: true;
  readonly url: string;
  readonly pairing: { readonly code: string; readonly expiresAtMs: number };
  readonly devices: readonly {
    readonly id: string;
    readonly name: string;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
  }[];
});

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

export interface CodexProfileEditView {
  key: string;
  /** null explicitly removes an active setting; omitted keys stay unchanged. */
  value: string | null;
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
  value: string | null;
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

/**
 * The result of asking a session to accept input.
 *
 * `dryRun` is the important field: with Dry Run enabled the service answers 200 and records a skip rather
 * than writing anything, so a caller that ignores this reports success for something that did not happen.
 */
export interface InjectionOutcome {
  readonly dryRun: boolean;
  /** The text the service used, which is the configured prompt when none was supplied. */
  readonly prompt?: string;
}

export interface SessionOutputView {
  readonly sessionId: string;
  readonly state: 'ready' | 'unavailable';
  readonly source: 'claude-jsonl' | 'codex-rollout' | 'dsh-projection' | 'gemini-json' | 'gemini-jsonl' | 'cursor-jsonl' | 'cursor-composer' | 'cursor-agent-host' | 'antigravity-projection' | null;
  readonly entries: readonly {
    readonly id: string;
    readonly role: 'user' | 'assistant' | 'tool';
    readonly text: string;
    readonly timestampMs: number | null;
  }[];
  readonly truncated: boolean;
  readonly reason?: string;
}

export function validateSessionOutput(value: unknown, sessionId: string): SessionOutputView {
  const output = value as SessionOutputView | null;
  if (output === null || typeof output !== 'object' || output.sessionId !== sessionId ||
      !['ready', 'unavailable'].includes(output.state) || typeof output.truncated !== 'boolean' ||
      ![null, 'claude-jsonl', 'codex-rollout', 'dsh-projection', 'gemini-json', 'gemini-jsonl', 'cursor-jsonl', 'cursor-composer', 'cursor-agent-host', 'antigravity-projection'].includes(output.source) ||
      (output.reason !== undefined && typeof output.reason !== 'string') || !Array.isArray(output.entries) ||
      !output.entries.every((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' &&
        ['user', 'assistant', 'tool'].includes(entry.role) && typeof entry.text === 'string' &&
        (entry.timestampMs === null || typeof entry.timestampMs === 'number' && Number.isFinite(entry.timestampMs)))) {
    throw new Error('无法读取该会话的输出数据。');
  }
  return output;
}

export interface WatchdogApi {
  remote?(): Promise<RemoteControlView>;
  refreshRemotePairing?(): Promise<RemoteControlView>;
  revokeRemoteDevice?(id: string): Promise<RemoteControlView>;
  enableRemote?(settings: RemoteControlSettings): Promise<RemoteControlView>;
  disableRemote?(): Promise<RemoteControlView>;
  health(): Promise<HealthView>;
  config(): Promise<WatchdogConfig>;
  updateConfig(config: WatchdogConfig): Promise<WatchdogConfig>;
  sessions(): Promise<SessionView[]>;
  /** Saved history; optional for older injected API adapters. */
  audit?(limit?: number): Promise<AuditEvent[]>;
  output?(id: string): Promise<SessionOutputView>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  inject(id: string, prompt?: string): Promise<InjectionOutcome>;
  focus(id: string): Promise<{ focused: boolean; reason?: string }>;
  install(): Promise<void>;
  startup(): Promise<StartupTaskView>;
  installStartup(): Promise<void>;
  uninstallStartup(): Promise<void>;
  codexProfiles(): Promise<CodexProfilesView>;
  applyCodexProfile(fields: readonly CodexProfileEditView[]): Promise<CodexProfileApplyView>;
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
    let message = `API ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (body !== null && typeof body === 'object') {
        const entry = body as { error?: unknown; message?: unknown };
        const detail = typeof entry.error === 'string' ? entry.error : entry.message;
        if (typeof detail === 'string' && detail.trim().length > 0) message = detail;
      }
    } catch {
      // Proxies may return HTML or an empty body: the HTTP status still explains the failure.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function createApi(): WatchdogApi {
  return {
    remote: () => request<RemoteControlView>('/remote'),
    refreshRemotePairing: () => request<RemoteControlView>('/remote/pairing', { method: 'POST' }),
    revokeRemoteDevice: (id) => request<RemoteControlView>(`/remote/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    enableRemote: (settings) => request<RemoteControlView>('/remote/enable', { method: 'POST', body: JSON.stringify(settings) }),
    disableRemote: () => request<RemoteControlView>('/remote/disable', { method: 'POST' }),
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
    audit: async (limit = 1_000) => {
      const response = await request<{ events: AuditEvent[] }>(`/audit?limit=${limit}`);
      return response.events;
    },
    updateConfig: (config) => request<WatchdogConfig>('/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
    sessions: async () => {
      const response = await request<SessionView[] | { readonly sessions?: SessionView[] }>('/sessions');
      return Array.isArray(response) ? response : response.sessions ?? [];
    },
    output: async (id) => validateSessionOutput(await request<unknown>(`/sessions/${encodeURIComponent(id)}/output`), id),
    pause: (id) => request<void>(`/sessions/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
    resume: (id) => request<void>(`/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    /**
   * Write text into a session.
   *
   * With no `prompt` the service uses the configured continuation prompt, which is what the one-click
   * action does. Supplying one sends that line instead — the service accepts any single line up to 4096
   * characters and refuses empty or multi-line text, so the validation lives there rather than being
   * duplicated here.
   *
   * The outcome is returned rather than discarded, because a 200 does not always mean the text was written:
   * with Dry Run on the service records a skip and writes nothing.
   */
  inject: (id, prompt) => request<InjectionOutcome | void>(
    `/sessions/${encodeURIComponent(id)}/inject`,
    {
      method: 'POST',
      ...(prompt === undefined ? {} : { body: JSON.stringify({ prompt }) }),
    },
  ).then((result) => ({
    // A response body is expected, but an older service that returns none must not be read as a real write.
    dryRun: (result as InjectionOutcome | undefined)?.dryRun === true,
    ...((result as InjectionOutcome | undefined)?.prompt === undefined
      ? {}
      : { prompt: (result as InjectionOutcome).prompt as string }),
  })),
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
      if (typeof WebSocket !== 'undefined') {
        const unsubscribe = (['audit', 'health', 'sessions', 'config', 'claude-hook', 'ready'] as const).map((kind) => subscribeLiveEvent(kind, (data) => {
          if (kind === 'audit' && isAuditEvent(data)) onEvent({ kind, event: data });
          else if (kind !== 'audit') onEvent({ kind, data });
        }));
        return () => unsubscribe.forEach((stop) => stop());
      }
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
