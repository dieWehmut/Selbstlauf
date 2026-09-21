import { spawn as nodeSpawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CodexAdapter, type CodexContinuationContext } from '../codex/codex-adapter.js';
import { AppServerClient } from '../codex/app-server.js';
import { snapshotWslCodexState } from '../codex/wsl-state.js';
import { ClaudeLeaseStore } from '../claude/lease-store.js';
import {
  associateClaudeSession,
  hasClaudeSessionActivity,
  scanClaudeSessionFiles,
  type ClaudeSessionFile,
} from '../association/claude.js';
import {
  dshSessionActivity,
  hasDshSessionActivity,
  isLiveDshSession,
  scanDshSessions,
  type DshSessionActivity,
  type DshSessionFile,
} from '../association/dsh.js';
import { listLoopbackListenPorts } from '../dsh/loopback-ports.js';
import { DshHostClient } from '../dsh/web-host.js';
import { defaultConfig } from '../domain/config.js';
import type {
  GoalSnapshot,
  SessionSnapshot,
  ToolName,
  TransportKind,
  WatchdogConfig,
} from '../domain/types.js';
import { WatchdogEngine } from '../engine/watchdog.js';
import {
  groupProcesses,
  type DiscoveredProcessSession,
} from '../process/discovery.js';
import type { SessionHost } from '../process/host-apps.js';
import { focusWindow, openLocalUrl, type WindowFocusResult } from '../process/window-focus.js';
import { listWslProcesses } from '../process/wsl-processes.js';
import {
  WindowsProcessProvider,
  type ProcessProvider,
  type RawProcessRecord,
} from '../process/process-provider.js';
import { ConsoleTransport } from '../transport/console-bridge.js';
import { DshWebTransport } from '../transport/dsh-transport.js';
import type {
  InjectableTransportKind,
  SessionTransport,
} from '../transport/transport.js';
import type { AuditStore } from '../store/audit-store.js';
import type { ConfigStore } from '../store/config-store.js';

export interface RuntimeInjectionResult {
  readonly ok: boolean;
  readonly prompt?: string;
  readonly dryRun?: boolean;
  readonly error?: string;
}

export interface WatchdogControllerOptions {
  readonly configStore: ConfigStore;
  readonly auditStore: AuditStore;
  readonly provider?: ProcessProvider;
  readonly publish?: (event: string, data: unknown) => void;
  readonly now?: () => number;
  readonly currentProcessId?: number;
  readonly platform?: NodeJS.Platform;
  /** The `wsl.exe` to use, overridden in tests. Defaults to the one on PATH. */
  readonly wslPath?: string;
  readonly claudeProjectsDirectory?: string;
  readonly dshHomeDirectory?: string;
  readonly codexStatePath?: string;
  readonly codexGoalPath?: string;
  readonly codexAppServerFactory?: () => AppServerClient;
  readonly transportFactory?: (session: DiscoveredProcessSession) => SessionTransport | null;
  readonly claudeLeaseStore?: ClaudeLeaseStore;
  readonly claudeHookInstalled?: () => boolean | Promise<boolean>;
  /** Builds one harness web-host client; overridable for tests. */
  readonly dshHostClientFactory?: () => DshHostClient;
  /** Lists the loopback ports a harness host listens on; overridable for tests. */
  readonly dshPortLister?: (pid: number) => Promise<number[]>;
  /** Raises one window; overridable for tests. */
  readonly focusWindowImpl?: (handle: number) => Promise<WindowFocusResult>;
  /** Opens one local interface URL; overridable for tests. */
  readonly openUrlImpl?: (url: string) => Promise<WindowFocusResult>;
}

export interface RuntimeSessionView extends SessionSnapshot {
  readonly quietForMs: number | null;
  readonly pendingPrompt: string | null;
  readonly lastDecision: string;
  readonly transportError?: string;
  /** The workspace a hosted DeepSeek Harness session is attached to. */
  readonly sessionCwd?: string | null;
  /** True while the hosted DeepSeek Harness session has an unfinished step. */
  readonly runningTurn?: boolean;
  /** The application the session runs inside, with the window to raise. */
  readonly host?: SessionHost | null;
}

export interface WatchdogRuntimeStatus {
  readonly lastPollAtMs: number | null;
}

interface RuntimeSession {
  readonly id: string;
  readonly startedAtMs: number;
  group: DiscoveredProcessSession;
  engine: WatchdogEngine;
  engineKey: string;
  userPaused: boolean;
  alive: boolean;
  transport: SessionTransport | null;
  validatedTransportKind: InjectableTransportKind | null;
  transportKind: TransportKind;
  transportError: string | undefined;
  consoleProcessIds: readonly number[] | null;
  transportFingerprint: string | null;
  probeAttempted: boolean;
  claudeFile: ClaudeSessionFile | null;
  claudeActivity: { readonly size: number; readonly mtimeMs: number } | null;
  claudeLeaseSessionId: string | null;
  codexAdapter: CodexAdapter | null;
  codexContext: CodexContinuationContext | null;
  codexActivity: { snapshot(): Promise<{ readonly changed: boolean }> } | null;
  dshSession: DshSessionFile | null;
  dshActivity: DshSessionActivity | null;
  goal: GoalSnapshot | null;
  conversationId: string | null;
  pendingPrompt: string | null;
  lastAuditedDecision: string | null;
}

const DEFAULT_CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const DEFAULT_DSH_HOME = join(homedir(), '.dsh');
const SHARED_CONSOLE_ERROR = 'shared classic Console contains multiple discovered CLI sessions';
const DSH_MONITOR_ONLY_REASON = 'DeepSeek Harness exposes no local input transport';
const DSH_INPUT_DISABLED_REASON = 'DeepSeek Harness input is disabled in the watchdog settings';
const DSH_DRY_RUN_REASON = 'dry run keeps DeepSeek Harness input disabled';
const DSH_API_UNAVAILABLE_REASON = 'the local DeepSeek Harness session API is unavailable';
const DSH_HOST_RETRY_MS = 60_000;
/**
 * Window titles containing one of these markers are showing the harness WebUI. The harness serves its
 * browser UI over loopback, so the browser is never part of the session's process tree and only its title
 * connects the two.
 *
 * Both the short name and the full product name are listed, because the title is whatever the browser is
 * showing and only the full name appears in practice: measured on this machine, the harness window's title
 * is `Reference attachments for goal objective — DeepSeek Harness`, which does **not** contain `DSH`. With
 * only the abbreviation the match failed, and the harness session was reported as having no window at all
 * while its window was open — which also cost it the 切换到该窗口 action.
 */
const DSH_WINDOW_TITLE_MARKERS: readonly string[] = ['DeepSeek Harness', 'DSH'];
const DSH_WEB_LABEL = 'DeepSeek Harness 网页界面';

/**
 * Owns one polling loop and one state machine per discovered process group.
 * It deliberately treats association and transport failures as monitor-only.
 */
