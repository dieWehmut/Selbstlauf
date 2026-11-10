import { copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { SqliteDatabase, SqliteRuntimeModule } from '../codex/sqlite-state.js';

const require = createRequire(import.meta.url);
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const SIDECARS = ['', '-wal', '-shm'] as const;

export interface ObservedSqliteOptions {
  readonly sqliteModule?: SqliteRuntimeModule;
  /** Exercises the same snapshot path on filesystems that support SQLite locking. */
  readonly forceSnapshot?: boolean;
}

/** Windows reaches WSL through 9P, whose file locks cannot support SQLite. */
export function isWslUncPath(path: string): boolean {
  return /^[\\/]{2}(?:\?[\\/]UNC[\\/])?(?:wsl\.localhost|wsl\$)[\\/]/iu.test(path);
}

/** Native paths avoid SQLite URI authority errors and preserve literal ?, #, and % characters. */
export function openObservedSqlite(path: string, options: ObservedSqliteOptions = {}): SqliteDatabase {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('transcript-unreadable');
  const sqlite = options.sqliteModule ?? require('node:sqlite') as SqliteRuntimeModule;
  if (!isWslUncPath(path) && !options.forceSnapshot) return new sqlite.DatabaseSync(path, { readOnly: true });

  const directory = snapshotDatabaseSet(path);
  try {
    const database = new sqlite.DatabaseSync(join(directory, basename(path)), { readOnly: true });
    let closed = false;
    return {
      prepare: sql => database.prepare(sql),
      close(): void {
        if (closed) return;
        closed = true;
        try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function snapshotDatabaseSet(path: string): string {
  // A live checkpoint may change the set while copying. Only use a stable main/WAL/SHM set.
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = fingerprints(path);
    const bytes = [...before.values()].reduce((sum, item) => sum + item.size, 0);
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('transcript-too-large');
    const directory = mkdtempSync(join(tmpdir(), 'selbstlauf-observed-sqlite-'));
    try {
      for (const suffix of before.keys()) copyFileSync(`${path}${suffix}`, join(directory, `${basename(path)}${suffix}`));
      const after = fingerprints(path);
      if (sameFingerprints(before, after)) return directory;
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      if (attempt === 1) throw error;
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
  }
  throw new Error('transcript-unreadable');
}

interface Fingerprint { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number; readonly ino: number }
function fingerprints(path: string): Map<string, Fingerprint> {
  const result = new Map<string, Fingerprint>();
  for (const suffix of SIDECARS) {
    try {
      const details = lstatSync(`${path}${suffix}`);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error('transcript-unreadable');
      result.set(suffix, { size: details.size, mtimeMs: details.mtimeMs, ctimeMs: details.ctimeMs, ino: details.ino });
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return result;
}
function sameFingerprints(left: ReadonlyMap<string, Fingerprint>, right: ReadonlyMap<string, Fingerprint>): boolean {
  if (left.size !== right.size) return false;
  for (const [suffix, before] of left) {
    const after = right.get(suffix);
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) return false;
  }
  return true;
}
