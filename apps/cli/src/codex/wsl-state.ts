import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Reading a WSL distribution's Codex state, which has to be copied to local disk first.
 *
 * Measured, and the reason this module exists: SQLite cannot open *any* database on `\\wsl.localhost`. A copy
 * of the state database placed back inside the distribution fails with `database is locked` exactly as the live
 * one does, while the same bytes copied to local NTFS open and return all three threads. The distribution's
 * root is ext4, but Windows reaches it over 9P, which does not provide the file locking SQLite requires — so
 * this is a filesystem limit, not a URI problem, and no connection string avoids it.
 *
 * The copy is therefore the supported route. The set copied includes the `-wal` and `-shm` sidecars, because a
 * database in WAL mode is not consistent without them: the threads table lives in the main file but recent
 * writes may sit in the log, and copying only the main file would silently read a stale view.
 */

export interface WslStateSnapshotOptions {
  /** The distribution's Codex home over UNC, e.g. `\\wsl.localhost\Ubuntu-22.04\home\han\.codex`. */
  readonly uncCodexHome: string;
  /** Where to put the copy. A fresh temporary directory is used when absent. */
  readonly targetDirectory?: string;
}

export interface WslStateSnapshot {
  readonly statePath: string;
  readonly goalPath: string;
  /** The directory holding the copies, for the caller to remove when done. */
  readonly directory: string;
  readonly files: readonly string[];
}

const SIDECARS = ['', '-wal', '-shm'] as const;

/**
 * Copy a database and its sidecars.
 *
 * Each sidecar is copied only if it exists, because a database that has been checkpointed has none.
 */
function copyDatabaseSet(sourceHome: string, targetDirectory: string, name: string): string[] {
  const copied: string[] = [];
  for (const suffix of SIDECARS) {
    const source = join(sourceHome, `${name}${suffix}`);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(targetDirectory, `${name}${suffix}`));
    copied.push(`${name}${suffix}`);
  }
  return copied;
}

function newest(names: readonly string[], pattern: RegExp): string | null {
  return names.filter((name) => pattern.test(name)).sort().reverse()[0] ?? null;
}

/**
 * Copy the Codex state databases out of a distribution and return the local paths.
 *
 * Returns null when the home cannot be listed or holds no state database, which is an ordinary state: a
 * distribution may have Codex installed without ever having run it.
 */
export function snapshotWslCodexState(options: WslStateSnapshotOptions): WslStateSnapshot | null {
  let entries: string[];
  try {
    entries = readdirSync(options.uncCodexHome);
  } catch {
    return null;
  }

  const state = newest(entries, /^state(?:_\d+)?\.sqlite$/iu);
  if (state === null) return null;
  const goal = newest(entries, /^goals?(?:_\d+)?\.sqlite$/iu);

  const directory = options.targetDirectory ?? mkdtempSync(join(tmpdir(), 'selbstlauf-wsl-codex-'));
  mkdirSync(directory, { recursive: true });

  const files: string[] = [];
  try {
    files.push(...copyDatabaseSet(options.uncCodexHome, directory, state));
    if (goal !== null && goal !== state) {
      files.push(...copyDatabaseSet(options.uncCodexHome, directory, goal));
    }
  } catch (error) {
    // A partially copied set is worse than none: the caller would read a database without its log.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Nothing further to do; the caller gets null either way.
    }
    throw error;
  }

  return {
    // `goalPath` defaults to the state database, which is what the reader does when a goal database is absent.
    statePath: join(directory, state),
    goalPath: join(directory, goal ?? state),
    directory,
    files,
  };
}

/** A path a `threads`-bearing database can be read from, for callers that need the state file alone. */
export function stateDatabaseName(entries: readonly string[]): string | null {
  return newest(entries, /^state(?:_\d+)?\.sqlite$/iu);
}