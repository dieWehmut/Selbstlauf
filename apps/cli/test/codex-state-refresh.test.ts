import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AppServerClient, type AppServerChild } from '../src/codex/app-server.js';
import { CodexAdapter, type CodexContinuationContext } from '../src/codex/codex-adapter.js';
import type { CodexStateReader } from '../src/codex/sqlite-state.js';
import { snapshotWslCodexState, type WslStateSnapshot } from '../src/codex/wsl-state.js';

// Compiled tests live in apps/cli/dist/test; keep all state fixtures inside the ignored project directory.
const fixtureDirectory = fileURLToPath(new URL('../../../../tmp/project-discovery-fix-20261111/state/', import.meta.url));
const firstThread = '019e9d1c-d87e-7fa1-b17c-2df1e400e882';
const secondThread = '019e9d1c-d87e-7fa1-b17c-2df1e400e883';

function context(cwd: string, creationTimeMs = 1_000): CodexContinuationContext {
  return { commandLine: 'codex', arguments: ['codex'], cwd, creationTimeMs };
}

function createFixture(): {
  root: string;
  states: DatabaseSync;
  goals: DatabaseSync;
  snapshot: () => WslStateSnapshot;
  close: () => void;
} {
  mkdirSync(fixtureDirectory, { recursive: true });
  const root = mkdtempSync(join(fixtureDirectory, 'adapter-refresh-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const states = new DatabaseSync(join(source, 'state_5.sqlite'));
  const goals = new DatabaseSync(join(source, 'goals_1.sqlite'));
  states.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
  states.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)')
    .run(firstThread, '/fixture/original', 'original project', 1_000, 2_000);
  goals.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
  goals.prepare('INSERT INTO thread_goals VALUES (?, ?, ?)').run(firstThread, 'paused', 2_000);
  return {
    root,
    states,
    goals,
    snapshot: () => {
      const result = snapshotWslCodexState({
        uncCodexHome: source,
        targetDirectory: mkdtempSync(join(root, 'snapshot-')),
      });
      assert.ok(result);
      return result;
    },
    close: () => {
      states.close();
      goals.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface CapturedRequest {
  readonly id?: number;
  readonly method: string;
}

/** Only a local fake handshake/read response is sent; no Codex process or model request is started. */
class ConnectedChild extends EventEmitter implements AppServerChild {
  public readonly stdout = new EventEmitter();
  public readonly requests: CapturedRequest[] = [];
  public killed = false;
  public ended = false;
  public readonly stdin = {
    write: (chunk: string): boolean => {
      const request = JSON.parse(chunk) as CapturedRequest;
      this.requests.push(request);
      if (request.method === 'initialize') queueMicrotask(() => this.respond(request, {}));
      return true;
    },
    end: (): void => { this.ended = true; },
  };

  public respond(request: CapturedRequest, result: object): void {
    assert.equal(typeof request.id, 'number');
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`));
  }

  public kill(): boolean {
    this.killed = true;
    this.emit('close', 0);
    return true;
  }
}

test('refreshing an owned Codex snapshot reads new threads, moved cwd, and goals without closing its connection', async () => {
  const fixture = createFixture();
  const first = fixture.snapshot();
  const child = new ConnectedChild();
  let spawnCount = 0;
  const appServer = new AppServerClient({
    command: 'fake-codex',
    spawn: () => { spawnCount++; return child; },
  });
  const adapter = new CodexAdapter({ statePath: first.statePath, goalPath: first.goalPath, appServer });
  try {
    adapter.configurePolicy({ normalPrompt: '检查最新进度', goalPrompt: '/goal 自定义恢复', goalStatuses: ['active'] });
    await appServer.initialize();
    assert.equal(adapter.hasConnectedAppServer, true);
    assert.deepEqual(adapter.getGoal(context('/fixture/original')), { status: 'paused', updatedAtMs: 2_000 });

    fixture.states.prepare('UPDATE threads SET cwd = ?, title = ?, updated_at_ms = ? WHERE id = ?')
      .run('/fixture/moved', 'moved project', 3_000, firstThread);
    fixture.states.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)')
      .run(secondThread, '/fixture/new', 'new project', 4_000, 4_000);
    fixture.goals.prepare('UPDATE thread_goals SET status = ?, updated_at_ms = ? WHERE thread_id = ?')
      .run('active', 5_000, firstThread);
    fixture.goals.prepare('INSERT INTO thread_goals VALUES (?, ?, ?)').run(secondThread, 'paused', 6_000);

    assert.equal(adapter.associate(context('/fixture/moved')).kind, 'unmatched');
    assert.equal(adapter.associate(context('/fixture/new', 4_000)).kind, 'unmatched');
    assert.deepEqual(adapter.getGoal(context('/fixture/original')), { status: 'paused', updatedAtMs: 2_000 });

    const pendingRead = appServer.listThreads({ limit: 2 });
    await Promise.resolve();
    const request = child.requests.at(-1)!;
    assert.equal(request.method, 'thread/list');
    const writesBeforeRefresh = child.requests.length;
    const second = fixture.snapshot();
    adapter.refreshState(second.statePath, second.goalPath);

    assert.equal(adapter.hasConnectedAppServer, true);
    assert.equal(spawnCount, 1, 'refresh preserves the connected App Server instance');
    assert.equal(child.killed, false);
    assert.equal(child.ended, false);
    assert.equal(child.requests.length, writesBeforeRefresh, 'refresh does not send transport requests');
    child.respond(request, { data: [] });
    assert.deepEqual(await pendingRead, { data: [] }, 'an outstanding App Server read survives refresh');

    rmSync(first.directory, { recursive: true, force: true });
    assert.equal(adapter.associate(context('/fixture/original')).kind, 'unmatched');
    const moved = adapter.associate(context('/fixture/moved'));
    assert.equal(moved.kind, 'matched');
    if (moved.kind === 'matched') {
      assert.equal(moved.thread.id, firstThread);
      assert.equal(moved.thread.cwd, '/fixture/moved');
      assert.equal(moved.thread.title, 'moved project');
    }
    assert.deepEqual(await adapter.getContinuation(context('/fixture/moved')), {
      kind: 'inject',
      threadId: firstThread,
      prompt: '/goal 自定义恢复',
      goal: { status: 'active', updatedAtMs: 5_000 },
    });
    assert.deepEqual(await adapter.getContinuation(context('/fixture/new', 4_000)), {
      kind: 'inject',
      threadId: secondThread,
      prompt: '检查最新进度',
      goal: { status: 'paused', updatedAtMs: 6_000 },
    });
  } finally {
    adapter.close();
    assert.equal(child.killed, true, 'normal adapter shutdown still owns the transport');
    fixture.close();
  }
});

test('a corrupt or missing replacement snapshot leaves the previous Codex reader and connection usable', async () => {
  const fixture = createFixture();
  const first = fixture.snapshot();
  const child = new ConnectedChild();
  const appServer = new AppServerClient({ command: 'fake-codex', spawn: () => child });
  const adapter = new CodexAdapter({ statePath: first.statePath, goalPath: first.goalPath, appServer });
  try {
    await appServer.initialize();
    const corruptPath = join(fixture.root, 'corrupt.sqlite');
    writeFileSync(corruptPath, 'this is not a SQLite database');
    const missingPath = join(fixture.root, 'missing.sqlite');
    for (const [statePath, goalPath] of [
      [missingPath, undefined],
      [corruptPath, first.goalPath],
      [first.statePath, corruptPath],
    ] as const) {
      assert.throws(() => adapter.refreshState(statePath, goalPath));
      assert.equal(adapter.associate(context('/fixture/original')).kind, 'matched');
      assert.deepEqual(adapter.getGoal(context('/fixture/original')), { status: 'paused', updatedAtMs: 2_000 });
      assert.equal(adapter.hasConnectedAppServer, true);
      assert.equal(child.killed, false);
      assert.equal(child.ended, false);
    }
    assert.equal(existsSync(missingPath), false, 'replacement readers never create missing databases');
  } finally {
    adapter.close();
    fixture.close();
  }
});

test('Codex snapshot refresh supports goals stored in the same database', async () => {
  const fixture = createFixture();
  let adapter: CodexAdapter | undefined;
  try {
    fixture.states.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at_ms INTEGER)');
    fixture.states.prepare('INSERT INTO thread_goals VALUES (?, ?, ?)').run(firstThread, 'active', 7_000);
    const first = fixture.snapshot();
    adapter = new CodexAdapter({ statePath: first.statePath });
    assert.deepEqual(adapter.getGoal(context('/fixture/original')), { status: 'active', updatedAtMs: 7_000 });
    fixture.states.prepare('UPDATE thread_goals SET status = ?, updated_at_ms = ? WHERE thread_id = ?')
      .run('complete', 8_000, firstThread);
    const second = fixture.snapshot();
    adapter.refreshState(second.statePath);
    assert.deepEqual(await adapter.getContinuation(context('/fixture/original')), { kind: 'skip', reason: 'terminal-goal' });
  } finally {
    adapter?.close();
    fixture.close();
  }
});

test('CodexAdapter explicitly rejects replacing an injected stateReader', () => {
  let readerClosed = false;
  const reader: CodexStateReader = {
    listThreads: () => [{ id: firstThread, cwd: '/fixture/injected', rolloutPath: null, createdAtMs: 1_000, updatedAtMs: 2_000, status: null }],
    getGoal: () => ({ status: 'active', updatedAtMs: 2_000 }),
    close: () => { readerClosed = true; },
  };
  const adapter = new CodexAdapter({ stateReader: reader });
  try {
    assert.throws(() => adapter.refreshState('unused.sqlite'), {
      name: 'TypeError',
      message: /cannot refresh an injected stateReader/,
    });
    assert.deepEqual(adapter.getGoal(context('/fixture/injected')), { status: 'active', updatedAtMs: 2_000 });
    assert.equal(readerClosed, false);
  } finally {
    adapter.close();
  }
  assert.equal(readerClosed, false, 'the caller keeps ownership of its injected reader');
});
