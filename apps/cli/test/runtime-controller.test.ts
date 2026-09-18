import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { defaultConfig } from '../src/domain/config.js';
import { DshHostClient } from '../src/dsh/web-host.js';
import { ClaudeLeaseStore } from '../src/claude/lease-store.js';
import type { ClaudeContinuationLease, ClaudeLeaseRequest } from '../src/claude/lease-store.js';
import { AppServerClient } from '../src/codex/app-server.js';
import { WatchdogController } from '../src/runtime/watchdog-controller.js';
import { AuditStore } from '../src/store/audit-store.js';
import { ConfigStore } from '../src/store/config-store.js';
import type { ProcessProvider, RawProcessRecord } from '../src/process/process-provider.js';
import type { DiscoveredProcessSession } from '../src/process/discovery.js';
import type { SessionTransport } from '../src/transport/transport.js';

class FixtureProvider implements ProcessProvider {
  public constructor(private readonly records: RawProcessRecord[]) {}
  public async listProcesses(): Promise<RawProcessRecord[]> { return this.records; }
}

class MutableFixtureProvider implements ProcessProvider {
  public constructor(public records: RawProcessRecord[]) {}
  public async listProcesses(): Promise<RawProcessRecord[]> { return this.records; }
}

class BlockingFixtureProvider implements ProcessProvider {
  private release!: () => void;
  private markStarted!: () => void;
  public readonly started = new Promise<void>((resolveStarted) => { this.markStarted = resolveStarted; });
  private readonly released = new Promise<void>((resolveReleased) => { this.release = resolveReleased; });

  public async listProcesses(): Promise<RawProcessRecord[]> {
    this.markStarted();
    await this.released;
    return [];
  }

  public continue(): void {
    this.release();
  }
}

class FixtureTransport implements SessionTransport {
  public writes: string[] = [];
  public async probe(pid: number) { return { ok: true as const, kind: 'classic-console' as const, pid, consoleProcessIds: [pid] }; }
  public async activityFingerprint(pid: number) { return { ok: true as const, kind: 'classic-console' as const, pid, fingerprint: 'stable' }; }
  public async write(pid: number, text: string) { this.writes.push(`${pid}:${text}`); return { ok: true as const, kind: 'classic-console' as const, pid, recordsWritten: 2 }; }
}

class ConsoleFixtureTransport extends FixtureTransport {
  public fingerprint = 'initial';

  public constructor(private readonly consoleProcessIds: readonly number[]) {
    super();
  }

  public override async probe(pid: number) {
    return { ok: true as const, kind: 'classic-console' as const, pid, consoleProcessIds: [...this.consoleProcessIds] };
  }

  public override async activityFingerprint(pid: number) {
    return { ok: true as const, kind: 'classic-console' as const, pid, fingerprint: this.fingerprint };
  }
}

class ThrowingTransport extends FixtureTransport {
  public override async probe(pid: number) {
    if (pid === 100) throw new Error('fixture attach failed');
    return super.probe(pid);
  }
}

class FailingActivityTransport implements SessionTransport {
  public writes: string[] = [];
  private activityCalls = 0;

  public async probe(pid: number) {
    return { ok: true as const, kind: 'classic-console' as const, pid, consoleProcessIds: [pid] };
  }

  public async activityFingerprint(pid: number) {
    this.activityCalls += 1;
    if (this.activityCalls === 1) {
      return { ok: true as const, kind: 'classic-console' as const, pid, fingerprint: 'stable' };
    }
    return {
      ok: false as const,
      kind: 'cannot-inject' as const,
      pid,
      error: { code: 'attach-failed', message: 'fixture Console detached' },
    };
  }

  public async write(pid: number, text: string) {
    this.writes.push(`${pid}:${text}`);
    return { ok: true as const, kind: 'classic-console' as const, pid, recordsWritten: 2 };
  }
}

class CannotInjectFixtureTransport implements SessionTransport {
  public async probe(pid: number) {
    return {
      ok: false as const,
      kind: 'cannot-inject' as const,
      pid,
      error: { code: 'attach-failed', message: 'fixture Console is not trusted' },
    };
  }

  public async activityFingerprint(pid: number) {
    return {
      ok: false as const,
      kind: 'cannot-inject' as const,
      pid,
      error: { code: 'attach-failed', message: 'fixture Console is not trusted' },
    };
  }

  public async write(pid: number, _text: string) {
    return {
      ok: false as const,
      kind: 'cannot-inject' as const,
      pid,
      error: { code: 'attach-failed', message: 'fixture Console is not trusted' },
    };
  }
}

class DelayedClaudeLeaseStore extends ClaudeLeaseStore {
  private releaseArm!: () => void;
  private markArmStarted!: () => void;
  public readonly armStarted = new Promise<void>((resolveStarted) => {
    this.markArmStarted = resolveStarted;
  });
  private readonly armReleased = new Promise<void>((resolveArm) => {
    this.releaseArm = resolveArm;
  });

  public override async arm(request: ClaudeLeaseRequest): Promise<ClaudeContinuationLease> {
    this.markArmStarted();
    await this.armReleased;
    return super.arm(request);
  }

  public continueArm(): void {
    this.releaseArm();
  }
}

