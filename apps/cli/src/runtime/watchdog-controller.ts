import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CodexAdapter, type CodexContinuationContext } from '../codex/codex-adapter.js';
import { AppServerClient } from '../codex/app-server.js';
import { ClaudeLeaseStore } from '../claude/lease-store.js';
import {
  associateClaudeSession,
  hasClaudeSessionActivity,
  scanClaudeSessionFiles,
  type ClaudeSessionFile,
} from '../association/claude.js';
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
import {
  WindowsProcessProvider,
  type ProcessProvider,
  type RawProcessRecord,
} from '../process/process-provider.js';
import { ConsoleTransport } from '../transport/console-bridge.js';
import type {
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
  readonly claudeProjectsDirectory?: string;
  readonly codexStatePath?: string;
  readonly codexGoalPath?: string;
  readonly codexAppServerFactory?: () => AppServerClient;
  readonly transportFactory?: (session: DiscoveredProcessSession) => SessionTransport | null;
  readonly claudeLeaseStore?: ClaudeLeaseStore;
  readonly claudeHookInstalled?: () => boolean | Promise<boolean>;
}

export interface RuntimeSessionView extends SessionSnapshot {
  readonly quietForMs: number | null;
  readonly pendingPrompt: string | null;
  readonly lastDecision: string;
  readonly transportError?: string;
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
  validatedTransportKind: Extract<TransportKind, 'classic-console' | 'pty'> | null;
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
  goal: GoalSnapshot | null;
  conversationId: string | null;
  pendingPrompt: string | null;
  lastAuditedDecision: string | null;
}

const DEFAULT_CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const SHARED_CONSOLE_ERROR = 'shared classic Console contains multiple discovered CLI sessions';

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
  private readonly claudeProjectsDirectory: string;
  private readonly codexStatePath?: string;
  private readonly codexGoalPath?: string;
  private readonly codexAppServerFactory: () => AppServerClient;
  private readonly transportFactory?: (session: DiscoveredProcessSession) => SessionTransport | null;
  private readonly claudeLeaseStore?: ClaudeLeaseStore;
  private readonly claudeHookInstalled: () => boolean | Promise<boolean>;
  private readonly activeClaudeLeaseWrites = new Set<Promise<WriteResultLike>>();
  private readonly sessions = new Map<string, RuntimeSession>();
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
    this.provider = options.provider ?? new WindowsProcessProvider();
    this.publish = options.publish;
    this.now = options.now ?? Date.now;
    this.currentProcessId = options.currentProcessId ?? process.pid;
    this.platform = options.platform ?? process.platform;
    this.claudeProjectsDirectory = options.claudeProjectsDirectory ?? DEFAULT_CLAUDE_PROJECTS;
    this.codexStatePath = options.codexStatePath;
    this.codexGoalPath = options.codexGoalPath;
    this.codexAppServerFactory = options.codexAppServerFactory ?? (() => new AppServerClient());
    this.transportFactory = options.transportFactory;
    this.claudeLeaseStore = options.claudeLeaseStore;
    this.claudeHookInstalled = options.claudeHookInstalled ?? (() => false);
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
      const groups = await this.discover();
      if (this.stopping) return;
      const claudeFiles = groups.some((group) => group.tool === 'claude')
        ? await this.scanClaudeFiles()
        : [];
      if (this.stopping) return;
      const seen = new Set<string>();

      for (const group of groups) {
        const id = `${group.tool}:${group.rootPid}`;
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
      });
      return groups.filter((group) => this.matchesProcessFilters(group));
    } catch (error) {
      await this.auditGlobal('skip', { reason: `process-grouping: ${errorMessage(error)}` });
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
      goal: null,
      conversationId: null,
      pendingPrompt: null,
      lastAuditedDecision: null,
    };
    if (group.tool === 'codex') await this.prepareCodex(session, config);
    this.sessions.set(id, session);
    return session;
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

  private async prepareCodex(session: RuntimeSession, config: WatchdogConfig): Promise<void> {
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
    if (session.transportKind === 'claude-stop-hook') {
      return this.armClaudeLease(session, prompt);
    }
    if (session.transport === null || !['classic-console', 'pty'].includes(session.transportKind)) {
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

async function discoverCodexPaths(): Promise<CodexPaths | null> {
  let entries: string[];
  try {
    entries = await readdir(DEFAULT_CODEX_HOME);
  } catch {
    return null;
  }
  const state = await newestExisting(entries.filter((entry) => /^state(?:_\d+)?\.sqlite$/iu.test(entry)));
  if (state === null) return null;
  const goal = await newestExisting(entries.filter((entry) => /^goals?(?:_\d+)?\.sqlite$/iu.test(entry)));
  return { statePath: join(DEFAULT_CODEX_HOME, state), goalPath: join(DEFAULT_CODEX_HOME, goal ?? state) };
}

async function newestExisting(names: readonly string[]): Promise<string | null> {
  for (const name of [...names].sort().reverse()) {
    const path = join(DEFAULT_CODEX_HOME, name);
    try {
      await access(path);
      return name;
    } catch {
      // Continue to the next candidate.
    }
  }
  return null;
}
