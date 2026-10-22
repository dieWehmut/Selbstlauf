import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppServerClient } from '../src/codex/app-server.js';
import { CodexAdapter } from '../src/codex/codex-adapter.js';
import { snapshotWslCodexState } from '../src/codex/wsl-state.js';
import { defaultConfig } from '../src/domain/config.js';
import { WatchdogController } from '../src/runtime/watchdog-controller.js';
import { AuditStore } from '../src/store/audit-store.js';
import { ConfigStore } from '../src/store/config-store.js';

async function stateDatabase(directory: string, threadId: string, cwd: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(directory, 'state_5.sqlite');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)');
  database.prepare('INSERT INTO threads VALUES (?, ?, NULL, 1000, 2000)').run(threadId, cwd);
  database.close();
  return path;
}

async function fixture(initialDistribution: string | null) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-wsl-switch-'));
  const sources = { A: join(root, 'A'), B: join(root, 'B') };
  await stateDatabase(sources.A, 'thread-A', '/work/project');
  await stateDatabase(sources.B, 'thread-B', '/work/project');
  const nativeState = await stateDatabase(join(root, 'native'), 'thread-native', '/native/project');
  const store = new ConfigStore(join(root, 'config.json'));
  await store.save({ ...defaultConfig, enabled: true, dryRun: true, wslDistribution: initialDistribution ?? '' });
  const probes: { distribution: string; kind: string }[] = [];
  const snapshots: { distribution: string; directory: string; unc: string }[] = [];
  let blockedDiscovery: Promise<void> | null = null;
  let markDiscoveryStarted: (() => void) | null = null;
  let clock = 5000;
  const controller = new WatchdogController({
    configStore: store,
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    currentProcessId: 999,
    platform: 'win32',
    now: () => clock,
    codexStatePath: nativeState,
    codexGoalPath: nativeState,
    provider: { listProcesses: async () => {
      if (blockedDiscovery !== null) {
        markDiscoveryStarted?.();
        await blockedDiscovery;
      }
      return [{
      pid: 999, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js',
      executablePath: null, creationTimeMs: 1000, userSid: 'fixture',
    }, {
      pid: 100, parentPid: 1, name: 'node.exe', commandLine: 'node C:\\tools\\codex.js',
      executablePath: null, creationTimeMs: 1000, userSid: 'fixture', workingDirectory: '/native/project',
    }]; } },
    // Read-only probe responses are isolated from the user's installed WSL distributions.
    wslRun: async (distribution, script) => {
      const home = distribution === 'A' ? '/home/alice' : '/home/bob';
      if (script === 'printf %s "$HOME"') {
        probes.push({ distribution, kind: 'home' });
        return home;
      }
      if (script.includes('ps -eo')) {
        probes.push({ distribution, kind: 'processes' });
        return `42\t1\tnode\tnode ${home}/bin/codex\t/work/project\t\t0\n`;
      }
      probes.push({ distribution, kind: 'launch' });
      return `${home}/bin/node\t${home}/bin/codex`;
    },
    wslStateSnapshot: (options) => {
      const distribution = options.uncCodexHome.includes('\\A\\') ? 'A' : 'B';
      const snapshot = snapshotWslCodexState({ uncCodexHome: sources[distribution] });
      assert.ok(snapshot);
      snapshots.push({ distribution, directory: snapshot.directory, unc: options.uncCodexHome });
      return snapshot;
    },
  });
  return {
    controller, store, probes, snapshots,
    advanceClock(milliseconds: number) { clock += milliseconds; },
    blockNextDiscovery() {
      let release!: () => void;
      blockedDiscovery = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { markDiscoveryStarted = resolve; });
      return { started, release: () => { blockedDiscovery = null; release(); } };
    },
    async switchTo(distribution: string | null, notify = true) {
      const config = await store.save({ ...await store.load(), wslDistribution: distribution ?? '' });
      if (notify) await controller.configChanged(config);
    },
    async cleanup() {
      await controller.stop();
      for (const snapshot of snapshots) await rm(snapshot.directory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function forbidInput(t: test.TestContext) {
  const initialize = t.mock.method(AppServerClient.prototype, 'initialize', async () => { throw new Error('WSL discovery must not start an App Server'); });
  const queue = t.mock.method(AppServerClient.prototype, 'queuePrompt', async () => { throw new Error('Dry Run must not send a prompt'); });
  const start = t.mock.method(AppServerClient.prototype, 'startTurn', async () => { throw new Error('Dry Run must not start a turn'); });
  return () => {
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(queue.mock.callCount(), 0);
    assert.equal(start.mock.callCount(), 0);
  };
}

for (const viaDisabled of [false, true]) {
  test(`switching WSL A → ${viaDisabled ? 'disabled → ' : ''}B releases A and reads B's state, home, and launcher`, async (t) => {
    const assertNoInput = forbidInput(t);
    const closed = t.mock.method(CodexAdapter.prototype, 'close');
    const f = await fixture('A');
    try {
      await f.controller.poll();
      assert.equal((await f.controller.list()).find((row) => row.distribution === 'A')?.conversationId, 'thread-A');
      assert.equal(f.snapshots.length, 1);
      const oldSnapshot = f.snapshots[0]!.directory;
      if (viaDisabled) {
        await f.switchTo(null);
        await f.controller.poll();
      }
      await f.switchTo('B');
      assert.equal((await f.controller.list()).filter((row) => row.distribution !== undefined).length, 0, 'saving the new distribution must release old WSL sessions immediately');
      assert.equal(existsSync(oldSnapshot), false, 'the old database copy must be removed after its adapter closes');
      assert.equal(closed.mock.callCount(), 1, 'only the old WSL adapter should close');
      await f.controller.poll();
      const rows = await f.controller.list();
      assert.equal(rows.find((row) => row.distribution === 'B')?.conversationId, 'thread-B', 'same cwd in B must not associate a thread from A');
      assert.equal(rows.find((row) => row.distribution === undefined)?.conversationId, 'thread-native', 'native Codex association must remain intact');
      assert.equal(rows.find((row) => row.distribution === undefined)?.alive, true);
      assert.deepEqual(f.probes.filter((probe) => probe.kind !== 'processes'), [
        { distribution: 'A', kind: 'home' }, { distribution: 'A', kind: 'launch' },
        { distribution: 'B', kind: 'home' }, { distribution: 'B', kind: 'launch' },
      ]);
      assert.equal(f.snapshots[1]?.unc, '\\\\wsl.localhost\\B\\home\\bob\\.codex');
      await f.controller.poll();
      assert.equal(f.snapshots.length, 2, 'unchanged distribution should reuse its current working copy');
      await f.switchTo(' B ');
      assert.equal(f.snapshots.length, 2);
      assert.equal((await f.controller.list()).find((row) => row.distribution === 'B')?.conversationId, 'thread-B');
      assert.equal(closed.mock.callCount(), 1, 'saving the same trimmed distribution must not close its adapter');
      const b = rows.find((row) => row.distribution === 'B')!;
      assert.deepEqual(await f.controller.inject(b.id, 'fixture prompt', true), { ok: true, dryRun: true, prompt: 'fixture prompt' });
      assertNoInput();
    } finally {
      await f.cleanup();
    }
  });
}

test('enabling WSL from null resolves the selected distribution without stale state', async (t) => {
  const assertNoInput = forbidInput(t);
  const f = await fixture(null);
  try {
    await f.controller.poll();
    assert.equal(f.probes.length, 0);
    assert.equal(f.snapshots.length, 0);
    await f.switchTo('B');
    await f.controller.poll();
    assert.equal((await f.controller.list()).find((row) => row.distribution === 'B')?.conversationId, 'thread-B');
    assert.equal(f.snapshots[0]?.unc, '\\\\wsl.localhost\\B\\home\\bob\\.codex');
    assertNoInput();
  } finally {
    await f.cleanup();
  }
});

test('polling a changed persisted distribution releases the old cache without a configChanged callback', async (t) => {
  const assertNoInput = forbidInput(t);
  const closed = t.mock.method(CodexAdapter.prototype, 'close');
  const f = await fixture('A');
  try {
    await f.controller.poll();
    const oldSnapshot = f.snapshots[0]!.directory;
    await f.switchTo('B', false);
    await f.controller.poll();
    assert.equal((await f.controller.list()).find((row) => row.distribution === 'B')?.conversationId, 'thread-B');
    assert.equal(existsSync(oldSnapshot), false);
    assert.equal(closed.mock.callCount(), 1);
    assertNoInput();
  } finally {
    await f.cleanup();
  }
});

test('restarting the same controller refreshes paths after shutdown deletes its snapshot', async (t) => {
  const assertNoInput = forbidInput(t);
  const f = await fixture('A');
  try {
    await f.controller.start();
    const oldSnapshot = f.snapshots[0]!.directory;
    await f.controller.stop();
    assert.equal(existsSync(oldSnapshot), false);
    await f.controller.start();
    assert.equal((await f.controller.list()).find((row) => row.distribution === 'A')?.conversationId, 'thread-A');
    assert.equal(f.snapshots.length, 2, 'restart must not retain a path inside the deleted snapshot');
    assert.notEqual(f.snapshots[1]!.directory, oldSnapshot);
    assert.equal(f.probes.filter((probe) => probe.kind === 'home').length, 2);
    assert.equal(f.probes.filter((probe) => probe.kind === 'launch').length, 2);
    assertNoInput();
  } finally {
    await f.cleanup();
  }
});

test('saving a new distribution waits for the old read-only poll before releasing its readers', async (t) => {
  const assertNoInput = forbidInput(t);
  const f = await fixture('A');
  let release: (() => void) | undefined;
  try {
    await f.controller.poll();
    const oldSnapshot = f.snapshots[0]!.directory;
    const blocked = f.blockNextDiscovery();
    release = blocked.release;
    const poll = f.controller.poll();
    await blocked.started;
    let changed = false;
    const change = f.switchTo('B').then(() => { changed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(changed, false, 'configChanged should await the in-flight poll');
    assert.equal(existsSync(oldSnapshot), true, 'old readers still need their snapshot during discovery');
    blocked.release();
    await Promise.all([poll, change]);
    assert.equal(existsSync(oldSnapshot), false);
    assert.equal((await f.controller.list()).some((row) => row.distribution === 'A'), false);
    await f.controller.poll();
    assert.equal((await f.controller.list()).find((row) => row.distribution === 'B')?.conversationId, 'thread-B');
    assertNoInput();
  } finally {
    release?.();
    await f.cleanup();
  }
});

for (const policy of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }]) {
  test(`a pending WSL discovery obeys immediately saved enabled=${policy.enabled}, dryRun=${policy.dryRun} before it can continue`, async (t) => {
    const assertNoInput = forbidInput(t);
    const f = await fixture('A');
    let release: (() => void) | undefined;
    try {
      await f.store.save({ ...await f.store.load(), enabled: true, dryRun: false, defaultIdleTimeoutMs: 1, defaultCooldownMs: 1 });
      await f.controller.poll();
      f.advanceClock(100);
      const blocked = f.blockNextDiscovery();
      release = blocked.release;
      const poll = f.controller.poll();
      await blocked.started;
      const disabled = await f.store.save({ ...await f.store.load(), ...policy, wslDistribution: 'B' });
      const change = f.controller.configChanged(disabled);
      blocked.release();
      await Promise.all([poll, change]);
      assertNoInput();
      assert.equal((await f.controller.list()).find((row) => row.distribution === undefined)?.enabled, policy.enabled);
    } finally {
      release?.();
      await f.cleanup();
    }
  });
}
