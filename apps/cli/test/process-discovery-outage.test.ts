import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AppServerClient } from '../src/codex/app-server.js';
import { CodexAdapter } from '../src/codex/codex-adapter.js';
import { codexStateRevision, snapshotWslCodexState } from '../src/codex/wsl-state.js';
import { defaultConfig } from '../src/domain/config.js';
import type { RawProcessRecord } from '../src/process/process-provider.js';
import { WatchdogController, type RuntimeSessionView } from '../src/runtime/watchdog-controller.js';
import { AuditStore } from '../src/store/audit-store.js';
import { ConfigStore } from '../src/store/config-store.js';

const SELF = '01a1c977-e596-7c43-8848-6308b65eeb43';
const OTHER = '01a1c802-9e61-7231-9b1f-3496633c13b2';
const NEW = '01a1c802-9e61-7231-9b1f-3496633c13b3';
const NATIVE = '01a1c802-9e61-7231-9b1f-3496633c13b4';
type DiscoveryState = 'healthy' | 'failed' | 'empty';

function nativeProcesses(userSid = 'fixture'): RawProcessRecord[] {
  return [
    { pid: 50, parentPid: 1, name: 'Selbstlauf.exe', commandLine: null,
      executablePath: null, creationTimeMs: 1000, userSid: 'fixture' },
    { pid: 100, parentPid: 1, name: 'codex.exe', commandLine: 'codex.exe app-server --managed-daemon',
      arguments: ['codex.exe', 'app-server', '--managed-daemon'], workingDirectory: '/native',
      executablePath: null, creationTimeMs: 1000, userSid },
  ];
}

