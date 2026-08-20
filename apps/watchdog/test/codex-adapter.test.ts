import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
  CodexAdapter,
  type CodexContinuationContext,
} from '../src/codex/codex-adapter.js';
import {
  AppServerClient,
  type AppServerChild,
  type AppServerSpawn,
} from '../src/codex/app-server.js';
import {
  extractResumeThreadId,
  associateCodexThread,
  type CodexThreadRecord,
} from '../src/codex/thread-association.js';
import {
  openCodexState,
  UnsupportedSqliteRuntimeError,
  type CodexStateReader,
} from '../src/codex/sqlite-state.js';

async function makeStateDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-cli-bypass-codex-'));
  const path = join(dir, 'goals.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      token_budget INTEGER,
      tokens_used INTEGER,
      time_used_seconds REAL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO thread_goals
      (thread_id, goal_id, objective, status, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('thread-active', 'goal-1', 'keep going', 'active', 1_000, 2_500);
  db.prepare(
    `INSERT INTO thread_goals
      (thread_id, goal_id, objective, status, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('thread-done', 'goal-2', 'finished', 'complete', 1_000, 3_000);
  db.close();
  return {
    path,
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('extracts a UUID only when it follows the Codex resume command', () => {
  assert.equal(
    extractResumeThreadId('node codex.js resume 01a01234-1234-4abc-8def-0123456789ab'),
    '01a01234-1234-4abc-8def-0123456789ab',
  );
  assert.equal(extractResumeThreadId('node codex.js --last'), null);
  assert.equal(extractResumeThreadId('node codex.js resume not-a-uuid'), null);
  assert.equal(
    extractResumeThreadId('codex resume 019e9d1c-d87e-7fa1-b17c-2df1e400e882'),
    '019e9d1c-d87e-7fa1-b17c-2df1e400e882',
  );
});

test('reads a real-shaped split Codex thread and goal database without requiring a thread status column', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-cli-bypass-codex-split-'));
  const threadsPath = join(root, 'state.sqlite');
  const goalsPath = join(root, 'goals.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const threadsDb = new DatabaseSync(threadsPath);
  threadsDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
  `);
  threadsDb.prepare(
    'INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    '019e9d1c-d87e-7fa1-b17c-2df1e400e882',
    'C:/rollout.jsonl',
    1_000,
    2_000,
    'C:/work/project',
    'fixture',
    null,
    null,
  );
  threadsDb.close();
  const goalsDb = new DatabaseSync(goalsPath);
  goalsDb.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
  goalsDb.prepare(
    'INSERT INTO thread_goals (thread_id, goal_id, objective, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('019e9d1c-d87e-7fa1-b17c-2df1e400e882', 'goal', 'fixture', 'active', 1_000, 2_500);
  goalsDb.close();
  try {
    const reader = openCodexState(threadsPath, { goalPath: goalsPath });
    assert.deepEqual(reader.listThreads(), [
      {
        id: '019e9d1c-d87e-7fa1-b17c-2df1e400e882',
        cwd: 'C:/work/project',
        rolloutPath: 'C:/rollout.jsonl',
        createdAtMs: 1_000_000,
        updatedAtMs: 2_000_000,
        status: null,
      },
    ]);
    assert.deepEqual(reader.getGoal('019e9d1c-d87e-7fa1-b17c-2df1e400e882'), {
      status: 'active',
      updatedAtMs: 2_500,
    });
    reader.close();

    const adapter = new CodexAdapter({ statePath: threadsPath, goalPath: goalsPath });
    assert.deepEqual(
      await adapter.getContinuation({
        commandLine: 'codex resume 019e9d1c-d87e-7fa1-b17c-2df1e400e882',
        cwd: 'C:/work/project',
        creationTimeMs: 1_000_000,
      }),
      {
        kind: 'inject',
        threadId: '019e9d1c-d87e-7fa1-b17c-2df1e400e882',
        prompt: '/goal resume',
        goal: { status: 'active', updatedAtMs: 2_500 },
      },
    );
    adapter.close();
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('reads only goal status and update time from a read-only SQLite state database', async () => {
  const state = await makeStateDb();
  try {
    const reader = openCodexState(state.path);
    assert.deepEqual(reader.getGoal('thread-active'), {
      status: 'active',
      updatedAtMs: 2_500,
    });
    assert.deepEqual(reader.getGoal('thread-done'), {
      status: 'complete',
      updatedAtMs: 3_000,
    });
    assert.equal(reader.getGoal('missing'), null);
    reader.close();
    const { DatabaseSync } = await import('node:sqlite');
    const readonlyDb = new DatabaseSync(`${pathToFileURL(state.path).href}?mode=ro`, { readOnly: true });
    assert.throws(
      () => readonlyDb.exec("DELETE FROM thread_goals WHERE thread_id = 'thread-active'"),
      /readonly/i,
    );
    readonlyDb.close();
  } finally {
    await state.cleanup();
  }
});

test('returns an explicit unsupported-runtime error when node:sqlite is unavailable', () => {
  assert.throws(
    () => openCodexState('ignored.sqlite', { sqliteModule: null }),
    (error: unknown) => error instanceof UnsupportedSqliteRuntimeError && /node:sqlite/.test(String(error)),
  );
});

test('does not guess when two equally recent threads match an initial command', () => {
  const records: CodexThreadRecord[] = [
    {
      id: 'thread-a',
      cwd: 'C:\\Work\\Project',
      createdAtMs: 10_000,
      updatedAtMs: 20_000,
      rolloutPath: null,
    },
    {
      id: 'thread-b',
      cwd: 'c:/work/project',
      createdAtMs: 10_000,
      updatedAtMs: 20_000,
      rolloutPath: null,
    },
  ];
  const result = associateCodexThread(
    {
      commandLine: 'codex --full-auto',
      cwd: 'C:/work/project',
      creationTimeMs: 10_500,
    },
    records,
  );
  assert.equal(result.kind, 'ambiguous');
  assert.deepEqual(result.candidates, ['thread-a', 'thread-b']);
});

test('matches an explicit resume UUID and reports rollout activity changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-cli-bypass-rollout-'));
  const rollout = join(dir, 'rollout.jsonl');
  await writeFile(rollout, '{"type":"turn.started"}\n', 'utf8');
  try {
    const records: CodexThreadRecord[] = [
      {
        id: '01a01234-1234-4abc-8def-0123456789ab',
        cwd: dir,
        createdAtMs: 1_000,
        updatedAtMs: 2_000,
        rolloutPath: rollout,
      },
    ];
    const result = associateCodexThread(
      {
        commandLine: `codex resume ${records[0].id}`,
        cwd: dir,
        creationTimeMs: 3_000,
      },
      records,
    );
    assert.equal(result.kind, 'matched');
    if (result.kind !== 'matched') return;
    const before = await result.activity.snapshot();
    assert.equal(before.exists, true);
    await writeFile(rollout, '{"type":"turn.started"}\n{"type":"item.completed"}\n', 'utf8');
    const after = await result.activity.snapshot();
    assert.equal(after.changed, true);
    assert.ok(after.size > before.size);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports rollout creation and removal as activity transitions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-cli-bypass-rollout-transition-'));
  const rollout = join(dir, 'rollout.jsonl');
  try {
    const result = associateCodexThread(
      {
        commandLine: 'codex --full-auto',
        cwd: dir,
        creationTimeMs: 1_000,
      },
      [{ id: 'thread-transition', cwd: dir, createdAtMs: 1_000, updatedAtMs: 1_000, rolloutPath: rollout }],
    );
    assert.equal(result.kind, 'matched');
    if (result.kind !== 'matched') return;
    const missing = await result.activity.snapshot();
    assert.equal(missing.exists, false);
    await writeFile(rollout, 'first\n', 'utf8');
    const created = await result.activity.snapshot();
    assert.equal(created.exists, true);
    assert.equal(created.changed, true);
    const stable = await result.activity.snapshot();
    assert.equal(stable.changed, false);
    const { rm } = await import('node:fs/promises');
    await rm(rollout);
    const removed = await result.activity.snapshot();
    assert.equal(removed.exists, false);
    assert.equal(removed.changed, true);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeChild implements AppServerChild {
  readonly stdin = new WritableCapture();
  readonly stdout = new ReadableQueue();
  readonly stderr = new ReadableQueue();
  killed = false;
  private readonly closeListeners: Array<(code: number | null) => void> = [];

  on(event: 'close' | 'error', listener: (...args: any[]) => void): this {
    if (event === 'close') this.closeListeners.push(listener);
    return this;
  }

  kill(): boolean {
    this.killed = true;
    for (const listener of this.closeListeners) listener(0);
    return true;
  }
}

class WritableCapture {
  readonly writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    return;
  }
}

class ReadableQueue {
  private listeners: Array<(chunk: Buffer) => void> = [];
  on(event: 'data' | 'error' | 'end', listener: (...args: any[]) => void): this {
    if (event === 'data') this.listeners.push(listener as (chunk: Buffer) => void);
    return this;
  }
  push(line: string): void {
    for (const listener of this.listeners) listener(Buffer.from(line));
  }
}

async function waitForWrites(child: FakeChild, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && child.stdin.writes.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(child.stdin.writes.length >= count, `expected ${count} App Server writes`);
}

test('App Server client performs lazy initialize, resumes and starts one turn', async () => {
  const child = new FakeChild();
  const spawn: AppServerSpawn = () => child;
  const client = new AppServerClient({ spawn, command: 'fake-codex' });

  const initialize = client.initialize();
  const firstRequest = JSON.parse(child.stdin.writes[0]);
  assert.equal(firstRequest.method, 'initialize');
  child.stdout.push(JSON.stringify({ id: firstRequest.id, result: { protocolVersion: 1 } }) + '\n');
  child.stdout.push(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  await initialize;

  const resume = client.resumeThread('thread-active');
  await Promise.resolve();
  const resumeRequest = JSON.parse(child.stdin.writes[2]);
  assert.equal(resumeRequest.method, 'thread/resume');
  child.stdout.push(JSON.stringify({ id: resumeRequest.id, result: { thread: { id: 'thread-active' } } }) + '\n');
  await resume;

  const turn = client.startTurn('thread-active', '继续');
  await Promise.resolve();
  const turnRequest = JSON.parse(child.stdin.writes[3]);
  assert.equal(turnRequest.method, 'turn/start');
  child.stdout.push(JSON.stringify({ id: turnRequest.id, result: { turn: { id: 'turn-1' } } }) + '\n');
  await turn;
  assert.throws(() => client.startTurn('thread-active', '再次'), /concurrent|active turn/i);
  client.close();
  assert.equal(child.killed, true);
});

test('App Server client handles thread listing and forwards notifications from a fake child', async () => {
  const child = new FakeChild();
  const notifications: string[] = [];
  const client = new AppServerClient({
    spawn: () => child,
    onNotification: (notification) => notifications.push(notification.method),
  });
  try {
    const listing = client.listThreads({ limit: 5 });
    const initializeRequest = JSON.parse(child.stdin.writes[0]);
    child.stdout.push(JSON.stringify({ id: initializeRequest.id, result: { protocolVersion: 1 } }) + '\n');
    await waitForWrites(child, 3);
    const listRequest = JSON.parse(child.stdin.writes[2]);
    assert.equal(listRequest.method, 'thread/list');
    assert.deepEqual(listRequest.params, { limit: 5 });
    child.stdout.push(JSON.stringify({ method: 'thread/status/changed', params: { status: 'working' } }) + '\n');
    child.stdout.push(JSON.stringify({ id: listRequest.id, result: { data: [] } }) + '\n');
    await listing;
    assert.deepEqual(notifications, ['thread/status/changed']);
  } finally {
    client.close();
  }
});

test('App Server client exchanges JSON-RPC with a real fake-child process', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-codex-app-server.js', import.meta.url));
  const notifications: string[] = [];
  const client = new AppServerClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 5_000,
    onNotification: (notification) => notifications.push(notification.method),
  });
  try {
    assert.deepEqual(await client.listThreads(), { data: [{ id: 'thread-fixture' }] });
    assert.deepEqual(await client.resumeThread('thread-fixture'), { thread: { id: 'thread-fixture' } });
    assert.deepEqual(await client.startTurn('thread-fixture', 'continue'), {
      turn: { id: 'turn-fixture' },
    });
    for (let attempt = 0; attempt < 20 && !notifications.includes('turn/completed'); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(notifications, ['fixture/ignored', 'turn/completed']);
  } finally {
    client.close();
  }
});

test('CodexAdapter chooses goal prompt only for resumable goals', async () => {
  const state = await makeStateDb();
  try {
    const adapter = new CodexAdapter({ statePath: state.path, normalPrompt: '继续', goalPrompt: '/goal resume' });
    const context: CodexContinuationContext = {
      commandLine: 'codex resume thread-active',
      cwd: process.cwd(),
      creationTimeMs: 1_000,
      threadRecords: [
        {
          id: 'thread-active',
          cwd: process.cwd(),
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
          rolloutPath: null,
        },
      ],
    };
    const decision = await adapter.getContinuation(context);
    assert.deepEqual(decision, {
      kind: 'inject',
      threadId: 'thread-active',
      prompt: '/goal resume',
      goal: { status: 'active', updatedAtMs: 2_500 },
    });
    adapter.close();
  } finally {
    await state.cleanup();
  }
});

test('CodexAdapter routes paused, absent, terminal, and unknown goals safely', async () => {
  const goals = new Map<string, { status: 'paused' | 'complete' | 'unknown' }>([
    ['paused-thread', { status: 'paused' }],
    ['complete-thread', { status: 'complete' }],
    ['unknown-thread', { status: 'unknown' }],
  ]);
  const reader: CodexStateReader = {
    getGoal: (threadId) => goals.get(threadId) ?? null,
    listThreads: () => [],
    close: () => undefined,
  };
  const adapter = new CodexAdapter({ stateReader: reader, normalPrompt: '继续' });
  const decide = (id: string) => adapter.getContinuation({
    commandLine: 'codex',
    cwd: process.cwd(),
    creationTimeMs: 1_000,
    threadRecords: [{
      id,
      cwd: process.cwd(),
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      rolloutPath: null,
    }],
  });

  assert.equal((await decide('paused-thread')).kind, 'inject');
  assert.equal((await decide('paused-thread') as { prompt: string }).prompt, '/goal resume');
  assert.equal((await decide('normal-thread') as { prompt: string }).prompt, '继续');
  assert.deepEqual(await decide('complete-thread'), { kind: 'skip', reason: 'terminal-goal' });
  assert.deepEqual(await decide('unknown-thread'), { kind: 'skip', reason: 'unknown-goal-status' });
  adapter.close();
});

test('CodexAdapter resumes the associated App Server thread before starting a turn', async () => {
  const calls: string[] = [];
  const appServer = {
    resumeThread: async (threadId: string) => {
      calls.push(`resume:${threadId}`);
      return {};
    },
    startTurn: async (threadId: string, prompt: string) => {
      calls.push(`turn:${threadId}:${prompt}`);
      return {};
    },
    close: () => undefined,
  } as unknown as AppServerClient;
  const reader: CodexStateReader = {
    getGoal: () => null,
    listThreads: () => [],
    close: () => undefined,
  };
  const adapter = new CodexAdapter({ stateReader: reader, appServer, normalPrompt: '继续' });

  await adapter.injectContinuation({
    commandLine: 'codex',
    cwd: process.cwd(),
    creationTimeMs: 1_000,
    threadRecords: [{
      id: 'thread-normal',
      cwd: process.cwd(),
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      rolloutPath: null,
    }],
  });

  assert.deepEqual(calls, ['resume:thread-normal', 'turn:thread-normal:继续']);
  adapter.close();
});