async function createCodexState(
  root: string,
  threadId: string,
  cwd: string,
  goalStatus: 'active' | 'complete',
): Promise<{ statePath: string; goalPath: string }> {
  const { DatabaseSync } = await import('node:sqlite');
  const statePath = join(root, 'state.sqlite');
  const goalPath = join(root, 'goals.sqlite');
  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      rollout_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
  `);
  state.prepare('INSERT INTO threads (id, cwd, rollout_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(threadId, cwd, null, 1_000, 2_000);
  state.close();
  const goals = new DatabaseSync(goalPath);
  goals.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at_ms INTEGER
    );
  `);
  goals.prepare('INSERT INTO thread_goals (thread_id, status, updated_at_ms) VALUES (?, ?, ?)')
    .run(threadId, goalStatus, 2_500);
  goals.close();
  return { statePath, goalPath };
}

test('reports the timestamp of the most recently completed poll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-status-'));
  let clock = 12_345;
  const controller = new WatchdogController({
    configStore: new ConfigStore(join(root, 'config.json')),
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([]),
    platform: 'win32',
    currentProcessId: 50,
    now: () => clock,
  });
  try {
    assert.deepEqual(controller.status(), { lastPollAtMs: null });
    await controller.poll();
    assert.deepEqual(controller.status(), { lastPollAtMs: 12_345 });

    clock = 67_890;
    await controller.poll();
    assert.deepEqual(controller.status(), { lastPollAtMs: 67_890 });
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('quiesce does not wait for a slow read-only process discovery poll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-quiesce-'));
  const provider = new BlockingFixtureProvider();
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  const controller = new WatchdogController({
    configStore: new ConfigStore(join(root, 'config.json')),
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider,
    platform: 'win32',
    currentProcessId: 50,
    claudeLeaseStore: leaseStore,
  });
  const poll = controller.poll();
  try {
    await provider.started;
    await Promise.race([
      controller.quiesce(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('quiesce waited for discovery')), 250)),
    ]);
    assert.deepEqual(await leaseStore.list(), []);
  } finally {
    provider.continue();
    await poll;
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('polls independent Claude processes and records a dry-run quiet-period decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-'));
  const projects = join(root, 'projects');
  await mkdir(join(projects, 'project'), { recursive: true });
  const cwd = process.cwd();
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'project', 'session.jsonl'), `${JSON.stringify({ cwd, sessionId: 'claude-session-1' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    dryRun: true,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
  });
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 101, parentPid: 100, name: 'node.exe', commandLine: 'node claude-code', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
  ];
  const transport = new FixtureTransport();
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    now: () => clock,
    transportFactory: (_session: DiscoveredProcessSession) => transport,
  });
  try {
    await controller.start();
    const initial = await controller.list();
    assert.equal(initial.length, 1);
    assert.equal(initial[0]?.transport, 'classic-console');
    assert.equal(initial[0]?.conversationId, 'claude-session-1');

    clock += 1_000;
    await controller.poll();
    assert.deepEqual(transport.writes, []);
    const events = await auditStore.list();
    assert.ok(events.some((event) => event.type === 'skip' && event.details?.reason === 'dry-run'));
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('arms an exact Claude Stop Hook lease when no trusted direct transport exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  const transcript = join(projects, 'project', 'session.jsonl');
  await writeFile(transcript, `${JSON.stringify({ cwd, sessionId: 'hook-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: {
        ...defaultConfig.tools.claude,
        stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true },
      },
    },
  });
  const leaseStore = new ClaudeLeaseStore(join(root, 'state', 'claude-leases.json'));
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
  ];
  const provider = new MutableFixtureProvider(records);
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider,
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => clock,
    transportFactory: () => new CannotInjectFixtureTransport(),
  });
  try {
    await controller.poll();
    clock += 1_000;
    await controller.poll();

    const session = (await controller.list())[0];
    assert.equal(session?.transport, 'claude-stop-hook');
    assert.equal(session?.transportError, undefined);
    const transcriptStat = await stat(transcript);
    const lease = await leaseStore.consume({
      sessionId: 'hook-session',
      cwd,
      processStartedAtMs: processCreatedAt,
      transcriptPath: transcript,
      activity: { size: transcriptStat.size, mtimeMs: transcriptStat.mtimeMs },
    });
    assert.equal(lease?.prompt, defaultConfig.tools.claude.normalPrompt);
    assert.equal(lease?.rootPid, 100);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps direct transport precedence over Claude Hook leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-precedence-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'project', 'session.jsonl'), `${JSON.stringify({ cwd, sessionId: 'direct-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
  ];
  const transport = new FixtureTransport();
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => clock,
    transportFactory: () => transport,
  });
  try {
    await controller.poll();
    clock += 1_000;
    await controller.poll();
    assert.equal((await controller.list())[0]?.transport, 'classic-console');
    assert.deepEqual(transport.writes, [`100:${defaultConfig.tools.claude.normalPrompt}`]);
    assert.deepEqual(await leaseStore.list(), []);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to a Claude Hook lease after a validated Console detaches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-fallback-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'project', 'session.jsonl'), `${JSON.stringify({ cwd, sessionId: 'fallback-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  const transport = new FailingActivityTransport();
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
      { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    ]),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => clock,
    transportFactory: () => transport,
  });
  try {
    await controller.poll();
    clock += 1_000;
    await controller.poll();

    assert.equal((await controller.list())[0]?.transport, 'claude-stop-hook');
    assert.equal((await leaseStore.list()).length, 1);
    assert.deepEqual(transport.writes, []);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not arm Claude Hook leases in dry-run mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-dry-run-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'project', 'session.jsonl'), `${JSON.stringify({ cwd, sessionId: 'dry-run-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    dryRun: true,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
      { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    ]),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => clock,
    transportFactory: () => new CannotInjectFixtureTransport(),
  });
  try {
    await controller.poll();
    clock += 1_000;
    await controller.poll();
    assert.deepEqual(await leaseStore.list(), []);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('manual Claude injection arms the same exact Hook lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-manual-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  const transcript = join(projects, 'project', 'session.jsonl');
  await writeFile(transcript, `${JSON.stringify({ cwd, sessionId: 'manual-hook-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
      { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    ]),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => processCreatedAt,
    transportFactory: () => new CannotInjectFixtureTransport(),
  });
  try {
    await controller.poll();
    assert.deepEqual(await controller.inject('claude:100', '手动继续', false), { ok: true, prompt: '手动继续' });
    const activity = await stat(transcript);
    const lease = await leaseStore.consume({
      sessionId: 'manual-hook-session',
      cwd,
      processStartedAtMs: processCreatedAt,
      transcriptPath: transcript,
      activity: { size: activity.size, mtimeMs: activity.mtimeMs },
    });
    assert.equal(lease?.prompt, '手动继续');
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not arm a hook lease for an ambiguous Claude association', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-ambiguous-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  const metadata = JSON.stringify({ cwd });
  await writeFile(join(projects, 'project', 'first.jsonl'), `${metadata}\n`, 'utf8');
  await writeFile(join(projects, 'project', 'second.jsonl'), `${metadata}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
      { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    ]),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => processCreatedAt + 1_000,
    transportFactory: () => new CannotInjectFixtureTransport(),
  });
  try {
    await controller.poll();
    assert.equal((await controller.list())[0]?.conversationId, null);
    assert.deepEqual(await leaseStore.list(), []);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('clears Claude Hook leases when paused, exited, disabled, or stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-clear-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  const transcript = join(projects, 'project', 'session.jsonl');
  await writeFile(transcript, `${JSON.stringify({ cwd, sessionId: 'clear-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  const seedLease = async () => {
    const activity = await stat(transcript);
    await leaseStore.arm({
      sessionId: 'clear-session',
      cwd,
      prompt: defaultConfig.tools.claude.normalPrompt,
      rootPid: 100,
      processStartedAtMs: processCreatedAt,
      activity: { size: activity.size, mtimeMs: activity.mtimeMs },
      transcriptPath: transcript,
      ttlMs: 15_000,
    });
  };
  const provider = new MutableFixtureProvider([
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
  ]);
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider,
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => clock,
    transportFactory: () => new CannotInjectFixtureTransport(),
  });
  try {
    await controller.poll();
    clock += 1_000;
    await controller.poll();
    assert.equal((await leaseStore.list()).length, 1);

    assert.equal(await controller.pause('claude:100'), true);
    assert.deepEqual(await leaseStore.list(), []);

    await seedLease();
    assert.equal((await leaseStore.list()).length, 1);

    provider.records = [provider.records[0]!];
    await controller.poll();
    assert.deepEqual(await leaseStore.list(), []);

    provider.records = [
      provider.records[0]!,
      { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    ];
    await controller.poll();
    await seedLease();
    assert.equal((await leaseStore.list()).length, 1);
    const disabled = await configStore.save({
      ...defaultConfig,
      tools: { ...defaultConfig.tools, claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: false } } },
    });
    await controller.configChanged(disabled);
    assert.deepEqual(await leaseStore.list(), []);

    await seedLease();
    await controller.stop();
    assert.deepEqual(await leaseStore.list(), []);
  } finally {
    await controller.stop();
    assert.deepEqual(await leaseStore.list(), []);
    await rm(root, { recursive: true, force: true });
  }
});

