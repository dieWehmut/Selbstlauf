import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { defaultConfig } from '../src/domain/config.js';
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

class FixtureTransport implements SessionTransport {
  public writes: string[] = [];
  public async probe(pid: number) { return { ok: true as const, kind: 'classic-console' as const, pid, consoleProcessIds: [pid] }; }
  public async activityFingerprint(pid: number) { return { ok: true as const, kind: 'classic-console' as const, pid, fingerprint: 'stable' }; }
  public async write(pid: number, text: string) { this.writes.push(`${pid}:${text}`); return { ok: true as const, kind: 'classic-console' as const, pid, recordsWritten: 2 }; }
}

class ThrowingTransport extends FixtureTransport {
  public override async probe(pid: number) {
    if (pid === 100) throw new Error('fixture attach failed');
    return super.probe(pid);
  }
}

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
