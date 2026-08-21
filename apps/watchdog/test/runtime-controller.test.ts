import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { defaultConfig } from '../src/domain/config.js';
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
