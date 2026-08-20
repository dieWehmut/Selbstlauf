import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import type { GoalStatus, GoalSnapshot } from '../domain/types.js';

/** A deliberately small subset of DatabaseSync used by the read-only adapter. */
export interface SqliteStatement {
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  all(...parameters: readonly unknown[]): readonly Record<string, unknown>[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteRuntimeModule {
  readonly DatabaseSync: new (
    location: string,
    options?: { readonly readOnly?: boolean },
  ) => SqliteDatabase;
}

export interface CodexThreadState {
  readonly id: string;
  readonly cwd: string | null;
  readonly rolloutPath: string | null;
  readonly createdAtMs: number | null;
  readonly updatedAtMs: number | null;
  readonly status: string | null;
}

export interface CodexStateReader {
  /** Returns only the goal status metadata; objective/token fields are never retained. */
  getGoal(threadId: string): GoalSnapshot | null;
  /** Reads the minimal thread index used for process association. */
  listThreads(): readonly CodexThreadState[];
  close(): void;
}

export interface OpenCodexStateOptions {
  /** Dependency injection makes unsupported-runtime and failure paths testable. */
  readonly sqliteModule?: SqliteRuntimeModule | null;
  /** Optional separate goals database used by current Codex releases. */
  readonly goalPath?: string;
  /** Optional separate thread index; defaults to the positional path. */
  readonly threadPath?: string;
  readonly goalTable?: string;
  readonly threadsTable?: string;
}

export class UnsupportedSqliteRuntimeError extends Error {
  public readonly code = 'unsupported-runtime';

  public constructor(message = 'Codex state access requires the node:sqlite runtime module') {
    super(message);
    this.name = 'UnsupportedSqliteRuntimeError';
  }
}

const require = createRequire(import.meta.url);

/**
 * Open a Codex state database without write access.
 *
 * Codex keeps goals and thread indexes in separate SQLite files in some
 * versions. The reader therefore treats either table as optional and exposes
 * a common, minimal view to the rest of the watchdog.
 */
export function openCodexState(path: string, options: OpenCodexStateOptions = {}): CodexStateReader {
  assertPath(path, 'Codex state path');
  const goalPath = options.goalPath ?? path;
  const threadPath = options.threadPath ?? path;
  assertPath(goalPath, 'Codex goal state path');
  assertPath(threadPath, 'Codex thread state path');

  const sqlite = options.sqliteModule === undefined ? loadSqliteRuntime() : options.sqliteModule;
  if (sqlite === null || typeof sqlite.DatabaseSync !== 'function') {
    throw new UnsupportedSqliteRuntimeError();
  }

  const goalTable = validateIdentifier(options.goalTable ?? 'thread_goals', 'goalTable');
  const threadsTable = validateIdentifier(options.threadsTable ?? 'threads', 'threadsTable');
  let goalDatabase: SqliteDatabase | null = null;
  let threadDatabase: SqliteDatabase | null = null;
  try {
    goalDatabase = openReadOnlyDatabase(sqlite, goalPath);
    threadDatabase = samePath(goalPath, threadPath)
      ? goalDatabase
      : openReadOnlyDatabase(sqlite, threadPath);
  } catch (error) {
    goalDatabase?.close();
    // Keep the runtime distinction useful to callers while preserving the
    // original SQLite error for missing/corrupt databases.
    if (isMissingSqliteRuntime(error)) {
      throw new UnsupportedSqliteRuntimeError(String(error));
    }
    throw error;
  }
  const goals = goalDatabase;
  const threads = threadDatabase;

  let goalStatement: SqliteStatement | null;
  let threadStatement: SqliteStatement | null;
  try {
    const goalTables = discoverTables(goals);
    const threadTables = discoverTables(threads);
    goalStatement = goalTables.has(goalTable)
      ? prepareGoalStatement(goals, goalTable)
      : null;
    threadStatement = threadTables.has(threadsTable)
      ? prepareThreadStatement(threads, threadsTable)
      : null;
  } catch (error) {
    goals.close();
    if (threads !== goals) threads.close();
    throw error;
  }

  let closed = false;
  return {
    getGoal(threadId: string): GoalSnapshot | null {
      assertThreadId(threadId);
      ensureOpen();
      if (goalStatement === null) return null;
      const row = goalStatement.get(threadId);
      if (row === undefined) return null;
      const rawStatus = row.status;
      if (typeof rawStatus !== 'string' || rawStatus.length === 0) return null;
      const updatedAtMs = toNullableNumber(row.updatedAtMs);
      return Object.freeze({
        status: normalizeGoalStatus(rawStatus),
        ...(updatedAtMs === null ? {} : { updatedAtMs }),
      });
    },

    listThreads(): readonly CodexThreadState[] {
      ensureOpen();
      if (threadStatement === null) return Object.freeze([]);
      const rows = threadStatement.all();
      return Object.freeze(
        rows.flatMap((row) => {
          if (typeof row.id !== 'string' || row.id.length === 0) return [];
          return [
            Object.freeze({
              id: row.id,
              cwd: toNullableString(row.cwd),
              rolloutPath: toNullableString(row.rolloutPath),
              createdAtMs: toNullableNumber(row.createdAtMs),
              updatedAtMs: toNullableNumber(row.updatedAtMs),
              status: toNullableString(row.status),
            }),
          ];
        }),
      );
    },

    close(): void {
      if (closed) return;
      closed = true;
      goals.close();
      if (threads !== goals) threads.close();
    },
  };

  function ensureOpen(): void {
    if (closed) throw new Error('Codex state reader is closed');
  }
}

function prepareGoalStatement(database: SqliteDatabase, table: string): SqliteStatement {
  const columns = discoverColumns(database, table);
  requireColumns(columns, table, ['thread_id', 'status']);
  const updatedAt = columns.has('updated_at_ms') ? '"updated_at_ms"' : 'NULL';
  return database.prepare(
    `SELECT "status" AS status, ${updatedAt} AS updatedAtMs
       FROM "${table}"
      WHERE "thread_id" = ?
      LIMIT 1`,
  );
}

function prepareThreadStatement(database: SqliteDatabase, table: string): SqliteStatement {
  const columns = discoverColumns(database, table);
  requireColumns(columns, table, ['id']);
  const cwd = columnOrNull(columns, 'cwd');
  const rolloutPath = columnOrNull(columns, 'rollout_path');
  const status = columnOrNull(columns, 'status');
  const createdAt = timestampExpression(columns, 'created_at_ms', 'created_at');
  const updatedAt = timestampExpression(columns, 'updated_at_ms', 'updated_at');
  return database.prepare(
    `SELECT "id" AS id,
            ${cwd} AS cwd,
            ${rolloutPath} AS rolloutPath,
            ${createdAt} AS createdAtMs,
            ${updatedAt} AS updatedAtMs,
            ${status} AS status
       FROM "${table}"
      ORDER BY COALESCE(${updatedAt}, ${createdAt}, 0) DESC`,
  );
}

function loadSqliteRuntime(): SqliteRuntimeModule {
  try {
    return require('node:sqlite') as SqliteRuntimeModule;
  } catch (error) {
    throw new UnsupportedSqliteRuntimeError(
      `node:sqlite is unavailable in this Node runtime: ${String(error)}`,
    );
  }
}

function toReadOnlySqliteUri(path: string): string {
  const uri = pathToFileURL(path).href;
  return `${uri}${uri.includes('?') ? '&' : '?'}mode=ro`;
}

function openReadOnlyDatabase(sqlite: SqliteRuntimeModule, path: string): SqliteDatabase {
  return new sqlite.DatabaseSync(toReadOnlySqliteUri(path), { readOnly: true });
}

function samePath(left: string, right: string): boolean {
  return pathToFileURL(left).href.toLowerCase() === pathToFileURL(right).href.toLowerCase();
}

function assertPath(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function validateIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(`${name} must be a simple SQLite identifier`);
  }
  return value;
}

function discoverTables(database: SqliteDatabase): ReadonlySet<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  return new Set(
    rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])),
  );
}