export class WatchdogController {
  private readonly configStore: ConfigStore;
  private readonly auditStore: AuditStore;
  private readonly provider: ProcessProvider;
  private readonly publish?: (event: string, data: unknown) => void;
  private readonly now: () => number;
  private readonly currentProcessId: number;
  private readonly platform: NodeJS.Platform;
  private readonly wslPath?: string;
  /** The last WSL discovery failure, so a persistent one is not written to the audit log every poll. */
  private lastWslError: string | null = null;
  /** Cached per distribution, because the home directory and state paths do not move while it runs. */
  private wslCodexPaths: CodexPaths | null = null;
  private wslHomeDirectory?: string;
  /** Where the distribution's Codex state was copied, removed when the controller stops. */
  private wslStateDirectory: string | null = null;
  private wslStateError: string | null = null;
  /**
   * How to launch the Codex CLI inside a distribution, resolved once.
   *
   * Measured: `codex` there is a script whose shebang needs `node`, and `wsl.exe -e` supplies no PATH, so an
   * absolute node and entry point are needed. Both are discovered from the distribution rather than assumed,
   * because a distribution can install node anywhere.
   */
  private wslCodexLaunch: { readonly node: string; readonly entry: string } | null = null;
  private readonly claudeProjectsDirectory: string;
  private readonly dshHomeDirectory: string;
  private readonly codexStatePath?: string;
  private readonly codexGoalPath?: string;
  private readonly codexAppServerFactory: () => AppServerClient;
  private readonly transportFactory?: (session: DiscoveredProcessSession) => SessionTransport | null;
  private readonly claudeLeaseStore?: ClaudeLeaseStore;
  private readonly claudeHookInstalled: () => boolean | Promise<boolean>;
  private readonly dshHostClientFactory: () => DshHostClient;
  private readonly dshPortLister: (pid: number) => Promise<number[]>;
  private readonly focusWindowImpl: (handle: number) => Promise<WindowFocusResult>;
  private readonly openUrlImpl: (url: string) => Promise<WindowFocusResult>;
  private readonly activeClaudeLeaseWrites = new Set<Promise<WriteResultLike>>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private dshSessions = new Map<string, DshSessionFile>();
  private readonly dshHosts = new Map<number, { client: DshHostClient; attemptedAtMs: number | null }>();
  private codexPathsPromise: Promise<CodexPaths | null> | null = null;
  private currentConfig: WatchdogConfig = defaultConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private currentPoll: Promise<void> | null = null;
  private completedPollAtMs: number | null = null;

  public constructor(options: WatchdogControllerOptions) {
    this.configStore = options.configStore;
    this.auditStore = options.auditStore;
    this.currentProcessId = options.currentProcessId ?? process.pid;
    this.provider = options.provider ??
      new WindowsProcessProvider({
        includeProcessIds: [this.currentProcessId],
        windowTitleMarkers: DSH_WINDOW_TITLE_MARKERS,
      });
    this.publish = options.publish;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.wslPath = options.wslPath;
    this.claudeProjectsDirectory = options.claudeProjectsDirectory ?? DEFAULT_CLAUDE_PROJECTS;
    this.dshHomeDirectory = options.dshHomeDirectory ?? defaultDshHome();
    this.codexStatePath = options.codexStatePath;
    this.codexGoalPath = options.codexGoalPath;
    this.codexAppServerFactory = options.codexAppServerFactory ?? (() => new AppServerClient());
    this.transportFactory = options.transportFactory;
    this.claudeLeaseStore = options.claudeLeaseStore;
    this.claudeHookInstalled = options.claudeHookInstalled ?? (() => false);
    this.dshHostClientFactory = options.dshHostClientFactory ??
      (() => new DshHostClient({ homeDirectory: this.dshHomeDirectory }));
    this.dshPortLister = options.dshPortLister ?? ((pid: number) => listLoopbackListenPorts(pid));
    this.focusWindowImpl = options.focusWindowImpl ?? ((handle: number) => focusWindow(handle));
    this.openUrlImpl = options.openUrlImpl ?? ((url: string) => openLocalUrl(url));
  }

  public async start(): Promise<void> {
    if (this.running) return;
    await this.currentPoll;
    this.stopping = false;
    this.running = true;
    await this.poll();
    this.schedule(this.currentConfig.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    await this.quiesce();
    await this.currentPoll;
    await this.waitForClaudeLeaseWrites();
    await this.claudeLeaseStore?.clearAll();
    for (const session of this.sessions.values()) session.codexAdapter?.close();
    this.sessions.clear();
    // The WSL state copies are a temporary working set, so they are removed on the way out rather than left
    // in the temp directory for every run of the service.
    if (this.wslStateDirectory !== null) {
      try {
        rmSync(this.wslStateDirectory, { recursive: true, force: true });
      } catch {
        // A copy that cannot be removed is not worth failing a shutdown over; the OS clears temp eventually.
      }
      this.wslStateDirectory = null;
    }
  }

  /** Stops new work and clears pending Claude actions without waiting for a slow read-only discovery poll. */
  public async quiesce(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.provider.cancelPending?.();
    await this.waitForClaudeLeaseWrites();
    await this.claudeLeaseStore?.clearAll();
  }

  public poll(): Promise<void> {
    if (this.currentPoll !== null) return this.currentPoll;
    const operation = this.runPoll();
    this.currentPoll = operation;
    void operation.finally(() => {
      if (this.currentPoll === operation) this.currentPoll = null;
    });
    return operation;
  }

  public status(): WatchdogRuntimeStatus {
    return { lastPollAtMs: this.completedPollAtMs };
  }

  private async runPoll(): Promise<void> {
    try {
      this.currentConfig = await this.configStore.load();
      if (this.stopping) return;
      const timestamp = this.now();
      const processGroups = await this.discover();
      if (this.stopping) return;
      const groups = await this.expandDshSessions(processGroups, timestamp);
      if (this.stopping) return;
      const claudeFiles = groups.some((group) => group.tool === 'claude')
        ? await this.scanClaudeFiles()
        : [];
      if (this.stopping) return;
      const seen = new Set<string>();

      for (const group of groups) {
        const id = sessionIdFor(group);
        seen.add(id);
        let session = this.sessions.get(id);
        if (session !== undefined && processIdentityChanged(session.group, group)) {
          session.alive = false;
          session.engine.markExited(session.id);
          await this.clearClaudeLease(session);
          session.codexAdapter?.close();
          await this.record(session, 'process-exited', { reason: 'process-identity-changed' });
          this.sessions.delete(id);
          session = undefined;
        }
        session ??= await this.createSession(id, group, timestamp);
        session.group = group;
        session.alive = true;
        this.configureEngine(session, this.currentConfig, timestamp);
        if (session.codexAdapter !== null) {
          session.codexAdapter.configurePolicy(this.currentConfig.tools.codex);
        }
        session.engine.observeSession(id, timestamp, {
          enabled: this.currentConfig.enabled && this.currentConfig.tools[group.tool].enabled,
          paused: session.userPaused,
          alive: true,
        });
        if (group.tool === 'claude' && !this.claudeConfigEnabled()) {
          await this.clearClaudeLease(session);
        }
        try {
          await this.updateAssociation(session, claudeFiles, timestamp);
        } catch (error) {
          // A malformed session database or an attach failure must not stop
          // discovery and quiet-period decisions for unrelated processes.
          session.transportError = errorMessage(error);
          session.transportKind = 'monitor-only';
          await this.record(session, 'transport-error', {
            reason: `session-refresh: ${session.transportError}`,
          });
        }
      }

      this.resolveConsoleCollisions();

      for (const session of this.sessions.values()) {
        if (!seen.has(session.id)) continue;
        try {
          await this.updateActivity(session, timestamp);
        } catch (error) {
          session.transportError = errorMessage(error);
          session.transportKind = 'cannot-inject';
          await this.record(session, 'transport-error', {
            reason: `activity-refresh: ${session.transportError}`,
          });
        }
        await this.refreshClaudeHookCapability(session);
      }

      for (const session of this.sessions.values()) {
        if (seen.has(session.id)) continue;
        if (session.alive) {
          session.alive = false;
          session.engine.markExited(session.id);
          await this.clearClaudeLease(session);
          await this.record(session, 'process-exited', { reason: 'not-discovered' });
        }
      }

      for (const session of this.sessions.values()) {
        const intents = session.engine.tick(timestamp);
        await this.auditDecision(session, timestamp);
        for (const intent of intents) await this.injectAutomatic(session, intent.issuedAtMs);
      }
    } catch (error) {
      await this.auditGlobal('transport-error', { reason: errorMessage(error) });
    } finally {
      this.completedPollAtMs = this.now();
      if (this.running) this.schedule(this.currentConfig.pollIntervalMs);
    }
  }

  public async list(): Promise<readonly RuntimeSessionView[]> {
    return Object.freeze([...this.sessions.values()].map((session) => this.toView(session)));
  }

  public async configChanged(config: WatchdogConfig): Promise<void> {
    this.currentConfig = config;
    await this.currentPoll;
    await this.waitForClaudeLeaseWrites();
    await this.claudeLeaseStore?.clearAll();
    for (const session of this.sessions.values()) {
      session.engine.setEnabled(
        session.id,
        config.enabled && config.tools[session.group.tool].enabled,
      );
      if (session.group.tool === 'claude') {
        session.claudeLeaseSessionId = null;
        if (!this.claudeConfigEnabled() && session.transportKind === 'claude-stop-hook') {
          session.transportKind = 'monitor-only';
        }
      }
    }
  }

  public async pause(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.userPaused = true;
    session.engine.pause(sessionId);
    await this.clearClaudeLease(session);
    void this.record(session, 'user-override', { action: 'pause' });
    return true;
  }

  public resume(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.userPaused = false;
    const resumed = session.engine.resume(sessionId);
    if (resumed) void this.record(session, 'user-override', { action: 'resume' });
    return resumed;
  }

  /**
   * Show a person where a session lives: raise the window it runs in, or open
   * the local interface that serves it when no window belongs to the session.
   *
   * This only manages windows and URLs; it never sends input to the session.
   * @param sessionId - the watched session to reveal.
   * @returns whether a window was raised or an interface was opened.
   */
  public async focus(sessionId: string): Promise<WindowFocusResult> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: false, reason: 'session-not-found' };
    if (!session.alive) return { ok: false, reason: 'session-is-not-alive' };

