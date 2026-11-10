import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { isWslUncPath, openObservedSqlite } from '../src/monitoring/read-only-sqlite.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'selbstlauf-observed-sqlite-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('WSL UNC detection covers localhost, legacy server and extended UNC without treating regular shares as WSL', () => {
  for (const path of ['\\\\wsl.localhost\\Ubuntu\\home\\user\\state.sqlite', '\\\\wsl$\\Ubuntu\\state.sqlite', '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\state.sqlite', '//wsl.localhost/Ubuntu/state.sqlite']) assert.equal(isWslUncPath(path), true, path);
  for (const path of ['C:\\state.sqlite', '/home/user/state.sqlite', '\\\\fileserver\\share\\state.sqlite', '\\\\wsl.localhost.example\\share\\state.sqlite']) assert.equal(isWslUncPath(path), false, path);
});

test('native read-only SQLite paths preserve URI-sensitive filename characters and cannot write', async t => {
  const root = await fixture(t), path = join(root, process.platform === 'win32' ? 'state # %.sqlite' : 'state # %?.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const writer = new DatabaseSync(path); writer.exec('CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'original\')'); writer.close();
  const before = await readFile(path), names = await readdir(root);
  const reader = openObservedSqlite(path);
  assert.equal(reader.prepare('SELECT value FROM sample').get()?.value, 'original');
  assert.throws(() => reader.prepare('INSERT INTO sample VALUES (\'write must fail\')').get(), /readonly|read.only/iu);
  reader.close();
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(root), names);
});

test('WSL snapshot mode includes committed WAL data, preserves source files and cleans local copies on close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'selbstlauf-observed-sqlite-test-')), path = join(root, 'state.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const writer = new DatabaseSync(path);
  t.after(() => { writer.close(); return rm(root, { recursive: true, force: true }); });
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'committed in WAL\')');
  const names = await readdir(root), before = await Promise.all(names.map(name => readFile(join(root, name))));
  assert(names.includes('state.sqlite-wal'));
  let localPath = '';
  class RuntimeDatabase extends DatabaseSync {
    constructor(location: string, options?: { readOnly?: boolean }) { super(location, options); localPath = location; }
  }
  const reader = openObservedSqlite(path, { forceSnapshot: true, sqliteModule: { DatabaseSync: RuntimeDatabase } });
  assert.notEqual(localPath, path); assert.equal(existsSync(localPath), true);
  assert.equal(reader.prepare('SELECT value FROM sample').get()?.value, 'committed in WAL');
  reader.close(); reader.close(); assert.equal(existsSync(dirname(localPath)), false);
  assert.deepEqual(await readdir(root), names);
  for (const [index, name] of names.entries()) assert.deepEqual(await readFile(join(root, name)), before[index], name);
});

test('snapshot failures and oversized sets do not leave temporary copies or open missing databases', async t => {
  const root = await fixture(t), path = join(root, 'state.sqlite');
  const { DatabaseSync } = await import('node:sqlite'); const writer = new DatabaseSync(path); writer.exec('CREATE TABLE sample(value TEXT)'); writer.close();
  let localPath = '';
  class FailingDatabase {
    constructor(location: string) { localPath = location; throw new Error('fixture open failure'); }
    prepare(): never { throw new Error('unreachable'); }
    close(): void { }
  }
  assert.throws(() => openObservedSqlite(path, { forceSnapshot: true, sqliteModule: { DatabaseSync: FailingDatabase } }), /fixture open failure/u);
  assert.equal(existsSync(dirname(localPath)), false);
  await truncate(path, 256 * 1024 * 1024 + 1);
  assert.throws(() => openObservedSqlite(path, { forceSnapshot: true }), /transcript-too-large/u);
  const missing = join(root, 'missing.sqlite');
  assert.throws(() => openObservedSqlite(missing), /ENOENT/u); assert.equal(existsSync(missing), false);
});
