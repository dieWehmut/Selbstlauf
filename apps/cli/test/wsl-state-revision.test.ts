import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openCodexState } from '../src/codex/sqlite-state.js';
import { codexStateRevision, snapshotWslCodexState } from '../src/codex/wsl-state.js';

// Compiled tests live in apps/cli/dist/test; keep all fixture copies inside the ignored project directory.
const fixtureDirectory = fileURLToPath(new URL('../../../../tmp/project-discovery-fix-20261111/state/', import.meta.url));

function fixture(prefix: string): string {
  mkdirSync(fixtureDirectory, { recursive: true });
  return mkdtempSync(join(fixtureDirectory, prefix));
}

function createThreads(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      rollout_path TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    INSERT INTO threads VALUES ('thread-old', '/project/old', NULL, 1000, 2000);
  `);
  return database;
}

function createGoals(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    INSERT INTO thread_goals VALUES ('thread-old', 'active', 2000);
  `);
  return database;
}

function fileMetadata(path: string): { size: number; mtimeMs: number } {
  const metadata = statSync(path);
  return { size: metadata.size, mtimeMs: metadata.mtimeMs };
}

function sourceManifest(directory: string): readonly unknown[] {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    return {
      name,
      ...fileMetadata(path),
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  });
}

test('Codex revisions report missing homes, non-directories, and homes without state as absent', () => {
  const source = fixture('revision-missing-');
  try {
    assert.equal(codexStateRevision(join(source, 'missing')), null);
    writeFileSync(join(source, 'config.toml'), 'fixture = true');
    writeFileSync(join(source, 'goals_1.sqlite'), 'goals alone do not identify state');
    assert.equal(codexStateRevision(source), null);
    assert.equal(codexStateRevision(join(source, 'config.toml')), null);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test('Codex revisions tolerate a state file disappearing before stat', { skip: process.platform === 'win32' }, () => {
  const source = fixture('revision-unstatable-');
  try {
    symlinkSync(join(source, 'missing.sqlite'), join(source, 'state_5.sqlite'));
    assert.equal(codexStateRevision(source), null);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test('Codex revisions detect committed thread inserts and cwd updates held only in WAL', () => {
  const source = fixture('revision-thread-wal-');
  const statePath = join(source, 'state_5.sqlite');
  const writer = createThreads(statePath);
  try {
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const originalMain = readFileSync(statePath);
    const originalMetadata = fileMetadata(statePath);
    const initialRevision = codexStateRevision(source);
    assert.ok(initialRevision);

    writer.exec("INSERT INTO threads VALUES ('thread-new', '/project/new', NULL, 3000, 3000)");
    const insertedRevision = codexStateRevision(source);
    assert.ok(insertedRevision);
    assert.notEqual(insertedRevision, initialRevision);
    assert.deepEqual(readFileSync(statePath), originalMain, 'the inserted thread lives only in WAL');
    assert.deepEqual(fileMetadata(statePath), originalMetadata);

    writer.exec("UPDATE threads SET cwd = '/project/moved', updated_at_ms = 4000 WHERE id = 'thread-old'");
    const movedRevision = codexStateRevision(source);
    assert.ok(movedRevision);
    assert.notEqual(movedRevision, insertedRevision);
    assert.deepEqual(readFileSync(statePath), originalMain, 'the cwd update lives only in WAL');
    assert.deepEqual(fileMetadata(statePath), originalMetadata);

    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.notEqual(codexStateRevision(source), movedRevision, 'checkpointing is also a source revision');
  } finally {
    writer.close();
    rmSync(source, { recursive: true, force: true });
  }
});

test('Codex revisions detect goal creation and WAL changes, and follow selected database versions', () => {
  const source = fixture('revision-goal-version-');
  const statePath = join(source, 'state_5.sqlite');
  createThreads(statePath).close();
  let goalWriter: DatabaseSync | undefined;
  try {
    const noGoalRevision = codexStateRevision(source);
    assert.ok(noGoalRevision);

    const goalPath = join(source, 'goals_1.sqlite');
    goalWriter = createGoals(goalPath);
    goalWriter.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const newGoalRevision = codexStateRevision(source);
    assert.ok(newGoalRevision);
    assert.notEqual(newGoalRevision, noGoalRevision);
    const originalGoal = readFileSync(goalPath);
    goalWriter.exec("UPDATE thread_goals SET status = 'paused', updated_at_ms = 3000 WHERE thread_id = 'thread-old'");
    assert.notEqual(codexStateRevision(source), newGoalRevision);
    assert.deepEqual(readFileSync(goalPath), originalGoal, 'the goal update lives only in WAL');
    goalWriter.close();
    goalWriter = undefined;

    const selectedRevision = codexStateRevision(source);
    copyFileSync(statePath, join(source, 'state_4.sqlite'));
    copyFileSync(goalPath, join(source, 'goals_0.sqlite'));
    assert.equal(codexStateRevision(source), selectedRevision, 'older versions do not affect the selected state');

    copyFileSync(statePath, join(source, 'state_6.sqlite'));
    const stateMetadata = statSync(statePath);
    utimesSync(join(source, 'state_6.sqlite'), stateMetadata.atime, stateMetadata.mtime);
    const upgradedStateRevision = codexStateRevision(source);
    assert.notEqual(upgradedStateRevision, selectedRevision, 'a new filename is a revision even for identical bytes');

    copyFileSync(goalPath, join(source, 'goals_2.sqlite'));
    const goalMetadata = statSync(goalPath);
    utimesSync(join(source, 'goals_2.sqlite'), goalMetadata.atime, goalMetadata.mtime);
    assert.notEqual(codexStateRevision(source), upgradedStateRevision, 'the selected goal version is part of the revision');
  } finally {
    goalWriter?.close();
    rmSync(source, { recursive: true, force: true });
  }
});

test('Codex revisions ignore SQLite shared-memory read side effects and unrelated home files', () => {
  const source = fixture('revision-read-');
  const statePath = join(source, 'state_5.sqlite');
  const writer = createThreads(statePath);
  try {
    const initialRevision = codexStateRevision(source);
    const mainBytes = readFileSync(statePath);
    const walBytes = readFileSync(`${statePath}-wal`);
    const mainMetadata = fileMetadata(statePath);
    const walMetadata = fileMetadata(`${statePath}-wal`);
    const reader = new DatabaseSync(statePath, { readOnly: true });
    try {
      assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM threads').get()?.count, 1);
    } finally {
      reader.close();
    }
    assert.equal(codexStateRevision(source), initialRevision);
    assert.deepEqual(readFileSync(statePath), mainBytes);
    assert.deepEqual(readFileSync(`${statePath}-wal`), walBytes);
    assert.deepEqual(fileMetadata(statePath), mainMetadata);
    assert.deepEqual(fileMetadata(`${statePath}-wal`), walMetadata);

    assert.ok(existsSync(`${statePath}-shm`));
    const future = new Date(Date.now() + 60_000);
    utimesSync(`${statePath}-shm`, future, future);
    writeFileSync(join(source, 'config.toml'), 'updated = true');
    writeFileSync(join(source, 'history.jsonl'), 'unrelated');
    assert.equal(codexStateRevision(source), initialRevision);
  } finally {
    writer.close();
    rmSync(source, { recursive: true, force: true });
  }
});

test('fresh WSL snapshots expose new SQLite records while preserving old copies and source files', () => {
  const root = fixture('snapshot-refresh-');
  const source = join(root, 'source');
  mkdirSync(source);
  const statePath = join(source, 'state_5.sqlite');
  const goalPath = join(source, 'goals_1.sqlite');
  const stateWriter = createThreads(statePath);
  const goalWriter = createGoals(goalPath);
  const readers: ReturnType<typeof openCodexState>[] = [];
  try {
    const originalSource = sourceManifest(source);
    const first = snapshotWslCodexState({ uncCodexHome: source, targetDirectory: join(root, 'snapshot-1') });
    assert.ok(first);
    assert.deepEqual(sourceManifest(source), originalSource, 'snapshot copying preserves source bytes and write metadata');
    const firstReader = openCodexState(first.statePath, { goalPath: first.goalPath });
    readers.push(firstReader);
    assert.equal(firstReader.listThreads()[0]?.cwd, '/project/old');
    assert.deepEqual(firstReader.getGoal('thread-old'), { status: 'active', updatedAtMs: 2000 });

    stateWriter.exec(`
      UPDATE threads SET cwd = '/project/moved', updated_at_ms = 4000 WHERE id = 'thread-old';
      INSERT INTO threads VALUES ('thread-new', '/project/new', NULL, 3000, 5000);
    `);
    goalWriter.exec("UPDATE thread_goals SET status = 'paused', updated_at_ms = 6000 WHERE thread_id = 'thread-old'");
    const updatedSource = sourceManifest(source);
    const second = snapshotWslCodexState({ uncCodexHome: source, targetDirectory: join(root, 'snapshot-2') });
    assert.ok(second);
    assert.notEqual(second.directory, first.directory);
    const secondReader = openCodexState(second.statePath, { goalPath: second.goalPath });
    readers.push(secondReader);
    assert.deepEqual(secondReader.listThreads().map(({ id, cwd }) => ({ id, cwd })), [
      { id: 'thread-new', cwd: '/project/new' },
      { id: 'thread-old', cwd: '/project/moved' },
    ]);
    assert.deepEqual(secondReader.getGoal('thread-old'), { status: 'paused', updatedAtMs: 6000 });
    assert.deepEqual(firstReader.listThreads().map(({ id, cwd }) => ({ id, cwd })), [
      { id: 'thread-old', cwd: '/project/old' },
    ]);
    assert.deepEqual(firstReader.getGoal('thread-old'), { status: 'active', updatedAtMs: 2000 });
    assert.deepEqual(sourceManifest(source), updatedSource, 'opening local snapshots preserves every source file');
  } finally {
    for (const reader of readers) reader.close();
    stateWriter.close();
    goalWriter.close();
    rmSync(root, { recursive: true, force: true });
  }
});