    const handle = session.group.host?.windowHandle ?? null;
    let result = handle === null
      ? { ok: false, reason: 'no-window-for-session' } as WindowFocusResult
      : await this.focusWindowImpl(handle);

    // A harness row usually has no window of its own inside the session tree;
    // when the OS refused the foreground change, opening the interface lets the
    // browser activate itself instead.
    if (!result.ok && session.group.tool === 'dsh') {
      const fallback = await this.openSessionInterface(session);
      if (fallback.ok) result = fallback;
    }

    await this.record(session, 'user-override', {
      action: 'focus',
      ok: result.ok,
      reason: result.reason ?? null,
    });
    return result;
  }

  private async openSessionInterface(session: RuntimeSession): Promise<WindowFocusResult> {
    if (session.group.tool !== 'dsh') return { ok: false, reason: 'no-window-for-session' };
    const origin = this.dshHosts.get(session.group.rootPid)?.client.origin ?? null;
    if (origin === null) return { ok: false, reason: 'harness-interface-unknown' };
    return await this.openUrlImpl(harnessInterfaceUrl(origin));
  }

  public async inject(
    sessionId: string,
    prompt: string,
    dryRun: boolean,
  ): Promise<RuntimeInjectionResult> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) return { ok: false, error: 'session is not alive' };
    if (dryRun) {
      await this.record(session, 'skip', { reason: 'dry-run', action: 'manual-inject' }, prompt);
      return { ok: true, dryRun: true, prompt };
    }
    const result = await this.writeSession(session, prompt, true);
    if (!result.ok) return { ok: false, prompt, error: result.error };
    await this.record(session, 'injection', { action: 'manual-inject' }, prompt);
    return { ok: true, prompt };
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.poll(); }, Math.max(250, delayMs));
    this.timer.unref?.();
  }

  private async discover(): Promise<readonly DiscoveredProcessSession[]> {
    if (this.platform !== 'win32') return [];
    let records: RawProcessRecord[];
    try {
      records = await this.provider.listProcesses();
    } catch (error) {
      if (this.stopping) return [];
      await this.auditGlobal('transport-error', { reason: `process-discovery: ${errorMessage(error)}` });
      return [];
    }
    try {
      const groups = groupProcesses(records, {
        currentProcessId: this.currentProcessId,
        sameUserOnly: this.currentConfig.processFilters.sameUserOnly,
        harnessHost: this.currentConfig.tools.dsh.enabled
          ? { titleMarkers: DSH_WINDOW_TITLE_MARKERS, label: DSH_WEB_LABEL }
          : null,
      });
      const windows = groups.filter((group) => this.matchesProcessFilters(group));
      return [...windows, ...await this.discoverWsl()];
    } catch (error) {
      await this.auditGlobal('skip', { reason: `process-grouping: ${errorMessage(error)}` });
      return [];
    }
  }

  /**
   * Discover the sessions running inside a WSL distribution.
   *
   * WSL is optional and must never interfere with the Windows sessions, so every failure here is reported as a
   * stated reason and yields no sessions rather than propagating: a stopped distribution, a missing one, or a
   * slow one would otherwise take the whole poll down with it.
   */
  private async discoverWsl(): Promise<readonly DiscoveredProcessSession[]> {
    const distribution = this.currentConfig.wslDistribution?.trim() ?? '';
    if (this.platform !== 'win32' || distribution.length === 0) return [];

    const result = await listWslProcesses({
      distribution,
      ...(this.wslPath === undefined ? {} : { wslPath: this.wslPath }),
    });
    if (result.error !== undefined) {
      // Reported once per poll at most, and only when the state changes, so a stopped distribution does not
      // fill the audit log.
      if (this.lastWslError !== result.error) {
        this.lastWslError = result.error;
        await this.auditGlobal('transport-error', { reason: `wsl-discovery: ${result.error}` });
      }
      return [];
    }
    this.lastWslError = null;

    try {
      const groups = groupProcesses(result.records, {
        distribution,
        currentProcessId: this.currentProcessId,
        sameUserOnly: this.currentConfig.processFilters.sameUserOnly,
      });
      return groups.filter((group) => this.matchesProcessFilters(group));
    } catch (error) {
      await this.auditGlobal('skip', { reason: `wsl-grouping: ${errorMessage(error)}` });
      return [];
    }
  }

  private matchesProcessFilters(group: DiscoveredProcessSession): boolean {
    const include = this.currentConfig.processFilters.include
      .map(normalizeFilter)
      .filter((value): value is string => value !== null);
    const exclude = this.currentConfig.processFilters.exclude
      .map(normalizeFilter)
      .filter((value): value is string => value !== null);
    const haystack = [
      group.tool,
      group.commandLine,
      group.executablePath,
      group.workingDirectory,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
      .toLocaleLowerCase();
    if (exclude.some((value) => haystack.includes(value))) return false;
    return include.length === 0 || include.some((value) => haystack.includes(value));
  }

  private async scanClaudeFiles(): Promise<readonly ClaudeSessionFile[]> {
    try {
      return await scanClaudeSessionFiles(this.claudeProjectsDirectory);
    } catch (error) {
      await this.auditGlobal('skip', { reason: `claude-index: ${errorMessage(error)}` });
      return [];
    }
  }

  private async createSession(
    id: string,
    group: DiscoveredProcessSession,
    timestamp: number,
  ): Promise<RuntimeSession> {
    const config = this.currentConfig;
    const session: RuntimeSession = {
      id,
      startedAtMs: group.creationTimeMs ?? timestamp,
      group,
      engine: this.createEngine(config),
      engineKey: engineKey(config),
      userPaused: false,
      alive: true,
      transport: null,
      validatedTransportKind: null,
      transportKind: 'monitor-only',
      transportError: undefined,
      consoleProcessIds: null,
      transportFingerprint: null,
      probeAttempted: false,
      claudeFile: null,
      claudeActivity: null,
      claudeLeaseSessionId: null,
      codexAdapter: null,
      codexContext: null,
      codexActivity: null,
      dshSession: null,
      dshActivity: null,
      goal: null,
      conversationId: null,
      pendingPrompt: null,
      lastAuditedDecision: null,
    };
    if (group.tool === 'codex') await this.prepareCodex(session, config);
    if (group.tool === 'dsh') this.prepareDsh(session, group);
    this.sessions.set(id, session);
    return session;
  }

  /**
   * The DeepSeek Harness `web` host serves every workspace from one process, so
   * a host PID is not an agent. Each materialized session that is still live
   * becomes its own monitored row keyed by the harness session id, while a
   * host without live sessions stays visible as a single host row.
   */
  private async expandDshSessions(
    groups: readonly DiscoveredProcessSession[],
    timestamp: number,
  ): Promise<readonly DiscoveredProcessSession[]> {
    const hosts = groups.filter((group) => group.tool === 'dsh');
    if (hosts.length === 0) {
      this.dshSessions.clear();
      this.dshHosts.clear();
      return groups;
    }

    const sessions = await this.scanDshSessions();
    if (this.stopping) return groups;
    await this.resolveDshHosts(hosts, timestamp);
    if (this.stopping) return groups;
    const hostStartedAtMs = hosts.reduce<number | null>((oldest, host) => {
      if (host.creationTimeMs === null) return oldest;
      return oldest === null ? host.creationTimeMs : Math.min(oldest, host.creationTimeMs);
    }, null);
    const windowMs = this.currentConfig.tools.dsh.sessionWindowMs;
    const live = sessions.filter((session) => isLiveDshSession(session, {
      nowMs: timestamp,
      windowMs,
      hostStartedAtMs,
    }));

    this.dshSessions = new Map(live.map((session) => [`dsh:${session.sessionId}`, session]));

    const owners = new Map<number, DshSessionFile[]>();
    for (const host of hosts) owners.set(host.rootPid, []);
    for (const session of live) {
      const host = assignDshHost(session, hosts, timestamp);
      owners.get(host.rootPid)?.push(session);
    }

    const expanded: DiscoveredProcessSession[] = [];
    for (const group of groups) {
      if (group.tool !== 'dsh') {
        expanded.push(group);
        continue;
      }
      const hosted = owners.get(group.rootPid) ?? [];
      if (hosted.length === 0) {
        expanded.push(group);
        continue;
      }
      for (const session of hosted) {
        expanded.push(Object.freeze({
          ...group,
          logicalId: `dsh:${session.sessionId}`,
          creationTimeMs: session.createdAtMs ?? group.creationTimeMs,
        }));
      }
    }
    return expanded;
  }

  private async scanDshSessions(): Promise<readonly DshSessionFile[]> {
    try {
      return await scanDshSessions({ homeDirectory: this.dshHomeDirectory });
    } catch (error) {
      await this.auditGlobal('skip', { reason: `dsh-index: ${errorMessage(error)}` });
      return [];
    }
  }

  /**
   * Find and authenticate the harness web host that serves these sessions.
   *
   * The host's listening port is not recorded anywhere readable, so its own
   * loopback sockets are probed for the harness fingerprint. A failed attempt is
   * retried on a cooldown rather than every poll, because the port lookup spawns
   * PowerShell and the answer only changes when the host restarts.
   */
  private async resolveDshHosts(
    hosts: readonly DiscoveredProcessSession[],
    timestamp: number,
  ): Promise<void> {
    const live = new Set(hosts.map((host) => host.rootPid));
    for (const pid of [...this.dshHosts.keys()]) {
      if (!live.has(pid)) this.dshHosts.delete(pid);
    }
    if (!this.currentConfig.tools.dsh.allowApiInput) return;
    // A dry run never writes, so the credential is not read; the origin is still
    // located so the interface can be shown and opened.
    const mayWrite = !this.currentConfig.dryRun;

    for (const host of hosts) {
      let entry = this.dshHosts.get(host.rootPid);
      if (entry === undefined) {
        entry = { client: this.dshHostClientFactory(), attemptedAtMs: null };
        this.dshHosts.set(host.rootPid, entry);
      }
      if (entry.client.origin !== null) continue;
      if (entry.attemptedAtMs !== null && timestamp - entry.attemptedAtMs < DSH_HOST_RETRY_MS) {
        continue;
      }
      entry.attemptedAtMs = timestamp;

      const candidates: string[] = [];
      const configured = process.env.DSH_WEB_URL?.trim();
      if (configured !== undefined && configured.length > 0) candidates.push(configured);
      for (const port of await this.dshPortLister(host.rootPid)) {
        candidates.push(`http://127.0.0.1:${port}`);
      }
      if (this.stopping) return;
      for (const candidate of candidates) {
        const accepted = mayWrite
          ? await entry.client.adopt(candidate)
          : await entry.client.probe(candidate);
        if (accepted) {
          await this.auditGlobal('skip', {
            reason: 'dsh-host-adopted',
            origin: entry.client.origin,
            pid: host.rootPid,
          });
          break;
        }
      }
    }
  }

  /**
   * Decide how one harness session may be written to: the harness session API
   * when this host authenticated and the watchdog is allowed to write, and
   * monitor-only with a precise reason otherwise.
   */
  private configureDshTransport(session: RuntimeSession): void {
    if (session.dshSession === null) {
      session.transport = null;
      session.validatedTransportKind = null;
      session.transportKind = 'monitor-only';
      session.transportError = 'DeepSeek Harness session is no longer live';
      return;
    }

    const reason = !this.currentConfig.tools.dsh.allowApiInput
      ? DSH_INPUT_DISABLED_REASON
      : this.currentConfig.dryRun
        ? DSH_DRY_RUN_REASON
        : null;
    const client = this.dshHosts.get(session.group.rootPid)?.client ?? null;
    if (reason !== null || client === null || client.origin === null) {
      session.transport = null;
      session.validatedTransportKind = null;
      session.transportKind = 'monitor-only';
      session.transportError = reason ?? DSH_API_UNAVAILABLE_REASON;
      return;
    }

    session.transport ??= new DshWebTransport({
      pid: session.group.rootPid,
      sessionId: session.dshSession.sessionId,
      client,
      isIdle: () => session.dshSession?.turnOpen === false,
    });
    session.validatedTransportKind = 'dsh-web';
    session.transportKind = 'dsh-web';
    session.transportError = undefined;
  }

  private prepareDsh(session: RuntimeSession, group: DiscoveredProcessSession): void {
    const logicalId = group.logicalId;
    if (logicalId === undefined) {
      session.transportKind = 'monitor-only';
      session.transportError = 'DeepSeek Harness host has no live session';
      return;
    }
    const found = this.dshSessions.get(logicalId) ?? null;
    session.dshSession = found;
    if (found === null) {
      session.transportKind = 'monitor-only';
      session.transportError = 'DeepSeek Harness session disappeared during discovery';
      return;
    }
    session.conversationId = found.sessionId;
    session.dshActivity = dshSessionActivity(found);
    session.transportKind = 'monitor-only';
    session.transportError = DSH_MONITOR_ONLY_REASON;
  }

  private configureEngine(session: RuntimeSession, config: WatchdogConfig, timestamp: number): void {
    const key = engineKey(config);
    if (session.engineKey === key) return;
    const previous = session.engine.getState(session.id);
    session.engine = this.createEngine(config);
    session.engineKey = key;
    session.engine.observeSession(session.id, previous?.lastActivityAt ?? timestamp, {
      enabled: config.enabled && config.tools[session.group.tool].enabled,
      paused: session.userPaused,
      alive: session.alive,
    });
    if (session.userPaused) session.engine.pause(session.id);
  }

  /**
   * The Codex state paths inside a WSL distribution.
   *
   * Measured: SQLite cannot open a database on `\\wsl.localhost` at all — a copy placed back inside the
   * distribution fails with `database is locked` exactly as the live one does, while the same bytes on local
   * NTFS open and expose all three threads. Windows reads that filesystem over 9P, which does not provide the
   * locking SQLite needs, so the state is **copied to local disk** and read from there. The account's home is
   * resolved from the distribution rather than assumed, because it need not match the Windows user's.
   */
  private async findWslCodexPaths(distribution: string): Promise<CodexPaths | null> {
    if (this.wslCodexPaths !== null) return this.wslCodexPaths;
    const home = this.wslHomeDirectory ?? await this.resolveWslHome(distribution);
    if (home === null) return null;
    this.wslHomeDirectory = home;
    // `/home/han` -> `\\wsl.localhost\Ubuntu-22.04\home\han\.codex`
    const uncCodexHome = `\\\\wsl.localhost\\${distribution}${join(home, '.codex').replaceAll('/', '\\')}`;
    try {
      const snapshot = snapshotWslCodexState({ uncCodexHome });
      if (snapshot === null) return null;
      this.wslStateDirectory = snapshot.directory;
      const paths: CodexPaths = { statePath: snapshot.statePath, goalPath: snapshot.goalPath };
      this.wslCodexPaths = paths;
      return paths;
    } catch (error) {
      this.wslStateError = `could not read the Codex state inside ${distribution}: ${errorMessage(error)}`;
      return null;
    }
  }

  /** The distribution account's home directory, as the distribution itself reports it. */
  private async resolveWslHome(distribution: string): Promise<string | null> {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = nodeSpawn(this.wslPath ?? 'wsl.exe', ['-d', distribution, '--', 'sh', '-c', 'printf %s "$HOME"'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += String(chunk); });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`wsl exited with code ${code}`))));
      });
      const home = stdout.trim();
      return home.startsWith('/') ? home : null;
    } catch {
      // A stopped distribution is an ordinary state; the caller reports it as a missing transport.
      return null;
    }
  }

  private async prepareCodex(session: RuntimeSession, config: WatchdogConfig): Promise<void> {
    // A session inside a WSL distribution uses the state and the transport *inside that distribution*.
    // Measured: the JSON-RPC transport answers through `wsl.exe` exactly as it does on Windows, so this
    // reuses the same client and simply launches it in the distro instead of locally.
    const distribution = session.group.distribution;
    if (distribution !== undefined && distribution.length > 0) {
      const paths = await this.findWslCodexPaths(distribution);
      if (paths === null) {
        session.transportError = `Codex state was not found inside ${distribution}`;
        session.transportKind = 'monitor-only';
        return;
      }
      const launch = await this.resolveWslCodexLaunch(distribution);
      if (launch === null) {
        // The state is readable but nothing can be written: report it as monitor-only rather than pretending
        // the session can be continued.
        session.transportError = `the Codex CLI inside ${distribution} could not be located`;
        session.transportKind = 'monitor-only';
        return;
      }
      try {
        const appServer = this.wslCodexAppServerFactory(distribution);
        session.codexAdapter = new CodexAdapter({
          statePath: paths.statePath,
          goalPath: paths.goalPath,
          normalPrompt: config.tools.codex.normalPrompt,
          goalPrompt: config.tools.codex.goalPrompt,
          goalStatuses: config.tools.codex.goalStatuses,
          appServer,
        });
        session.transportKind = 'monitor-only';
      } catch (error) {
        session.transportError = `Codex state unavailable in ${distribution}: ${errorMessage(error)}`;
      }
      return;
    }

    const paths = await this.findCodexPaths();
    if (paths === null) {
      session.transportError = 'Codex state database was not found';
      return;
    }
    try {
      const appServer = this.codexAppServerFactory();
      session.codexAdapter = new CodexAdapter({
        statePath: paths.statePath,
        goalPath: paths.goalPath,
        normalPrompt: config.tools.codex.normalPrompt,
        goalPrompt: config.tools.codex.goalPrompt,
        goalStatuses: config.tools.codex.goalStatuses,
        appServer,
      });
      session.transportKind = 'monitor-only';
    } catch (error) {
      session.transportError = `Codex state unavailable: ${errorMessage(error)}`;
    }
  }

  /**
   * An app-server client that runs the Codex CLI inside a WSL distribution.
   *
   * Measured: driving `codex app-server` through `wsl.exe` stdio handshakes and answers `thread/list`
   * identically to the Windows one, so the same client speaks to both and only the launch differs. Two
   * details were needed and both were measured: the launcher is a script whose shebang needs `node`, and
   * `wsl.exe -e` supplies no PATH — so an explicit node is resolved inside the distribution and passed.
   */
  private wslCodexAppServerFactory(distribution: string): AppServerClient {
    const wslPath = this.wslPath ?? 'wsl.exe';
    const launch = this.wslCodexLaunch ?? { node: 'node', entry: 'codex' };
    return new AppServerClient({
      command: wslPath,
      args: [
        '-d', distribution,
        '-e', launch.node,
        launch.entry,
        'app-server',
        '--listen', 'stdio://',
      ],
    });
  }

  /**
   * Resolve how to launch the Codex CLI inside a distribution.
   *
   * Measured: `codex` there is a script whose shebang needs `node`, and `wsl.exe -e` supplies no PATH, so a
   * bare `codex` fails with `/usr/bin/env: 'node': No such file or directory`. The launcher's real path and a
   * node beside it are read from the distribution in one probe, so nothing is assumed about where node is
   * installed.
   */
  private async resolveWslCodexLaunch(distribution: string): Promise<{ readonly node: string; readonly entry: string } | null> {
    if (this.wslCodexLaunch !== null) return this.wslCodexLaunch;
    // The distribution reports its own launcher and the node that runs it; `command -v` is not used because
    // PATH inside a login shell resolves `codex` to the Windows install through interop.
    const script = [
      'entry=$(ls -1 "$HOME"/.nvm/versions/node/*/bin/codex 2>/dev/null | tail -1)',
      'if [ -z "$entry" ]; then entry=$(command -v codex 2>/dev/null); fi',
      // The launcher's shebang needs node on PATH; find a node next to it, then any node the distro has.
      'if [ -n "$entry" ]; then',
      '  node=$(ls -1 "$(dirname "$entry")"/node 2>/dev/null | head -1)',
      'fi',
      'if [ -z "$node" ]; then node=$(command -v node 2>/dev/null); fi',
      'if [ -z "$node" ]; then node=$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); fi',
      'printf "%s\\t%s" "$node" "$entry"',
    ].join('\n');
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = nodeSpawn(this.wslPath ?? 'wsl.exe', ['-d', distribution, '--', 'sh', '-s'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += String(chunk); });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`wsl exited with code ${code}`))));
        child.stdin.end(script);
      });
      const [node, entry] = stdout.trim().split('\t');
      if (node === undefined || entry === undefined || node.length === 0 || entry.length === 0) return null;
      const launch = { node, entry };
      this.wslCodexLaunch = launch;
      return launch;
    } catch {
      return null;
    }
  }

  private async updateAssociation(
    session: RuntimeSession,
    claudeFiles: readonly ClaudeSessionFile[],
    timestamp: number,
  ): Promise<void> {
    if (session.group.tool === 'claude') {
      const association = associateClaudeSession({
        pid: session.group.rootPid,
        cwd: session.group.workingDirectory ?? null,
        creationTimeMs: session.group.creationTimeMs ?? timestamp,
        commandLine: session.group.commandLine ?? undefined,
      }, claudeFiles);
      session.conversationId = association.conversationId;
      session.claudeFile = association.sessionPath === null
        ? null
        : claudeFiles.find((file) => file.path === association.sessionPath) ?? null;
      if (session.claudeLeaseSessionId !== null && session.claudeLeaseSessionId !== association.conversationId) {
        await this.clearClaudeLease(session);
      }
      session.claudeLeaseSessionId = association.conversationId;
      if (association.reason !== undefined) session.transportError = association.reason;
      if (session.claudeFile !== null && !session.probeAttempted) {
        session.probeAttempted = true;
        const transport = this.transportFactory?.(session.group) ?? new ConsoleTransport();
        const probe = await transport.probe(session.group.rootPid);
        if (probe.ok) {
          session.transport = transport;
          session.validatedTransportKind = probe.kind;
          session.transportKind = probe.kind;
          session.consoleProcessIds = probe.kind === 'classic-console'
            ? Object.freeze([...(probe.consoleProcessIds ?? [])])
            : null;
          session.transportError = undefined;
        } else {
          session.validatedTransportKind = null;
          session.consoleProcessIds = null;
          session.transportError = probe.error.message;
        }
      }
      await this.refreshClaudeHookCapability(session);
      return;
    }

    if (session.group.tool === 'dsh') {
      const current = session.group.logicalId === undefined
        ? null
        : this.dshSessions.get(session.group.logicalId) ?? null;
      session.dshSession = current;
      session.conversationId = current?.sessionId ?? null;
      this.configureDshTransport(session);
      return;
    }

    if (session.codexAdapter === null) return;
    const context = this.codexContextFor(session, timestamp);
    session.codexContext = context;
    const association = session.codexAdapter.associate(context);
    if (association.kind === 'matched') {
      session.codexActivity = association.activity;
      session.conversationId = association.thread.id;
      session.goal = session.codexAdapter.getGoal(context);
      session.transportKind = 'codex-app-server';
      session.transportError = undefined;
    } else {
      session.codexActivity = null;
      session.conversationId = null;
      session.goal = null;
      session.transportKind = 'monitor-only';
      session.transportError = association.reason;
    }
  }

  private async updateActivity(session: RuntimeSession, timestamp: number): Promise<void> {
    if (session.group.tool === 'claude') {
      const current = session.claudeFile === null ? null : {
        size: session.claudeFile.size,
        mtimeMs: session.claudeFile.mtimeMs,
      };
      if (current !== null && session.claudeActivity !== null && hasClaudeSessionActivity(session.claudeActivity, current)) {
        session.engine.observeOutput(session.id, timestamp);
        await this.record(session, 'activity', { source: 'claude-jsonl' });
      }
      session.claudeActivity = current;
    } else if (session.group.tool === 'dsh') {
      const current = session.dshSession === null ? null : dshSessionActivity(session.dshSession);
      if (
        current !== null &&
        session.dshActivity !== null &&
        hasDshSessionActivity(session.dshActivity, current)
      ) {
        session.engine.observeOutput(session.id, timestamp);
        await this.record(session, 'activity', { source: 'dsh-session' });
      }
      session.dshActivity = current;
    } else if (session.codexActivity !== null) {
      try {
        const snapshot = await session.codexActivity.snapshot();
        if (snapshot.changed) {
          session.engine.observeOutput(session.id, timestamp);
          await this.record(session, 'activity', { source: 'codex-rollout' });
        }
      } catch (error) {
        session.transportError = errorMessage(error);
      }
    }
    await this.updateTransportActivity(session, timestamp);
  }

  private resolveConsoleCollisions(): void {
    const aliveSessions = [...this.sessions.values()].filter((session) => session.alive);
    for (const session of aliveSessions) {
      if (session.transportError === SHARED_CONSOLE_ERROR) session.transportError = undefined;
      if (session.validatedTransportKind !== null) session.transportKind = session.validatedTransportKind;
    }

    const byRootPid = new Map(aliveSessions.map((session) => [session.group.rootPid, session]));
    const collided = new Set<RuntimeSession>();
    for (const session of aliveSessions) {
      if (session.validatedTransportKind !== 'classic-console' || session.consoleProcessIds === null) continue;
      const roots = session.consoleProcessIds
        .map((pid) => byRootPid.get(pid))
        .filter((candidate): candidate is RuntimeSession => candidate !== undefined);
      if (roots.length > 1) roots.forEach((candidate) => collided.add(candidate));
    }
    for (const session of collided) {
      session.transportKind = 'cannot-inject';
      session.transportError = SHARED_CONSOLE_ERROR;
    }
  }

  private async updateTransportActivity(session: RuntimeSession, timestamp: number): Promise<void> {
    if (session.transport === null || session.validatedTransportKind === null) return;
    if (session.transportError === SHARED_CONSOLE_ERROR) return;
    const result = await session.transport.activityFingerprint(session.group.rootPid);
    if (!result.ok) {
      session.transportKind = 'cannot-inject';
      session.transportError = result.error.message;
      await this.record(session, 'transport-error', { reason: `activity-fingerprint: ${result.error.message}` });
      return;
    }
    const previous = session.transportFingerprint;
    session.transportFingerprint = result.fingerprint;
    session.validatedTransportKind = result.kind;
    session.transportKind = result.kind;
    session.transportError = undefined;
    if (previous !== null && previous !== result.fingerprint) {
      session.engine.observeOutput(session.id, timestamp);
      await this.record(session, 'activity', { source: result.kind });
    }
  }

  private async injectAutomatic(session: RuntimeSession, timestamp: number): Promise<void> {
    let prompt: string;
    if (session.group.tool === 'codex') {
      if (session.codexAdapter === null || session.codexContext === null) {
        session.engine.recordTransportError(session.id, timestamp);
        await this.record(session, 'skip', { reason: session.transportError ?? 'codex-association-missing' });
        return;
      }
      const decision = await session.codexAdapter.getContinuation(session.codexContext);
      if (decision.kind === 'skip') {
        session.engine.recordTransportError(session.id, timestamp);
        await this.record(session, 'skip', { reason: decision.reason });
        return;
      }
      prompt = decision.prompt;
      session.goal = decision.goal;
      session.conversationId = decision.threadId;
    } else if (session.group.tool === 'dsh') {
      // A session with an unfinished step is never interrupted: the harness
      // would queue the text behind a running agent, and a continuation is only
      // meaningful once the agent has actually stopped.
      if (session.dshSession === null || session.dshSession.turnOpen) {
        session.engine.recordTransportError(session.id, timestamp);
        await this.record(session, 'skip', {
          reason: session.dshSession === null ? 'harness-session-gone' : 'harness-step-running',
        });
        return;
      }
      prompt = this.currentConfig.tools.dsh.normalPrompt;
    } else {
      prompt = this.currentConfig.tools.claude.normalPrompt;
    }
    session.pendingPrompt = prompt;
    try {
      if (this.currentConfig.dryRun) {
        session.engine.recordInjectionSuccess(session.id, timestamp);
        await this.record(session, 'skip', { reason: 'dry-run', action: 'automatic-inject' }, prompt);
        return;
      }

      const result = await this.writeSession(session, prompt);
      if (result.ok) {
        session.engine.recordInjectionSuccess(session.id, timestamp);
        await this.record(session, 'injection', { action: 'automatic-inject' }, prompt);
      } else {
        session.engine.recordTransportError(session.id, timestamp);
        session.transportError = result.error;
        await this.record(session, 'transport-error', { reason: result.error ?? 'write-failed' });
      }
    } finally {
      session.pendingPrompt = null;
    }
  }

  private async writeSession(
    session: RuntimeSession,
    prompt: string,
    explicitPrompt = false,
  ): Promise<WriteResultLike> {
    if (session.group.tool === 'codex') {
      if (session.codexAdapter === null || session.codexContext === null) return { ok: false, error: 'Codex App Server is unavailable' };
      try {
        const result = explicitPrompt
          ? await session.codexAdapter.injectPrompt(session.codexContext, prompt)
          : await session.codexAdapter.injectContinuation(session.codexContext);
        return result.kind === 'inject'
          ? { ok: true }
          : { ok: false, error: result.reason };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    if (session.group.tool === 'dsh') {
      if (session.transport === null || session.transportKind !== 'dsh-web') {
        return { ok: false, error: session.transportError ?? DSH_MONITOR_ONLY_REASON };
      }
      const result = await session.transport.write(session.group.rootPid, prompt);
      return result.ok ? { ok: true } : { ok: false, error: result.error.message };
    }
    if (session.transportKind === 'claude-stop-hook') {
      return this.armClaudeLease(session, prompt);
    }
    if (session.transport === null || (session.transportKind !== 'classic-console' && session.transportKind !== 'pty')) {
      return { ok: false, error: session.transportError ?? 'no trusted transport' };
    }
    const result = await session.transport.write(session.group.rootPid, prompt);
    return result.ok ? { ok: true } : { ok: false, error: result.error.message };
  }

  private async armClaudeLease(session: RuntimeSession, prompt: string): Promise<WriteResultLike> {
    const operation = this.performClaudeLeaseArm(session, prompt);
    this.activeClaudeLeaseWrites.add(operation);
    try {
      return await operation;
    } finally {
      this.activeClaudeLeaseWrites.delete(operation);
    }
  }

  private async refreshClaudeHookCapability(session: RuntimeSession): Promise<void> {
    if (session.group.tool !== 'claude' || session.claudeFile === null || session.conversationId === null) return;
    if (session.validatedTransportKind !== null && !['cannot-inject', 'monitor-only'].includes(session.transportKind)) {
      return;
    }
    if (!this.currentConfig.dryRun && this.claudeConfigEnabled() && await this.hookIsInstalled()) {
      session.transportKind = 'claude-stop-hook';
      session.transportError = undefined;
    } else if (session.transportKind === 'claude-stop-hook') {
      session.transportKind = 'monitor-only';
    }
  }

  private async performClaudeLeaseArm(session: RuntimeSession, prompt: string): Promise<WriteResultLike> {
    if (this.claudeLeaseStore === undefined || !this.claudeConfigEnabled() || !(await this.hookIsInstalled())) {
      return { ok: false, error: 'Claude Stop Hook is unavailable' };
    }
    if (this.stopping || session.userPaused || !session.alive || session.transportKind !== 'claude-stop-hook') {
      return { ok: false, error: 'Claude session is not eligible for Hook continuation' };
    }
    if (session.conversationId === null || session.claudeFile === null || session.claudeActivity === null ||
        session.group.workingDirectory === null || session.group.workingDirectory === undefined ||
        session.group.creationTimeMs === null) {
      return { ok: false, error: 'Claude session identity is incomplete' };
    }
    try {
      await this.claudeLeaseStore.arm({
        sessionId: session.conversationId,
        cwd: session.group.workingDirectory,
        prompt,
        rootPid: session.group.rootPid,
        processStartedAtMs: session.group.creationTimeMs,
        activity: session.claudeActivity,
        transcriptPath: session.claudeFile.path,
        ttlMs: this.currentConfig.tools.claude.stopHook.leaseTtlMs,
      });
      if (this.stopping || session.userPaused || !session.alive || !this.claudeConfigEnabled() ||
          session.transportKind !== 'claude-stop-hook' || !(await this.hookIsInstalled())) {
        await this.claudeLeaseStore.clearSession(session.conversationId);
        return { ok: false, error: 'Claude session became ineligible during Hook continuation' };
      }
      session.claudeLeaseSessionId = session.conversationId;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private claudeConfigEnabled(): boolean {
    return this.currentConfig.enabled && this.currentConfig.tools.claude.enabled &&
      this.currentConfig.tools.claude.stopHook.enabled && this.claudeLeaseStore !== undefined;
  }

  private async hookIsInstalled(): Promise<boolean> {
    try {
      return await this.claudeHookInstalled();
    } catch {
      return false;
    }
  }

  private async clearClaudeLease(session: RuntimeSession): Promise<void> {
    await this.waitForClaudeLeaseWrites();
    const sessionId = session.claudeLeaseSessionId ??
      (session.group.tool === 'claude' ? session.conversationId : null);
    if (sessionId !== null) await this.claudeLeaseStore?.clearSession(sessionId);
    session.claudeLeaseSessionId = null;
  }

  private async waitForClaudeLeaseWrites(): Promise<void> {
    if (this.activeClaudeLeaseWrites.size === 0) return;
    await Promise.allSettled([...this.activeClaudeLeaseWrites]);
  }

  private codexContextFor(session: RuntimeSession, timestamp: number): CodexContinuationContext {
    return {
      commandLine: session.group.commandLine ?? '',
      cwd: session.group.workingDirectory ?? null,
      creationTimeMs: session.group.creationTimeMs ?? timestamp,
    };
  }

  private createEngine(config: WatchdogConfig): WatchdogEngine {
    return new WatchdogEngine({
      idleTimeoutMs: config.defaultIdleTimeoutMs,
      cooldownMs: config.defaultCooldownMs,
      maxAttemptsPerQuietPeriod: config.maxAttemptsPerQuietPeriod,
    });
  }

  private toView(session: RuntimeSession): RuntimeSessionView {
    const state = session.engine.getState(session.id);
    const lastActivityAtMs = state?.lastActivityAt ?? null;
    return Object.freeze({
      id: session.id,
      tool: session.group.tool as ToolName,
      rootPid: session.group.rootPid,
      childPids: Object.freeze([...session.group.childPids]),
      conversationId: session.conversationId,
      goal: session.goal,
      transport: session.transportKind,
      alive: session.alive,
      enabled: state?.enabled ?? false,
      paused: state?.paused ?? session.userPaused,
      startedAtMs: session.startedAtMs,
      lastActivityAtMs,
      quietForMs: lastActivityAtMs === null ? null : Math.max(0, this.now() - lastActivityAtMs),
      pendingPrompt: session.pendingPrompt,
      lastDecision: state?.lastDecision ?? 'new',
      ...(session.group.tool === 'dsh' ? {
        sessionCwd: session.dshSession?.cwd ?? null,
        runningTurn: session.dshSession?.turnOpen ?? false,
      } : {}),
      host: session.group.host ?? null,
      ...(session.transportError === undefined ? {} : { transportError: session.transportError }),
    });
  }

  private async auditDecision(session: RuntimeSession, timestamp: number): Promise<void> {
    const state = session.engine.getState(session.id);
    if (state === null || state.lastDecision === session.lastAuditedDecision) return;
    session.lastAuditedDecision = state.lastDecision;
    await this.record(session, 'decision', { decision: state.lastDecision, atMs: timestamp });
  }

  private async record(
    session: RuntimeSession,
    type: 'activity' | 'decision' | 'injection' | 'skip' | 'transport-error' | 'user-override' | 'process-exited',
    details: Record<string, string | number | boolean | null>,
    prompt?: string,
  ): Promise<void> {
    const event = await this.auditStore.append({
      timestampMs: this.now(),
      type: type === 'process-exited' ? 'skip' : type,
      sessionId: session.id,
      tool: session.group.tool,
      prompt,
      details,
    });
    this.publish?.('audit', event);
  }

  private async auditGlobal(
    type: 'skip' | 'transport-error',
    details: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const event = await this.auditStore.append({ timestampMs: this.now(), type, details });
    this.publish?.('audit', event);
  }

  private async findCodexPaths(): Promise<CodexPaths | null> {
    if (this.codexStatePath !== undefined) {
      return { statePath: this.codexStatePath, goalPath: this.codexGoalPath ?? this.codexStatePath };
    }
    if (this.codexPathsPromise === null) this.codexPathsPromise = discoverCodexPaths();
    return this.codexPathsPromise;
  }
}

interface CodexPaths {
  readonly statePath: string;
  readonly goalPath: string;
}

interface WriteResultLike {
  readonly ok: boolean;
  readonly error?: string;
}

function engineKey(config: WatchdogConfig): string {
  return [config.defaultIdleTimeoutMs, config.defaultCooldownMs, config.maxAttemptsPerQuietPeriod].join(':');
}

/**
 * A hosted session keeps its harness identity; a process keeps its root PID.
 *
 * A session inside a WSL distribution carries the distribution as well, because a Linux pid lives in its own
 * namespace: WSL pid 98051 and Windows pid 98051 are unrelated processes, and without the prefix a WSL
 * session could collide with a Windows one — the same key for two different things, which would make the
 * watchdog act on the wrong process.
 */
function sessionIdFor(group: DiscoveredProcessSession): string {
  if (group.logicalId !== undefined) return group.logicalId;
  if (group.distribution !== undefined && group.distribution.length > 0) {
    return `wsl:${group.distribution}:${group.tool}:${group.rootPid}`;
  }
  return `${group.tool}:${group.rootPid}`;
}

/**
 * Attribute a hosted session to the newest host that was already running when
 * the harness last recorded activity for it, falling back to the newest host.
 */
function assignDshHost(
  session: DshSessionFile,
  hosts: readonly DiscoveredProcessSession[],
  timestamp: number,
): DiscoveredProcessSession {
  const recorded = [session.transcriptMtimeMs, session.projectionMtimeMs]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const activityMs = recorded.length === 0 ? timestamp : Math.max(...recorded);
  let candidate: DiscoveredProcessSession | null = null;
  for (const host of hosts) {
    const startedAtMs = host.creationTimeMs ?? timestamp;
    if (startedAtMs > activityMs) continue;
    if (candidate === null || startedAtMs > (candidate.creationTimeMs ?? timestamp)) candidate = host;
  }
  return candidate ?? (hosts[hosts.length - 1] as DiscoveredProcessSession);
}

function defaultDshHome(): string {
  const configured = process.env.DSH_HOME;
  return configured !== undefined && configured.trim().length > 0
    ? configured
    : DEFAULT_DSH_HOME;
}

/**
 * The harness WebUI keeps the selected session in its own client state and
 * documents no session deep link, so the interface is opened at its root rather
 * than with a query the harness would ignore.
 */
function harnessInterfaceUrl(origin: string): string {
  return origin;
}

function processIdentityChanged(
  previous: DiscoveredProcessSession,
  current: DiscoveredProcessSession,
): boolean {
  return previous.creationTimeMs !== null && current.creationTimeMs !== null &&
    previous.creationTimeMs !== current.creationTimeMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeFilter(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase();
  return normalized.length === 0 ? null : normalized;
}

/**
 * Find the Codex state files under a given Codex home, which may be a UNC path into a distribution.
 *
 * Extracted from the Windows case so both share the same selection rules: newest `state_*.sqlite`, newest
 * `goals_*.sqlite` when present.
 */
async function discoverCodexPathsUnder(home: string): Promise<CodexPaths | null> {
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return null;
  }
  const pick = async (pattern: RegExp): Promise<string | null> => {
    for (const name of entries.filter((entry) => pattern.test(entry)).sort().reverse()) {
      try {
        await access(join(home, name));
        return name;
      } catch {
        // Continue to the next candidate.
      }
    }
    return null;
  };
  const state = await pick(/^state(?:_\d+)?\.sqlite$/iu);
  if (state === null) return null;
  const goal = await pick(/^goals?(?:_\d+)?\.sqlite$/iu);
  return { statePath: join(home, state), goalPath: join(home, goal ?? state) };
}

async function discoverCodexPaths(): Promise<CodexPaths | null> {
  return discoverCodexPathsUnder(DEFAULT_CODEX_HOME);
}