test('pause waits for an in-flight poll before clearing its Claude Hook lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-race-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'project', 'session.jsonl'), `${JSON.stringify({ cwd, sessionId: 'race-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const leaseStore = new DelayedClaudeLeaseStore(join(root, 'claude-leases.json'));
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
      { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    ]),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => clock,
    transportFactory: () => new CannotInjectFixtureTransport(),
  });
  try {
    await controller.poll();
    clock += 1_000;
    const poll = controller.poll();
    await leaseStore.armStarted;
    const pause = controller.pause('claude:100');
    leaseStore.continueArm();
    assert.equal(await pause, true);
    await poll;
    assert.deepEqual(await leaseStore.list(), []);
  } finally {
    leaseStore.continueArm();
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('treats a reused Claude PID with a new creation time as a new process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-claude-hook-pid-reuse-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const firstCreatedAt = Date.now() - 10_000;
  const secondCreatedAt = Date.now() - 1_000;
  const transcript = join(projects, 'project', 'session.jsonl');
  await writeFile(transcript, `${JSON.stringify({ cwd, sessionId: 'reused-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook: { ...defaultConfig.tools.claude.stopHook, enabled: true } },
    },
  });
  const watchdogRecord: RawProcessRecord = {
    pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null,
    creationTimeMs: firstCreatedAt, userSid: 'S-1-5-21-test',
  };
  const claudeRecord = (creationTimeMs: number): RawProcessRecord => ({
    pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null,
    creationTimeMs, userSid: 'S-1-5-21-test',
  });
  const provider = new MutableFixtureProvider([watchdogRecord, claudeRecord(firstCreatedAt)]);
  const leaseStore = new ClaudeLeaseStore(join(root, 'claude-leases.json'));
  let clock = firstCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider,
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    claudeLeaseStore: leaseStore,
    claudeHookInstalled: () => true,
    now: () => clock,
    transportFactory: () => new CannotInjectFixtureTransport(),
  });
  try {
    await controller.poll();
    clock += 1_000;
    await controller.poll();
    assert.equal((await leaseStore.list()).length, 1);

    provider.records = [watchdogRecord, claudeRecord(secondCreatedAt)];
    clock = secondCreatedAt;
    await controller.poll();

    assert.deepEqual(await leaseStore.list(), []);
    assert.equal((await controller.list())[0]?.startedAtMs, secondCreatedAt);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('applies include and exclude filters to independent process sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-filter-'));
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    processFilters: {
      ...defaultConfig.processFilters,
      include: ['keep-project'],
      exclude: ['blocked-project'],
    },
  });
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: 'claude.ps1 --cwd C:\\work\\keep-project', executablePath: null, creationTimeMs: 1, userSid: 'S-1-5-21-test' },
    { pid: 200, parentPid: 1, name: 'codex.exe', commandLine: 'codex.exe -C C:\\work\\blocked-project\\keep-project', executablePath: null, creationTimeMs: 1, userSid: 'S-1-5-21-test' },
    { pid: 300, parentPid: 1, name: 'claude.ps1', commandLine: 'claude.ps1 --cwd C:\\work\\other-project', executablePath: null, creationTimeMs: 1, userSid: 'S-1-5-21-test' },
  ];
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: join(root, 'projects'),
    now: () => 1,
  });
  try {
    await controller.poll();
    assert.deepEqual((await controller.list()).map((session) => session.id), ['claude:100']);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('isolates a session probe failure so later sessions are still refreshed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-isolation-'));
  const projects = join(root, 'projects');
  const firstCwd = join(root, 'first');
  const secondCwd = join(root, 'second');
  await mkdir(join(projects, 'first'), { recursive: true });
  await mkdir(join(projects, 'second'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'first', 'first.jsonl'), `${JSON.stringify({ cwd: firstCwd, sessionId: 'first-session' })}\n`, 'utf8');
  await writeFile(join(projects, 'second', 'second.jsonl'), `${JSON.stringify({ cwd: secondCwd, sessionId: 'second-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${firstCwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 200, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${secondCwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
  ];
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    now: () => processCreatedAt,
    transportFactory: () => new ThrowingTransport(),
  });
  try {
    await controller.poll();
    const sessions = await controller.list();
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find((session) => session.id === 'claude:100')?.transport, 'monitor-only');
    assert.equal(sessions.find((session) => session.id === 'claude:200')?.transport, 'classic-console');
    assert.ok((await auditStore.list()).some((event) => event.details?.reason === 'session-refresh: fixture attach failed'));
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('treats a changed classic Console fingerprint as response activity before injecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-console-activity-'));
  const projects = join(root, 'projects');
  const cwd = join(root, 'conversation');
  await mkdir(join(projects, 'project'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'project', 'session.jsonl'), `${JSON.stringify({ cwd, sessionId: 'console-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
  });
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${cwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
  ];
  const transport = new ConsoleFixtureTransport([100]);
  let clock = processCreatedAt;
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    now: () => clock,
    transportFactory: () => transport,
  });
  try {
    await controller.poll();
    transport.fingerprint = 'response-arrived';
    clock += 1_000;
    await controller.poll();

    assert.deepEqual(transport.writes, []);
    assert.equal((await controller.list())[0]?.lastActivityAtMs, clock);
    assert.ok((await auditStore.list()).some((event) => event.type === 'activity' && event.details?.source === 'classic-console'));
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when two discovered sessions share one classic Console', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-console-collision-'));
  const projects = join(root, 'projects');
  const firstCwd = join(root, 'first');
  const secondCwd = join(root, 'second');
  await mkdir(join(projects, 'first'), { recursive: true });
  await mkdir(join(projects, 'second'), { recursive: true });
  const processCreatedAt = Date.now() - 1_000;
  await writeFile(join(projects, 'first', 'first.jsonl'), `${JSON.stringify({ cwd: firstCwd, sessionId: 'first-session' })}\n`, 'utf8');
  await writeFile(join(projects, 'second', 'second.jsonl'), `${JSON.stringify({ cwd: secondCwd, sessionId: 'second-session' })}\n`, 'utf8');
  const configStore = new ConfigStore(join(root, 'config.json'));
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${firstCwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
    { pid: 200, parentPid: 1, name: 'claude.ps1', commandLine: `claude.ps1 --cwd "${secondCwd}"`, executablePath: null, creationTimeMs: processCreatedAt, userSid: 'S-1-5-21-test' },
  ];
  const transports = new Map<number, ConsoleFixtureTransport>([
    [100, new ConsoleFixtureTransport([100, 200])],
    [200, new ConsoleFixtureTransport([100, 200])],
  ]);
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    claudeProjectsDirectory: projects,
    now: () => processCreatedAt,
    transportFactory: (session) => transports.get(session.rootPid) ?? null,
  });
  try {
    await controller.poll();
    const sessions = await controller.list();

    assert.deepEqual(sessions.map((session) => session.transport), ['cannot-inject', 'cannot-inject']);
    assert.ok(sessions.every((session) => session.transportError?.includes('shared classic Console')));
    assert.deepEqual([...transports.values()].flatMap((transport) => transport.writes), []);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('manual Codex injection sends the requested prompt to its associated thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-codex-manual-'));
  const cwd = join(root, 'conversation');
  const threadId = '01a01234-1234-7abc-8def-0123456789ab';
  const paths = await createCodexState(root, threadId, cwd, 'complete');
  const configStore = new ConfigStore(join(root, 'config.json'));
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'codex.exe', commandLine: `codex resume ${threadId}`, executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test', workingDirectory: cwd },
  ];
  const calls: string[] = [];
  const appServer = {
    resumeThread: async (id: string) => { calls.push(`resume:${id}`); return {}; },
    startTurn: async (id: string, prompt: string) => { calls.push(`turn:${id}:${prompt}`); return {}; },
    close: () => undefined,
  } as unknown as AppServerClient;
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    codexStatePath: paths.statePath,
    codexGoalPath: paths.goalPath,
    codexAppServerFactory: () => appServer,
    now: () => 1_000,
  });
  try {
    await controller.poll();
    const result = await controller.inject('codex:100', '检查最新输出', false);

    assert.deepEqual(result, { ok: true, prompt: '检查最新输出' });
    assert.deepEqual(calls, [`resume:${threadId}`, `turn:${threadId}:检查最新输出`]);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('existing Codex sessions use prompt changes saved by the WebUI on the next poll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-codex-config-'));
  const cwd = join(root, 'conversation');
  const threadId = '01a01234-1234-7abc-8def-1123456789ab';
  const paths = await createCodexState(root, threadId, cwd, 'active');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
  });
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'codex.exe', commandLine: `codex resume ${threadId}`, executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test', workingDirectory: cwd },
  ];
  const calls: string[] = [];
  const appServer = {
    resumeThread: async (id: string) => { calls.push(`resume:${id}`); return {}; },
    startTurn: async (id: string, prompt: string) => { calls.push(`turn:${id}:${prompt}`); return {}; },
    close: () => undefined,
  } as unknown as AppServerClient;
  let clock = 1_000;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    codexStatePath: paths.statePath,
    codexGoalPath: paths.goalPath,
    codexAppServerFactory: () => appServer,
    now: () => clock,
  });
  try {
    await controller.poll();
    await configStore.save({
      ...defaultConfig,
      defaultIdleTimeoutMs: 100,
      defaultCooldownMs: 1_000,
      tools: {
        ...defaultConfig.tools,
        codex: { ...defaultConfig.tools.codex, goalPrompt: '/goal resume updated' },
      },
    });
    clock += 1_000;
    await controller.poll();

    assert.deepEqual(calls, [`resume:${threadId}`, `turn:${threadId}:/goal resume updated`]);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('completed automatic decisions do not expose a stale pending prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-pending-prompt-'));
  const cwd = join(root, 'conversation');
  const threadId = '01a01234-1234-7abc-8def-2123456789ab';
  const paths = await createCodexState(root, threadId, cwd, 'active');
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    dryRun: true,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
  });
  const records: RawProcessRecord[] = [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
    { pid: 100, parentPid: 1, name: 'codex.exe', commandLine: `codex resume ${threadId}`, executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test', workingDirectory: cwd },
  ];
  let clock = 1_000;
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider(records),
    platform: 'win32',
    currentProcessId: 50,
    codexStatePath: paths.statePath,
    codexGoalPath: paths.goalPath,
    now: () => clock,
  });
  try {
    await controller.poll();
    clock += 1_000;
    await controller.poll();

    const session = (await controller.list()).find((entry) => entry.id === 'codex:100');
    assert.equal(session?.lastDecision, 'injected');
    assert.equal(session?.pendingPrompt, null);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

const DSH_SESSION_ID = 'session-3acd60b1-9056-4191-9070-8cd3563436a7';
const DSH_HOST_RECORD: RawProcessRecord = {
  pid: 700,
  parentPid: 1,
  name: 'node.exe',
  commandLine: 'node "C:\\repo\\deepseek-harness\\apps\\cli\\lib\\bin.js" web',
  executablePath: 'C:\\node\\node.exe',
  creationTimeMs: 1_000,
  userSid: 'S-1-5-21-test',
  workingDirectory: 'C:\\Users\\test',
};

async function createDshHome(
  root: string,
  input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mtimeMs?: number;
    readonly sequence?: number;
    readonly turnOpen?: boolean;
    readonly blank?: boolean;
  },
): Promise<{ readonly home: string; readonly transcript: string }> {
  const home = join(root, 'dsh');
  const projectSlug = `--${input.cwd.replace(/[:\\/]+/gu, '-').replace(/^-+/u, '')}--`;
  const directory = join(home, 'sessions', projectSlug, input.sessionId);
  await mkdir(directory, { recursive: true });
  const transcript = join(directory, 'session.v3.jsonl');
  await writeFile(
    transcript,
    `${JSON.stringify({ type: 'session', version: 3, id: input.sessionId, createdAt: 2_000, cwd: input.cwd })}\n`,
    'utf8',
  );

  const projectionDirectory = join(home, 'storages', 'session_projcache', 'sessions');
  await mkdir(projectionDirectory, { recursive: true });
  await writeFile(join(projectionDirectory, `${input.sessionId}.json`), JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 3, createdAt: 2_000, cwd: input.cwd },
      rows: {
        sessionListMetadata: {
          ver: 1,
          seq: input.sequence ?? 10,
          val: { blank: input.blank ?? false, lastPromptAt: 3_000 },
        },
        turnBoundary: {
          ver: 2,
          seq: input.sequence ?? 10,
          val: {
            openTurnStartSeq: 1,
            lastStepBoundary: input.turnOpen === false ? { kind: 'end', seq: 9 } : { kind: 'start', seq: 10 },
            lastTurn: 1,
          },
        },
      },
    },
  }), 'utf8');
  return { home, transcript };
}

test('polls a DeepSeek Harness host as one monitored row per live session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-dsh-'));
  const live = await createDshHome(root, {
    sessionId: DSH_SESSION_ID,
    cwd: 'D:\\project\\ai-cli-bypass',
    turnOpen: true,
  });
  const blank = await createDshHome(root, {
    sessionId: 'session-0919e034-01bd-4cb1-9747-70ef776e7a63',
    cwd: 'D:\\project\\Orchester',
    blank: true,
  });
  assert.equal(blank.home, live.home);

  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    dryRun: true,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
  });
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  let clock = 5_000;
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
      DSH_HOST_RECORD,
    ]),
    platform: 'win32',
    currentProcessId: 50,
    dshHomeDirectory: live.home,
    now: () => clock,
  });

  try {
    await controller.start();
    const sessions = await controller.list();
    assert.equal(sessions.length, 1);
    const session = sessions[0];
    assert.ok(session);
    assert.equal(session.id, `dsh:${DSH_SESSION_ID}`);
    assert.equal(session.tool, 'dsh');
    assert.equal(session.rootPid, 700);
    assert.equal(session.conversationId, DSH_SESSION_ID);
    assert.equal(session.transport, 'monitor-only');
    assert.equal(session.sessionCwd, 'D:\\project\\ai-cli-bypass');
    assert.equal(session.runningTurn, true);
    assert.equal(session.transportError, 'dry run keeps DeepSeek Harness input disabled');

    // A session that never received a prompt is history, not a monitored agent.
    assert.ok(!sessions.some((entry) => entry.conversationId?.includes('0919e034')));

    clock += 5_000;
    await controller.poll();
    const events = await auditStore.list();
    // The harness row is monitored in dry-run, but a session whose step is still
    // running is never handed a continuation.
    assert.ok(events.some((event) =>
      event.tool === 'dsh' && event.type === 'skip' && event.details?.reason === 'harness-step-running'));
    assert.ok(!events.some((event) => event.tool === 'dsh' && event.prompt !== undefined));
    // The harness has no unattended write path in dry-run, so nothing is written.
    assert.ok(!events.some((event) => event.tool === 'dsh' && event.type === 'injection'));
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('records harness transcript growth as activity and refreshes the live step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-dsh-activity-'));
  const home = await createDshHome(root, {
    sessionId: DSH_SESSION_ID,
    cwd: 'D:\\project\\ai-cli-bypass',
    turnOpen: true,
    sequence: 10,
  });
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    dryRun: true,
    defaultIdleTimeoutMs: 100_000,
    defaultCooldownMs: 100_000,
  });
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  let clock = 5_000;
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
      DSH_HOST_RECORD,
    ]),
    platform: 'win32',
    currentProcessId: 50,
    dshHomeDirectory: home.home,
    now: () => clock,
  });

  try {
    await controller.start();
    clock += 1_000;
    await controller.poll();
    assert.ok(!(await auditStore.list()).some((event) => event.details?.source === 'dsh-session'));

    const projection = join(home.home, 'storages', 'session_projcache', 'sessions', `${DSH_SESSION_ID}.json`);
    const document = JSON.parse(await readFile(projection, 'utf8')) as {
      record: { rows: { sessionListMetadata: { seq: number }; turnBoundary: { seq: number; val: { lastStepBoundary: { kind: string; seq: number } } } } };
    };
    document.record.rows.sessionListMetadata.seq = 12;
    document.record.rows.turnBoundary.seq = 12;
    document.record.rows.turnBoundary.val.lastStepBoundary = { kind: 'end', seq: 12 };
    await writeFile(projection, JSON.stringify(document), 'utf8');

    clock += 1_000;
    await controller.poll();

    assert.ok((await auditStore.list()).some((event) => event.details?.source === 'dsh-session'));
    const session = (await controller.list())[0];
    assert.equal(session?.runningTurn, false);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('drops a harness session once its host process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-dsh-exit-'));
  const home = await createDshHome(root, {
    sessionId: DSH_SESSION_ID,
    cwd: 'D:\\project\\ai-cli-bypass',
  });
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({ ...defaultConfig, dryRun: true });
  const provider = new MutableFixtureProvider([
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
    DSH_HOST_RECORD,
  ]);
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider,
    platform: 'win32',
    currentProcessId: 50,
    dshHomeDirectory: home.home,
  });

  try {
    await controller.poll();
    assert.equal((await controller.list()).length, 1);

    provider.records = provider.records.filter((record) => record.pid !== DSH_HOST_RECORD.pid);
    await controller.poll();

    const sessions = await controller.list();
    assert.equal(sessions[0]?.alive, false);
    assert.equal(sessions[0]?.lastDecision, 'process-exited');
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

const DSH_SECRET = 'kRvh6kC50JlSEaqoon1GHkVx7zv8h8lfIyu36z8cob4';

/** A fake harness web host: the 401 fingerprint on `/`, RPC elsewhere. */
function fakeDshHost(onPrompt?: (body: unknown) => void) {
  const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, body });
    if (init?.method === undefined) {
      return new Response('dsh web authentication required; reopen the URL printed by dsh web.\n', { status: 401 });
    }
    onPrompt?.(body);
    return Response.json({
      type: 'server-response',
      rpcId: 'x',
      result: { ok: true, value: { accepted: true } },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function writeDshCredentials(home: string): Promise<string> {
  const credentials = join(home, 'credentials-home');
  await mkdir(credentials, { recursive: true });
  await writeFile(join(credentials, '.credentials.yaml'), [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${DSH_SECRET}`,
    '',
  ].join('\n'), 'utf8');
  return credentials;
}