function discoverColumns(database: SqliteDatabase, table: string): ReadonlySet<string> {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all();
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])));
}

function requireColumns(columns: ReadonlySet<string>, table: string, required: readonly string[]): void {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`Codex SQLite table ${table} is missing required columns: ${missing.join(', ')}`);
  }
}

function columnOrNull(columns: ReadonlySet<string>, name: string): string {
  return columns.has(name) ? `"${name}"` : 'NULL';
}

function timestampExpression(
  columns: ReadonlySet<string>,
  millisecondsColumn: string,
  secondsColumn: string,
): string {
  const secondsExpression = columns.has(secondsColumn)
    ? `(CASE WHEN ABS("${secondsColumn}") < 100000000000 THEN "${secondsColumn}" * 1000 ELSE "${secondsColumn}" END)`
    : null;
  if (columns.has(millisecondsColumn) && secondsExpression !== null) {
    return `COALESCE("${millisecondsColumn}", ${secondsExpression})`;
  }
  if (columns.has(millisecondsColumn)) return `"${millisecondsColumn}"`;
  if (secondsExpression !== null) return secondsExpression;
  return 'NULL';
}

function assertThreadId(threadId: string): void {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new TypeError('threadId must be a non-empty string');
  }
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeGoalStatus(status: string): GoalStatus {
  switch (status) {
    case 'active':
    case 'paused':
    case 'complete':
    case 'blocked':
    case 'usage_limited':
    case 'budget_limited':
    case 'unknown':
      return status;
    default:
      return 'unknown';
  }
}

function isMissingSqliteRuntime(error: unknown): boolean {
  return error instanceof Error && /node:sqlite|DatabaseSync is not a constructor|Cannot find module/.test(error.message);
}