async function fixture(enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'process-discovery-outage-'));
  const home = join(root, 'state');
  await mkdir(home);
  const statePath = join(home, 'state_5.sqlite');
  const db = new DatabaseSync(statePath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 1000, 2000)');
  insert.run(SELF, '/work/Selbstlauf', 'Selbstlauf', 'running');
  insert.run(OTHER, '/work/Orchester', 'Orchester', 'running');
  insert.run(NEW, '/work/New', 'New', 'running');
  insert.run(NATIVE, '/native/project', 'Native', 'running');
  db.close();
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({ ...defaultConfig, enabled, dryRun: false,
    defaultIdleTimeoutMs: 100, wslDistribution: 'Ubuntu' });
  const auditStore = new AuditStore(join(root, 'audit.jsonl'));
  let clock = 5000;
  let nativeState: DiscoveryState = 'empty';
  let nativeUserSid = 'fixture';
  let wslState: DiscoveryState | 'partial' = 'healthy';
  let blockedFilesystem: Promise<void> | null = null;
  let filesystemStarted: (() => void) | null = null;
  let owners = [{ pid: 42, threadId: SELF }, { pid: 42, threadId: OTHER }];
  const ownerReads: string[] = [];
  const processReads: string[] = [];
  const filesystemReads: string[] = [];
  const snapshots: string[] = [];
  let revisionReads = 0;
  const controller = new WatchdogController({
    configStore, auditStore, platform: 'win32', currentProcessId: 50,
    now: () => clock, codexStatePath: statePath,
    claudeProjectsDirectory: join(root, 'claude'), dshHomeDirectory: join(root, 'dsh'),
    provider: { listProcesses: async () => {
      if (nativeState === 'failed') throw new Error('native process table unavailable');
      return nativeState === 'healthy' ? nativeProcesses(nativeUserSid) : [];
    } },
    codexThreadOwnerReader: async (_home, distribution) => {
      ownerReads.push(distribution ?? 'native');
      return distribution ? owners : [{ pid: 100, threadId: NATIVE }];
    },
    wslRun: async (distribution, script) => {
      if (script.includes('ps -eo')) processReads.push(distribution);
      if (wslState === 'failed' || wslState === 'partial') throw new Error('WSL process command unavailable');
      if (script.includes('ps -eo')) return wslState === 'empty' ? '1\t0\tinit\t/sbin/init\t/\t\t0\n'
        : '42\t1\tcodex\tcodex app-server --managed-daemon\t/work\t\t0\n';
      if (script === 'printf %s "$HOME"') return '/home/alice';
      return '/home/alice/bin/node\t/home/alice/bin/codex';
    },
    wslFilesystem: async distribution => {
      filesystemReads.push(distribution);
      if (blockedFilesystem !== null) {
        filesystemStarted?.();
        await blockedFilesystem;
      }
      if (wslState === 'partial') return {
        records: [{ pid: 84, parentPid: 1, name: 'codex', commandLine: 'codex app-server --managed-daemon',
          workingDirectory: '/work', executablePath: null, creationTimeMs: null, userSid: null }],
        homeDirectory: '/home/alice', error: 'another proc entry is unavailable',
      };
      throw new Error('WSL process filesystem unavailable');
    },
    wslStateRevision: () => { revisionReads++; return codexStateRevision(home); },
    wslStateSnapshot: () => {
      const snapshot = snapshotWslCodexState({ uncCodexHome: home });
      assert.ok(snapshot, 'the fixture must copy a real SQLite state database');
      snapshots.push(snapshot.directory);
      return snapshot;
    },
  });
  return {
    controller, configStore, auditStore, ownerReads, processReads, filesystemReads, snapshots,
    get revisionReads() { return revisionReads; },
    setNativeState(state: DiscoveryState) { nativeState = state; },
    setNativeUserSid(userSid: string) { nativeUserSid = userSid; },
    setWslState(state: DiscoveryState | 'partial') { wslState = state; },
    setOwners(next: typeof owners) { owners = next; },
    advanceClock(milliseconds: number) { clock += milliseconds; },
    blockNextFilesystem() {
      let release!: () => void;
      blockedFilesystem = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { filesystemStarted = resolve; });
      return { started, release: () => { blockedFilesystem = null; filesystemStarted = null; release(); } };
    },
    updateThread(threadId: string, cwd: string) {
      const db = new DatabaseSync(statePath);
      try { db.prepare('UPDATE threads SET cwd=?, updated_at_ms=3000 WHERE id=?').run(cwd, threadId); }
      finally { db.close(); }
    },
    async cleanup() {
      await controller.stop();
      for (const directory of snapshots) await rm(directory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function forbidModelInput(t: test.TestContext) {
  const initialize = t.mock.method(AppServerClient.prototype, 'initialize', async () => { throw new Error('Discovery must not launch a model transport'); });
  const start = t.mock.method(AppServerClient.prototype, 'startTurn', async () => { throw new Error('Discovery must not start a model turn'); });
  const queue = t.mock.method(AppServerClient.prototype, 'queuePrompt', async () => { throw new Error('Discovery must not queue model input'); });
  return () => {
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(queue.mock.callCount(), 0);
  };
}

function assertPending(row: RuntimeSessionView, previous: RuntimeSessionView) {
  assert.equal(row.alive, true, 'failed discovery cannot establish that a confirmed process exited');
  assert.equal(row.id, previous.id);
  assert.equal(row.rootPid, previous.rootPid);
  assert.equal(row.conversationId, previous.conversationId);
  assert.equal(row.sessionCwd, previous.sessionCwd);
  assert.equal(row.conversationTitle, previous.conversationTitle);
  assert.equal(row.transport, 'monitor-only');
  assert.match(row.transportError ?? '', /[\u4e00-\u9fff]/u, 'show a localized discovery failure reason');
  assert.equal(row.runningTurn, undefined, 'a previous running status is unconfirmed during discovery failure');
}

test('a whole WSL process discovery outage preserves verified projects, blocks input, then recovers and retires successful empty snapshots', async t => {
  const noInput = forbidModelInput(t);
  const continuation = t.mock.method(CodexAdapter.prototype, 'getContinuation', async () => {
    throw new Error('An unconfirmed process must not request automatic continuation');
  });
  const f = await fixture(true);
  try {
    await f.controller.poll();
    const first = (await f.controller.list()).filter(row => row.alive);
    assert.deepEqual(first.map(row => row.conversationId).sort(), [SELF, OTHER].sort());
    assert.ok(first.every(row => row.transport === 'codex-app-server' && row.runningTurn === true));
    const reads = { owners: f.ownerReads.length, revisions: f.revisionReads, snapshots: f.snapshots.length };
    f.updateThread(SELF, '/work/Selbstlauf-new');
    f.setOwners([{ pid: 42, threadId: SELF }, { pid: 42, threadId: NEW }]);
    f.setWslState('failed');
    f.advanceClock(2000);
    await f.controller.poll();
    const pending = await f.controller.list();
    assert.equal(pending.filter(row => row.alive).length, first.length);
    for (const previous of first) {
      const row = pending.find(row => row.id === previous.id);
      assert.ok(row, 'the last confirmed project row must remain visible');
      assertPending(row, previous);
      assert.equal((await f.controller.inject(row.id, 'must not be sent', false)).ok, false);
      assert.equal((await f.controller.inject(row.id, 'must not be simulated', true)).ok, false);
    }
    assert.equal(f.filesystemReads.length, 1, 'both WSL collection channels must actually fail');
    assert.equal(f.ownerReads.length, reads.owners, 'unavailable processes cannot refresh writer ownership');
    assert.equal(f.revisionReads, reads.revisions, 'unavailable processes cannot refresh state metadata');
    assert.equal(f.snapshots.length, reads.snapshots, 'keep the last confirmed project state during an outage');
    assert.equal(continuation.mock.callCount(), 0, 'automatic input must stop before resolving a continuation');
    await f.controller.poll();
    for (const previous of first) assertPending((await f.controller.list()).find(row => row.id === previous.id)!, previous);
    assert.equal(continuation.mock.callCount(), 0);

    await f.configStore.save({ ...await f.configStore.load(), enabled: false });
    f.setWslState('healthy');
    f.advanceClock(60_000);
    await f.controller.poll();
    const recovered = await f.controller.list();
    const self = recovered.find(row => row.conversationId === SELF)!;
    assert.equal(self.id, first.find(row => row.conversationId === SELF)!.id);
    assert.equal(self.alive, true);
    assert.equal(self.sessionCwd, '/work/Selbstlauf-new');
    assert.equal(self.transport, 'codex-app-server');
    assert.equal(self.transportError, undefined);
    assert.equal(self.runningTurn, true);
    assert.equal(recovered.find(row => row.conversationId === OTHER)?.alive, false, 'recovery must refresh released writers');
    assert.equal(recovered.find(row => row.conversationId === NEW)?.alive, true, 'recovery must discover new writers');
    assert.equal(f.snapshots.length, reads.snapshots + 1);

    f.setWslState('empty');
    await f.controller.poll();
    assert.equal((await f.controller.list()).filter(row => row.alive).length, 0, 'a successful empty process snapshot confirms exit');
    f.setWslState('failed');
    await f.controller.poll();
    assert.equal((await f.controller.list()).filter(row => row.alive).length, 0, 'later discovery failures must never revive already retired rows');
    noInput();
  } finally { await f.cleanup(); }
});

test('native process discovery failure preserves its confirmed rows while WSL refreshes, and native successful empty discovery confirms exit', async t => {
  const noInput = forbidModelInput(t);
  const f = await fixture();
  f.setNativeState('healthy');
  try {
    await f.controller.poll();
    const native = (await f.controller.list()).find(row => row.conversationId === NATIVE)!;
    assert.ok(native?.alive);
    assert.equal(native.transport, 'codex-app-server');
    const nativeReads = f.ownerReads.filter(namespace => namespace === 'native').length;
    f.setNativeState('failed');
    f.updateThread(SELF, '/work/Wsl-still-live');
    await f.controller.poll();
    const rows = await f.controller.list();
    assertPending(rows.find(row => row.id === native.id)!, native);
    assert.equal((await f.controller.inject(native.id, 'must not be sent', false)).ok, false);
    assert.equal((await f.controller.inject(native.id, 'must not be simulated', true)).ok, false);
    assert.equal(f.ownerReads.filter(namespace => namespace === 'native').length, nativeReads);
    const wsl = rows.find(row => row.conversationId === SELF)!;
    assert.equal(wsl.alive, true, 'the unaffected namespace must continue discovering processes');
    assert.equal(wsl.sessionCwd, '/work/Wsl-still-live');
    assert.equal(wsl.transport, 'codex-app-server');
    assert.equal(wsl.transportError, undefined);
    f.setNativeState('empty');
    await f.controller.poll();
    assert.equal((await f.controller.list()).find(row => row.id === native.id)?.alive, false);
    assert.equal((await f.controller.list()).find(row => row.id === wsl.id)?.alive, true);
    noInput();
  } finally { await f.cleanup(); }
});

test('partial filesystem discovery preserves omitted processes and keeps input blocked while the next probe is pending', async t => {
  const noInput = forbidModelInput(t);
  const f = await fixture();
  try {
    await f.controller.poll();
    const previous = (await f.controller.list()).filter(row => row.alive);
    f.setWslState('partial');
    f.setOwners([{ pid: 84, threadId: NEW }]);
    await f.controller.poll();
    const rows = await f.controller.list();
    for (const row of previous) assertPending(rows.find(current => current.id === row.id)!, row);
    const fresh = rows.find(row => row.rootPid === 84);
    assert.ok(fresh?.alive, 'usable records from an incomplete filesystem scan must remain visible');
    assert.equal((await f.controller.inject(fresh.id, 'must not be simulated', true)).ok, false);

    const blocked = f.blockNextFilesystem();
    const poll = f.controller.poll();
    await blocked.started;
    let result;
    try {
      result = await f.controller.inject(fresh.id, 'must stay blocked during a new probe', true);
    } finally {
      blocked.release();
      await poll;
    }
    assert.equal(result.ok, false, 'starting a later probe cannot clear an unresolved namespace failure');
    f.setWslState('empty');
    f.advanceClock(60_000);
    await f.controller.poll();
    assert.equal((await f.controller.list()).filter(row => row.alive).length, 0, 'a later complete snapshot can retire all omitted records');
    noInput();
  } finally { await f.cleanup(); }
});

test('enabling same-user filtering during native discovery failure retires previously visible foreign-user processes', async t => {
  const noInput = forbidModelInput(t);
  const f = await fixture();
  f.setNativeState('healthy');
  f.setNativeUserSid('foreign-user');
  try {
    await f.configStore.save({ ...await f.configStore.load(),
      processFilters: { ...defaultConfig.processFilters, sameUserOnly: false } });
    await f.controller.poll();
    const foreign = (await f.controller.list()).find(row => row.conversationId === NATIVE);
    assert.ok(foreign?.alive);
    await f.configStore.save({ ...await f.configStore.load(),
      processFilters: { ...defaultConfig.processFilters, sameUserOnly: true } });
    f.setNativeState('failed');
    await f.controller.poll();
    const rows = await f.controller.list();
    assert.equal(rows.find(row => row.id === foreign.id)?.alive, false, 'cached rows must obey the newly selected user filter');
    assert.equal((await f.controller.inject(foreign.id, 'must not be simulated', true)).ok, false);
    assert.ok(rows.filter(row => row.distribution === 'Ubuntu').every(row => row.alive), 'Windows user filtering must not exclude WSL');
    noInput();
  } finally { await f.cleanup(); }
});

for (const notify of [false, true]) {
  test(`switching distribution during a discovery outage never reuses the previous namespace (${notify ? 'configChanged' : 'persisted config'})`, async t => {
    const noInput = forbidModelInput(t);
    const f = await fixture();
    try {
      await f.controller.poll();
      const previous = (await f.controller.list()).filter(row => row.alive);
      assert.equal(previous.length, 2);
      assert.ok(previous.every(row => row.distribution === 'Ubuntu'));
      f.setWslState('failed');
      const config = await f.configStore.save({ ...await f.configStore.load(), wslDistribution: 'Debian' });
      if (notify) await f.controller.configChanged(config);
      await f.controller.poll();
      const rows = await f.controller.list();
      assert.equal(rows.filter(row => row.alive).length, 0, 'a new failed namespace has no confirmed process rows');
      assert.ok(rows.every(row => row.distribution !== 'Ubuntu'), 'old distribution state must be released');
      assert.equal(f.processReads.at(-1), 'Debian');
      assert.equal(f.filesystemReads.at(-1), 'Debian');
      for (const row of previous) assert.equal((await f.controller.inject(row.id, 'must not be sent', false)).ok, false);
      noInput();
    } finally { await f.cleanup(); }
  });
}