async function dshControllerFixture(options: {
  readonly dryRun: boolean;
  readonly allowApiInput?: boolean;
  readonly turnOpen?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-dsh-api-'));
  const home = await createDshHome(root, {
    sessionId: DSH_SESSION_ID,
    cwd: 'D:\\project\\ai-cli-bypass',
    turnOpen: options.turnOpen ?? false,
  });
  const credentialsHome = await writeDshCredentials(root);
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({
    ...defaultConfig,
    dryRun: options.dryRun,
    defaultIdleTimeoutMs: 100,
    defaultCooldownMs: 1_000,
    tools: {
      ...defaultConfig.tools,
      dsh: {
        ...defaultConfig.tools.dsh,
        ...(options.allowApiInput === undefined ? {} : { allowApiInput: options.allowApiInput }),
      },
    },
  });
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  const host = fakeDshHost();
  let clock = 5_000;
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
      DSH_HOST_RECORD,
    ]),
    platform: 'win32',
    currentProcessId: 50,
    dshHomeDirectory: home.home,
    dshHostClientFactory: () => new DshHostClient({ homeDirectory: credentialsHome, fetchImpl: host.fetchImpl }),
    dshPortLister: async () => [3080],
    now: () => clock,
  });
  return {
    root,
    controller,
    auditStore,
    host,
    advance: (ms: number) => { clock += ms; },
    cleanup: async () => {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('continues a quiet harness session through the harness session API', async () => {
  const fixture = await dshControllerFixture({ dryRun: false });
  try {
    await fixture.controller.start();
    await fixture.advance(5_000);
    await fixture.controller.poll();
    await fixture.advance(5_000);
    await fixture.controller.poll();

    const session = (await fixture.controller.list())[0];
    assert.equal(session?.transport, 'dsh-web');
    assert.equal(session?.transportError, undefined);

    const promptCalls = fixture.host.calls.filter((call) => call.url.endsWith('/api/session/prompt'));
    assert.equal(promptCalls.length, 1);
    const body = promptCalls[0]?.body as { payload: { args: { request: { content: unknown; mode: string } } } };
    assert.equal(body.payload.args.request.mode, 'queue');
    assert.deepEqual(body.payload.args.request.content, [{ type: 'text', text: '继续' }]);

    const events = await fixture.auditStore.list();
    assert.ok(events.some((event) => event.type === 'injection' && event.tool === 'dsh' && event.prompt === '继续'));
  } finally {
    await fixture.cleanup();
  }
});

test('keeps a running harness step untouched and skips the continuation', async () => {
  const fixture = await dshControllerFixture({ dryRun: false, turnOpen: true });
  try {
    await fixture.controller.start();
    await fixture.advance(5_000);
    await fixture.controller.poll();
    await fixture.advance(5_000);
    await fixture.controller.poll();

    assert.equal((await fixture.controller.list())[0]?.transport, 'dsh-web');
    assert.equal(fixture.host.calls.filter((call) => call.url.endsWith('/api/session/prompt')).length, 0);

    const events = await fixture.auditStore.list();
    assert.ok(events.some((event) => event.type === 'skip' && event.details?.reason === 'harness-step-running'));
    assert.ok(!events.some((event) => event.type === 'injection'));
  } finally {
    await fixture.cleanup();
  }
});

test('a dry run keeps harness input disabled even when the host is reachable', async () => {
  const fixture = await dshControllerFixture({ dryRun: true });
  try {
    await fixture.controller.start();
    const session = (await fixture.controller.list())[0];
    assert.equal(session?.transport, 'monitor-only');
    assert.equal(session?.transportError, 'dry run keeps DeepSeek Harness input disabled');
    assert.equal(fixture.host.calls.filter((call) => call.url.endsWith('/api/session/prompt')).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('disabling harness API input keeps the session monitor-only', async () => {
  const fixture = await dshControllerFixture({ dryRun: false, allowApiInput: false });
  try {
    await fixture.controller.start();
    const session = (await fixture.controller.list())[0];
    assert.equal(session?.transport, 'monitor-only');
    assert.equal(session?.transportError, 'DeepSeek Harness input is disabled in the watchdog settings');
    // No host is probed at all while input is disabled.
    assert.equal(fixture.host.calls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('an unreachable harness host leaves the session monitor-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-dsh-nohost-'));
  const home = await createDshHome(root, {
    sessionId: DSH_SESSION_ID,
    cwd: 'D:\\project\\ai-cli-bypass',
    turnOpen: false,
  });
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({ ...defaultConfig, dryRun: false });
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
      DSH_HOST_RECORD,
    ]),
    platform: 'win32',
    currentProcessId: 50,
    dshHomeDirectory: home.home,
    dshHostClientFactory: () => new DshHostClient({
      homeDirectory: join(root, 'absent'),
      fetchImpl: (async () => { throw new Error('fixture refuses connections'); }) as unknown as typeof fetch,
    }),
    dshPortLister: async () => [3080],
  });
  try {
    await controller.start();
    const session = (await controller.list())[0];
    assert.equal(session?.transport, 'monitor-only');
    assert.equal(session?.transportError, 'the local DeepSeek Harness session API is unavailable');
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

/** A process record carrying a resolved host window. */
function hostedRecord(input: {
  readonly pid: number;
  readonly name: string;
  readonly commandLine: string;
  readonly hostPid: number;
  readonly hostName: string;
  readonly hostTitle: string;
  readonly handle: number;
}): RawProcessRecord {
  return {
    pid: input.pid,
    parentPid: 1,
    name: input.name,
    commandLine: input.commandLine,
    executablePath: null,
    creationTimeMs: 1_000,
    userSid: 'S-1-5-21-test',
    workingDirectory: 'D:\\project\\ai-cli-bypass',
    ancestors: [{ pid: input.hostPid, name: input.hostName }, { pid: 5292, name: 'explorer.exe' }],
    windows: [{
      handle: input.handle,
      pid: input.hostPid,
      processName: input.hostName,
      title: input.hostTitle,
      className: 'Chrome_WidgetWin_1',
      visible: true,
    }],
  };
}

test('reports the application each session runs inside', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-host-'));
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({ ...defaultConfig, dryRun: true });
  const controller = new WatchdogController({
    configStore,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
      hostedRecord({
        pid: 300,
        name: 'node.exe',
        commandLine: '"node" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" --dangerously-bypass-approvals-and-sandbox',
        hostPid: 31192,
        hostName: 'Tabby.exe',
        hostTitle: ' Orchester',
        handle: 459_954,
      }),
      hostedRecord({
        pid: 301,
        name: 'codex.exe',
        commandLine: 'codex.exe app-server --listen stdio://',
        hostPid: 3752,
        hostName: 'ChatGPT.exe',
        hostTitle: 'ChatGPT',
        handle: 18_220_776,
      }),
    ]),
    platform: 'win32',
    currentProcessId: 50,
  });
  try {
    await controller.poll();
    const sessions = await controller.list();
    const tabby = sessions.find((session) => session.rootPid === 300);
    assert.equal(tabby?.host?.label, 'Tabby');
    assert.equal(tabby?.host?.category, 'terminal');
    assert.equal(tabby?.host?.windowHandle, 459_954);
    assert.equal(tabby?.host?.windowTitle, ' Orchester');

    const codexApp = sessions.find((session) => session.rootPid === 301);
    assert.equal(codexApp?.host?.label, 'Codex 应用');
    assert.equal(codexApp?.host?.category, 'desktop-app');
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('reveals a session window and falls back to the harness interface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-runtime-focus-'));
  const home = await createDshHome(root, {
    sessionId: DSH_SESSION_ID,
    cwd: 'D:\\project\\ai-cli-bypass',
    turnOpen: false,
  });
  const credentialsHome = await writeDshCredentials(root);
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({ ...defaultConfig, dryRun: true });
  const host = fakeDshHost();
  const focused: number[] = [];
  const opened: string[] = [];
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  const controller = new WatchdogController({
    configStore,
    auditStore,
    provider: new FixtureProvider([
      { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: 1_000, userSid: 'S-1-5-21-test' },
      hostedRecord({
        pid: 302,
        name: 'node.exe',
        commandLine: '"node" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" --dangerously-bypass-approvals-and-sandbox',
        hostPid: 31192,
        hostName: 'Tabby.exe',
        hostTitle: ' Orchester',
        handle: 459_954,
      }),
      DSH_HOST_RECORD,
    ]),
    platform: 'win32',
    currentProcessId: 50,
    dshHomeDirectory: home.home,
    dshHostClientFactory: () => new DshHostClient({ homeDirectory: credentialsHome, fetchImpl: host.fetchImpl }),
    dshPortLister: async () => [3080],
    focusWindowImpl: async (handle) => {
      focused.push(handle);
      return handle === 459_954
        ? { ok: true, focused: true, title: ' Orchester' }
        : { ok: false, focused: false, reason: 'foreground-refused' };
    },
    openUrlImpl: async (url) => {
      opened.push(url);
      return { ok: true, focused: true };
    },
  });

  try {
    await controller.poll();
    const sessions = await controller.list();
    const tabby = sessions.find((session) => session.rootPid === 302);
    const harnessRow = sessions.find((session) => session.tool === 'dsh');
    assert.ok(tabby);
    assert.ok(harnessRow);

    assert.deepEqual(await controller.focus(tabby.id), { ok: true, focused: true, title: ' Orchester' });
    assert.deepEqual(focused, [459_954]);
    assert.deepEqual(opened, []);

    // The harness row has no window inside its own process tree, so revealing it
    // opens the interface that serves it.
    assert.equal(harnessRow.host?.windowHandle, null);
    assert.deepEqual(await controller.focus(harnessRow.id), { ok: true, focused: true });
    assert.deepEqual(opened, ['http://127.0.0.1:3080']);

    const events = await auditStore.list();
    assert.ok(events.some((event) => event.details?.action === 'focus'));

    assert.deepEqual(await controller.focus('dsh:missing'), { ok: false, reason: 'session-not-found' });
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});
