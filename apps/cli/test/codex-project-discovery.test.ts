import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AppServerClient } from '../src/codex/app-server.js';
import { codexStateRevision, snapshotWslCodexState } from '../src/codex/wsl-state.js';
import { defaultConfig } from '../src/domain/config.js';
import { WatchdogController } from '../src/runtime/watchdog-controller.js';
import { AuditStore } from '../src/store/audit-store.js';
import { ConfigStore } from '../src/store/config-store.js';

const SELF = '01a1c977-e596-7c43-8848-6308b65eeb43';
const OTHER = '01a1c802-9e61-7231-9b1f-3496633c13b2';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-project-discovery-'));
  const home = join(root, 'state');
  await mkdir(home);
  const statePath = join(home, 'state_5.sqlite');
  const db = new DatabaseSync(statePath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, 1000, 2000)').run(SELF, '/work/Selbstlauf', 'Selbstlauf');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, 1000, 2000)').run(OTHER, '/work/Orchester', 'Orchester');
  // This historical thread is nearest the daemon launch, but does not own a live writer lock.
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, 1000, 2000)').run('historical', '/work', 'Old launcher directory');
  db.close();
  const configStore = new ConfigStore(join(root, 'config.json'));
  await configStore.save({ ...defaultConfig, enabled: false, dryRun: false });
  return { root, home, statePath, configStore, auditStore: new AuditStore(join(root, 'audit.jsonl')) };
}

function forbidModelInput(t: test.TestContext) {
  const initialize = t.mock.method(AppServerClient.prototype, 'initialize', async () => { throw new Error('Discovery cannot launch an input transport'); });
  const turn = t.mock.method(AppServerClient.prototype, 'startTurn', async () => { throw new Error('Discovery cannot send model input'); });
  return () => { assert.equal(initialize.mock.callCount(), 0); assert.equal(turn.mock.callCount(), 0); };
}

test('one shared Codex daemon exposes each actively owned project instead of its launch directory', async t => {
  const noInput = forbidModelInput(t);
  const f = await fixture();
  let owners = [{ pid: 100, threadId: SELF }, { pid: 100, threadId: OTHER }, { pid: 9999, threadId: 'foreign' }];
  const controller = new WatchdogController({
    ...f, platform: 'win32', currentProcessId: 50, codexStatePath: f.statePath,
    provider: { listProcesses: async () => [
      { pid: 50, parentPid: 1, name: 'Selbstlauf.exe', commandLine: null, executablePath: null, creationTimeMs: 1000, userSid: 'user' },
      { pid: 100, parentPid: 1, name: 'codex.exe', commandLine: 'codex.exe app-server --managed-daemon', arguments: ['codex.exe', 'app-server', '--managed-daemon'], executablePath: null, creationTimeMs: 1000, userSid: 'user', workingDirectory: '/work' },
    ] },
    codexThreadOwnerReader: async () => owners,
  });
  try {
    await controller.poll();
    const live = (await controller.list()).filter(row => row.alive);
    assert.deepEqual(live.map(row => row.sessionCwd).sort(), ['/work/Orchester', '/work/Selbstlauf']);
    assert.deepEqual(live.map(row => row.conversationId).sort(), [SELF, OTHER].sort());
    assert.ok(live.every(row => row.rootPid === 100));
    assert.equal(new Set(live.map(row => row.id)).size, 2);
    owners = [{ pid: 100, threadId: SELF }];
    await controller.poll();
    assert.equal((await controller.list()).find(row => row.conversationId === OTHER)?.alive, false, 'a released writer lock cannot stay live because its file/history exists');
    noInput();
  } finally { await controller.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test('a Codex app-server without verified active writers cannot claim a historical launch-directory thread', async t => {
  const noInput = forbidModelInput(t);
  const f = await fixture();
  const controller = new WatchdogController({
    ...f, platform: 'win32', currentProcessId: 50, codexStatePath: f.statePath,
    provider: { listProcesses: async () => [
      { pid: 50, parentPid: 1, name: 'Selbstlauf.exe', commandLine: null, executablePath: null, creationTimeMs: 1000, userSid: 'user' },
      { pid: 100, parentPid: 1, name: 'codex.exe', commandLine: 'codex.exe app-server', arguments: ['codex.exe', 'app-server'], executablePath: null, creationTimeMs: 1000, userSid: 'user', workingDirectory: '/work' },
    ] }, codexThreadOwnerReader: async () => [],
  });
  try {
    await controller.poll();
    assert.equal((await controller.list())[0]?.conversationId, null);
    assert.equal((await controller.list())[0]?.transport, 'monitor-only');
    noInput();
  } finally { await controller.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test('WSL projects refresh while the desktop stays running and an unchanged source reuses its snapshot', async t => {
  const noInput = forbidModelInput(t);
  const f = await fixture();
  await f.configStore.save({ ...defaultConfig, enabled: false, wslDistribution: 'Ubuntu' });
  let owners = [{ pid: 42, threadId: SELF }];
  const copies: string[] = [];
  const controller = new WatchdogController({
    ...f, platform: 'win32', provider: { listProcesses: async () => [] },
    codexThreadOwnerReader: async (_home, distribution) => distribution === 'Ubuntu' ? owners : [],
    wslRun: async (_distribution, script) => script.includes('ps -eo')
      ? '42\t1\tcodex\tcodex app-server --managed-daemon\t/work\t\t0\n'
      : script === 'printf %s "$HOME"' ? '/home/alice' : '/home/alice/bin/node\t/home/alice/bin/codex',
    wslStateRevision: () => codexStateRevision(f.home),
    wslStateSnapshot: () => {
      const snapshot = snapshotWslCodexState({ uncCodexHome: f.home })!;
      copies.push(snapshot.directory); return snapshot;
    },
  });
  try {
    await controller.poll();
    assert.equal((await controller.list()).find(row => row.alive)?.sessionCwd, '/work/Selbstlauf');
    assert.equal(copies.length, 1);
    await controller.poll(); assert.equal(copies.length, 1);
    const db = new DatabaseSync(f.statePath);
    db.prepare('UPDATE threads SET cwd=?, updated_at_ms=3000 WHERE id=?').run('/work/Selbstlauf-new', SELF);
    db.close();
    owners = [{ pid: 42, threadId: SELF }, { pid: 42, threadId: OTHER }];
    await controller.poll();
    const live = (await controller.list()).filter(row => row.alive);
    assert.deepEqual(live.map(row => row.sessionCwd).sort(), ['/work/Orchester', '/work/Selbstlauf-new']);
    assert.equal(copies.length, 2);
    assert.equal(existsSync(copies[0]!), false, 'old copies are removed after their readers release them');
    noInput();
  } finally { await controller.stop(); await rm(f.root, { recursive: true, force: true }); }
});
