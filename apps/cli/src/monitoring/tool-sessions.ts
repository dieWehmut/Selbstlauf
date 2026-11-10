import { createHash } from 'node:crypto';
import { opendir, open } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteDatabase } from '../codex/sqlite-state.js';
import { unavailableSessionOutput, type SessionOutput, type SessionOutputEntry, type SessionOutputSource } from '../runtime/session-output.js';
import { openObservedSqlite } from './read-only-sqlite.js';

export type ObservedTool = 'gemini' | 'cursor' | 'antigravity';
export type CursorProjectSlugKind = 'cursor-workspace' | 'cursor-daemon';

/** Matches Cursor's bundled TLn and native daemon projectDirSlugForResolvedPath implementations. */
export function cursorProjectDirectoryName(cwd: string, kind: CursorProjectSlugKind = 'cursor-workspace'): string {
  if (kind === 'cursor-workspace') return slugifyCursorPath(cwd);
  const windowsPath = /^[a-z]:[\\/]/iu.test(cwd) || /^[\\/]{2}/u.test(cwd);
  if (!windowsPath && !posix.isAbsolute(cwd)) throw new TypeError('Cursor daemon cwd must be absolute');
  const resolved = windowsPath ? win32.resolve(cwd) : posix.resolve(cwd);
  const slug = slugifyCursorPath(resolved);
  const hash = (length: number) => createHash('sha256').update(resolved).digest('hex').slice(0, length);
  if (!slug) return hash(7);
  if (slug.length <= 255) return slug;
  return `${slug.slice(-(255 - 16 - 1)).replace(/^-+/u, '')}-${hash(16)}`;
}
function slugifyCursorPath(cwd: string): string { return cwd.replace(/[^a-zA-Z0-9]/gu, '-').replace(/-+/gu, '-').replace(/^-+|-+$/gu, ''); }
export interface ToolSessionLocations {
  readonly homeDirectory: string;
  /** Roaming/AppData or the platform's configuration root, not the product subdirectory. */
  readonly appDataDirectory?: string;
  /** Explicit Cursor --user-data-dir profile root, containing User/globalStorage. */
  readonly cursorUserDataDirectory?: string;
}
export interface ObservedToolSession {
  readonly tool: ObservedTool;
  readonly id: string;
  readonly cwds: readonly string[];
  readonly title?: string;
  readonly lastActivityAtMs: number | null;
  readonly startedAtMs?: number | null;
  readonly runningTurn?: boolean;
  readonly source: SessionOutputSource;
  readonly path: string;
  readonly storageKey?: string;
  /** Gemini's SHA-256 project root key, useful when old files have no root directory. */
  readonly projectHash?: string;
  /** Cursor's project directory key; it is lossy and must only be matched to a known cwd. */
  readonly projectSlug?: string;
  readonly projectSlugKind?: CursorProjectSlugKind;
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_FILES = 1000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 120;
const MAX_TEXT = 128 * 1024;
type Row = Record<string, unknown>;

/** Reads only product-owned metadata. Process/session association remains the controller's responsibility. */
export async function scanToolSessions(tool: ObservedTool, locations: ToolSessionLocations): Promise<ObservedToolSession[]> {
  if (tool === 'gemini') return scanGemini(locations);
  if (tool === 'cursor') return scanCursor(locations);
  return scanAntigravity(locations);
}

/** Paths and storage keys originate in scanToolSessions, never in an HTTP request. */
export async function readObservedSessionOutput(sessionId: string, session: ObservedToolSession): Promise<SessionOutput> {
  try {
    if (session.source === 'gemini-json' || session.source === 'gemini-jsonl') {
      const conversation = await loadGemini(session.path);
      if (!conversation || conversation.id !== session.id) return unavailableSessionOutput(sessionId, 'transcript-format-unsupported', session.source);
      return output(sessionId, session.source, geminiEntries(conversation.messages));
    }
    if (session.source === 'cursor-jsonl') {
      const entries: SessionOutputEntry[] = [];
      for (const [index, item] of (await jsonLines(session.path)).entries()) addMessage(entries, item, String(index));
      return output(sessionId, session.source, entries);
    }
    if (session.source === 'cursor-composer') return readCursorOutput(sessionId, session);
    if (session.source === 'cursor-agent-host') return unavailableSessionOutput(sessionId, 'host-transcript-unavailable', session.source);
    if (session.source === 'antigravity-projection') return readAntigravityOutput(sessionId, session);
    return unavailableSessionOutput(sessionId, 'transcript-format-unsupported', session.source);
  } catch (error) {
    return unavailableSessionOutput(sessionId, unavailableReason(error), session.source);
  }
}

interface GeminiConversation { id: string; metadata: Row; messages: Row[] }
async function loadGemini(path: string): Promise<GeminiConversation | null> {
  const text = await boundedText(path);
  let metadata: Row = {};
  const messages = new Map<string, Row>();
  if (path.endsWith('.json')) {
    metadata = object(JSON.parse(text)) ?? {};
    for (const message of array(metadata?.messages)) {
      const row = object(message); if (row && typeof row.id === 'string') messages.set(row.id, row);
    }
  } else {
    // Current Gemini CLI writes metadata and message records plus incremental patches/rewinds.
    for (const row of parseLines(text)) {
      if (typeof row.sessionId === 'string' && typeof row.projectHash === 'string') metadata = { ...metadata, ...row };
      if (typeof row.$rewindTo === 'string') {
        const target = row.$rewindTo;
        if (messages.has(target)) {
          let remove = false;
          for (const id of messages.keys()) { if (id === target) remove = true; if (remove) messages.delete(id); }
        } else messages.clear();
      } else if (typeof row.id === 'string' && ['user', 'gemini', 'info', 'warning', 'error'].includes(String(row.type))) {
        messages.set(row.id, row);
      } else if (object(row.$patch)) {
        const patch = object(row.$patch)!;
        applyGeminiPatch(messages, patch);
        for (const update of array(patch.updates)) applyGeminiPatch(messages, update);
        for (const id of array(patch.removeIds)) if (typeof id === 'string') messages.delete(id);
        const order = array(patch.orderIds).filter((id): id is string => typeof id === 'string' && messages.has(id));
        if (order.length) {
          const tail = order.map(id => [id, messages.get(id)!] as const);
          for (const id of order) messages.delete(id);
          for (const [id, message] of tail) messages.set(id, message);
        }
      } else if (object(row.$set)) {
        const update = object(row.$set)!;
        metadata = { ...metadata, ...update };
        if (Array.isArray(update.messages)) {
          messages.clear();
          for (const value of update.messages) { const item = object(value); if (item && typeof item.id === 'string') messages.set(item.id, item); }
        }
      }
    }
  }
  return metadata && typeof metadata.sessionId === 'string' && typeof metadata.projectHash === 'string'
    ? { id: metadata.sessionId, metadata, messages: [...messages.values()] } : null;
}
function applyGeminiPatch(messages: Map<string, Row>, value: unknown): void {
  const patch = object(value); if (!patch || typeof patch.id !== 'string') return;
  const existing = messages.get(patch.id); if (!existing) return;
  const next = { ...existing };
  if ('content' in patch) next.content = patch.content;
  if (Array.isArray(patch.toolCalls) && Array.isArray(existing.toolCalls)) {
    next.toolCalls = existing.toolCalls.map(value => {
      const call = object(value); const update = array(patch.toolCalls).map(object).find(item => item && item.id === call?.id);
      return call && update && 'result' in update ? { ...call, result: update.result } : value;
    });
  }
  messages.set(patch.id, next);
}
async function scanGemini(locations: ToolSessionLocations): Promise<ObservedToolSession[]> {
  const root = join(locations.homeDirectory, '.gemini');
  const registry = new Map<string, string>();
  for (const path of [join(root, 'projects.json'), join(root, 'config', 'projects.json')]) {
    try {
      const projects = object(object(JSON.parse(await boundedText(path, 1024 * 1024)))?.projects);
      for (const [cwd, slug] of Object.entries(projects ?? {})) if (typeof slug === 'string') registry.set(slug, cwd);
    } catch { /* Older versions need no registry. */ }
  }
  const sessions: ObservedToolSession[] = [];
  let scanned = 0; let bytes = 0;
  for (const project of await directories(join(root, 'tmp'))) {
    const chats = join(root, 'tmp', project, 'chats');
    for (const file of (await files(chats)).filter(name => /^session-.*\.jsonl?$/u.test(name)).sort().reverse()) {
      if (++scanned > MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) return deduplicate(sessions);
      const path = join(chats, file);
      try {
        const details = lstatSync(path);
        bytes += details.size;
        if (bytes > MAX_SCAN_BYTES) return deduplicate(sessions);
        const conversation = await loadGemini(path); if (!conversation) continue;
        const data = conversation.metadata;
        if (data.kind === 'subagent') continue;
        const last = conversation.messages.at(-1);
        const busy = geminiBusy(data, last);
        const cwds = uniquePaths([data.cwd, data.projectRoot, registry.get(project), ...array(data.directories)]);
        const lastActivityAtMs = time(data.lastUpdated) ?? maxTime(conversation.messages.map(item => time(item.timestamp)));
        sessions.push({ tool: 'gemini', id: conversation.id, cwds, title: string(data.summary), path,
          source: path.endsWith('.jsonl') ? 'gemini-jsonl' : 'gemini-json', projectHash: string(data.projectHash), startedAtMs: time(data.startTime), lastActivityAtMs,
          ...(busy === undefined ? {} : { runningTurn: busy }) });
      } catch { /* Missing, incomplete, or unsupported session files do not poison discovery. */ }
    }
  }
  return deduplicate(sessions);
}
function geminiBusy(metadata: Row, last?: Row): boolean | undefined {
  const status = string(metadata.status);
  if (status && ['running', 'generating', 'in_progress'].includes(status)) return true;
  if (status && ['idle', 'completed', 'cancelled', 'error'].includes(status)) return false;
  if (array(last?.toolCalls).some(value => ['executing', 'scheduled', 'awaiting_approval'].includes(String(object(value)?.status)))) return true;
  // A last user message alone may be a slash command; file mtime alone is never busy/idle evidence.
  return undefined;
}
function geminiEntries(messages: readonly Row[]): SessionOutputEntry[] {
  const entries: SessionOutputEntry[] = [];
  for (const row of messages) {
    if (row.type === 'user' || row.type === 'gemini') add(entries, String(row.id), row.type === 'user' ? 'user' : 'assistant', content(row.content), time(row.timestamp));
    for (const [index, value] of array(row.toolCalls).entries()) {
      const call = object(value); if (call) add(entries, `${String(row.id)}:tool:${String(call.id ?? index)}`, 'tool', content(call.result), time(call.timestamp));
    }
  }
  return entries;
}

async function scanCursor(locations: ToolSessionLocations): Promise<ObservedToolSession[]> {
  const result: ObservedToolSession[] = [];
  let scanned = 0; let bytes = 0;
  for (const dataDirectory of ['.cursor', '.cursor-agents', '.cursor-agents-dev']) {
    const root = join(locations.homeDirectory, dataDirectory, 'projects');
  for (const project of await directories(root)) {
    if (scanned >= MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) break;
    const folder = join(root, project, 'agent-transcripts');
    for (const path of await transcriptFiles(folder)) {
      if (++scanned > MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) break;
      try {
        const details = lstatSync(path);
        bytes += details.size;
        if (bytes > MAX_SCAN_BYTES) break;
        const rows = await jsonLines(path);
        const first = rows[0]; if (!first) continue;
        const explicit = rows.find(row => typeof row.session_id === 'string' || typeof row.sessionId === 'string');
        const id = string(explicit?.session_id ?? explicit?.sessionId) ?? path.replace(/^.*[\\/]/u, '').replace(/\.jsonl$/u, '');
        const messages = rows.filter(row => cursorRole(row) !== null);
        if (!messages.length) continue;
        const cwd = rows.find(row => typeof row.cwd === 'string' || typeof row.workspace === 'string');
        const overview = rows.find(row => row.type === 'metadata' && typeof object(row.metadata)?.overview === 'string');
        const last = [...rows].reverse().find(row => row.type === 'turn_ended' || cursorRole(row) !== null);
        const idle = last?.type === 'turn_ended' && ['success', 'error', 'aborted'].includes(String(last.status));
        result.push({ tool: 'cursor', id, cwds: uniquePaths([cwd?.cwd, cwd?.workspace]), source: 'cursor-jsonl', path, projectSlug: project,
          projectSlugKind: dataDirectory === '.cursor' ? 'cursor-workspace' : 'cursor-daemon',
          title: string(object(overview?.metadata)?.overview)?.slice(0, 4096), startedAtMs: time(first.timestamp),
          lastActivityAtMs: maxTime(rows.map(row => time(row.timestamp))) ?? details.mtimeMs, ...(idle ? { runningTurn: false } : {}) });
      } catch { /* A live transcript may be incomplete. */ }
    }
  }
  }
  result.push(...await scanCursorNative(locations));
  const config = locations.appDataDirectory ?? join(locations.homeDirectory, '.config');
  const profile = locations.cursorUserDataDirectory ?? join(config, 'Cursor');
  const database = join(profile, 'User', 'globalStorage', 'state.vscdb');
  let db: SqliteDatabase | undefined;
  try {
    db = openDatabase(database);
    const workspaceRoots = await cursorWorkspaceRoots(join(profile, 'User', 'workspaceStorage'));
    // Prefix range uses the key's index; LIKE may walk every stored bubble in a large database.
    const rows = hasTable(db, 'cursorDiskKV') ? db.prepare(`SELECT key, length(CAST(value AS BLOB)) AS valueBytes FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND length(CAST(value AS BLOB)) <= ${MAX_FILE_BYTES} LIMIT 1000`).all() : [];
    const headers = hasTable(db, 'composerHeaders') ? db.prepare('SELECT composerId, workspaceId FROM composerHeaders LIMIT 1000').all() : [];
    const byId = new Map(headers.map(row => [String(row.composerId), row]));
    for (const row of rows) {
      bytes += Number(row.valueBytes);
      if (bytes > MAX_SCAN_BYTES) break;
      const data = jsonObject(db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ? AND length(CAST(value AS BLOB)) <= ${MAX_FILE_BYTES}`).get(row.key)?.value);
      if (!data || typeof data.composerId !== 'string' || data.isDraft === true || data.isArchived === true || data.isEphemeral === true) continue;
      const header = byId.get(data.composerId);
      const details = header ? jsonObject(db.prepare('SELECT value FROM composerHeaders WHERE composerId = ? AND length(CAST(value AS BLOB)) <= 65536').get(data.composerId)?.value) : null;
      const workspace = object(data.workspaceIdentifier) ?? object(details?.workspaceIdentifier);
      const workspaceId = string(workspace?.id ?? header?.workspaceId);
      const cwds = uniquePaths([workspace?.folder, workspace?.configuration, ...(workspaceId ? workspaceRoots.get(workspaceId) ?? [] : []),
        ...array(data.trackedGitRepos).flatMap(value => { const repo = object(value); return [repo?.rootPath, repo?.rootUri, repo?.repoPath]; })]);
      // Empty draft placeholders carry IDs but are not conversations.
      if (!array(data.fullConversationHeadersOnly).length && !Object.keys(object(data.conversationMap) ?? {}).length && !cwds.length) continue;
      const busy = cursorBusy(data);
      result.push({ tool: 'cursor', id: data.composerId, cwds, title: string(data.name ?? data.title ?? details?.name ?? details?.title), source: 'cursor-composer',
        path: database, storageKey: data.composerId, startedAtMs: time(data.createdAt ?? details?.createdAt),
        lastActivityAtMs: time(data.lastUpdatedAt ?? details?.lastUpdatedAt ?? data.createdAt), ...(busy === undefined ? {} : { runningTurn: busy }) });
    }
  } catch { /* Missing/locked/unsupported runtime databases are optional sources. */ } finally { db?.close(); }
  return deduplicate(result);
}

async function scanCursorNative(locations: ToolSessionLocations): Promise<ObservedToolSession[]> {
  const result: ObservedToolSession[] = [];
  let bytes = 0; let scanned = 0;
  for (const folder of ['.cursor-agents', '.cursor-agents-dev']) {
    const root = join(locations.homeDirectory, folder);
    let db: SqliteDatabase | undefined;
    try { db = openDatabase(join(root, 'data.sqlite')); if (!hasTable(db, 'ItemTable')) { db.close(); db = undefined; } } catch { /* Native sidecars are useful without their global index. */ }
    try {
      for (const id of await directories(join(root, 'sessions'))) {
        if (++scanned > MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) return result;
        const path = join(root, 'sessions', id, 'meta.json');
        try {
          bytes += lstatSync(path).size; if (bytes > MAX_SCAN_BYTES) return result;
          const data = object(JSON.parse(await boundedText(path, 256 * 1024)));
          if (data?.schemaVersion !== 1 || data.sessionId !== id || !['host-native', 'migrated-from-renderer-cas'].includes(String(data.origin)) || data.isArchived !== false ||
            typeof data.createdAtMs !== 'number' || !Number.isFinite(data.createdAtMs) || typeof data.latestRootBlobIdHex !== 'string' || !/^[a-f0-9]{64}$/iu.test(data.latestRootBlobIdHex)) continue;
          const record = db?.prepare('SELECT value, length(CAST(value AS BLOB)) AS valueBytes FROM ItemTable WHERE key = ? AND length(CAST(value AS BLOB)) <= 262144').get(`agentHostDaemon:execConfig:${id}`);
          bytes += Number(record?.valueBytes ?? 0); if (bytes > MAX_SCAN_BYTES) return result;
          const config = jsonObject(record?.value);
          const cwds = uniquePaths([...array(config?.workspacePaths), ...array(data.workspacePaths)]);
          result.push({ tool: 'cursor', id, cwds, title: string(data.title)?.slice(0, 4096), path, source: 'cursor-agent-host',
            startedAtMs: data.createdAtMs, lastActivityAtMs: time(data.updatedAtMs) ?? data.createdAtMs });
        } catch { /* Unknown, partial, retired or deleted session sidecars are not valid observations. */ }
      }
    } finally { db?.close(); }
  }
  return result;
}
function cursorBusy(data: Row): boolean | undefined {
  if (data.status === 'generating' || data.isContinuationInProgress === true || array(data.generatingBubbleIds).length > 0) return true;
  if (['none', 'completed', 'cancelled', 'aborted', 'error'].includes(String(data.status))) return false;
  return undefined;
}
async function cursorWorkspaceRoots(root: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const id of await directories(root)) {
    try { const data = object(JSON.parse(await boundedText(join(root, id, 'workspace.json'), 64 * 1024))); result.set(id, uniquePaths([data?.folder, data?.workspace])); } catch { /* Empty windows have no root. */ }
  }
  return result;
}
function readCursorOutput(sessionId: string, session: ObservedToolSession): SessionOutput {
  let db: SqliteDatabase | undefined;
  try {
    db = openDatabase(session.path);
    const composerKey = `composerData:${session.storageKey ?? session.id}`;
    const composerBytes = Number(db.prepare('SELECT length(CAST(value AS BLOB)) AS valueBytes FROM cursorDiskKV WHERE key = ?').get(composerKey)?.valueBytes ?? 0);
    if (composerBytes > MAX_FILE_BYTES) return unavailableSessionOutput(sessionId, 'transcript-too-large', session.source);
    const composer = db.prepare(`SELECT value, length(CAST(value AS BLOB)) AS valueBytes FROM cursorDiskKV WHERE key = ? AND length(CAST(value AS BLOB)) <= ${MAX_FILE_BYTES}`).get(composerKey);
    const data = jsonObject(composer?.value);
    if (!data) return unavailableSessionOutput(sessionId, 'transcript-missing', session.source);
    let bytes = Number(composer?.valueBytes ?? 0); let budgetExceeded = false;
    const entries: SessionOutputEntry[] = [];
    const map = object(data.conversationMap) ?? {};
    const headers = array(data.fullConversationHeadersOnly).slice(-MAX_ENTRIES);
    for (const [index, value] of [...headers].reverse().entries()) {
      const header = object(value); if (!header) continue;
      const id = string(header.bubbleId ?? header.id); if (!id) continue;
      const inline = object(map[id]);
      const key = `bubbleId:${session.storageKey ?? session.id}:${id}`;
      const valueBytes = Number(db.prepare('SELECT length(CAST(value AS BLOB)) AS valueBytes FROM cursorDiskKV WHERE key = ?').get(key)?.valueBytes ?? 0);
      const allowed = valueBytes <= MAX_FILE_BYTES && bytes + valueBytes <= MAX_SCAN_BYTES;
      if (!allowed) budgetExceeded = true;
      let stored: Row | null = null;
      if (allowed) {
        const record = db.prepare('SELECT value, length(CAST(value AS BLOB)) AS valueBytes FROM cursorDiskKV WHERE key = ? AND length(CAST(value AS BLOB)) <= ?').get(key, Math.min(MAX_FILE_BYTES, MAX_SCAN_BYTES - bytes));
        bytes += Number(record?.valueBytes ?? 0);
        stored = jsonObject(record?.value);
        if (valueBytes && !record) budgetExceeded = true;
      }
      const bubble = stored ?? inline ?? header;
      const role = bubble.type === 1 || bubble.role === 'user' || bubble.type === 'user' ? 'user' : bubble.type === 2 || bubble.role === 'assistant' || bubble.type === 'assistant' ? 'assistant' : null;
      if (role) add(entries, id || String(index), role, content(bubble.text ?? bubble.content), time(bubble.createdAt ?? bubble.timestamp));
    }
    if (!entries.length) return unavailableSessionOutput(sessionId, budgetExceeded ? 'transcript-too-large' : 'composer-transcript-unavailable', session.source);
    return output(sessionId, session.source, entries.reverse(), budgetExceeded || array(data.fullConversationHeadersOnly).length > MAX_ENTRIES);
  } catch (error) { return unavailableSessionOutput(sessionId, unavailableReason(error), session.source); } finally { db?.close(); }
}

async function scanAntigravity(locations: ToolSessionLocations): Promise<ObservedToolSession[]> {
  const sessions: ObservedToolSession[] = [];
  for (const product of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
    sessions.push(...scanAntigravityDatabase(join(locations.homeDirectory, '.gemini', product, 'conversation_summaries.db')));
  }
  return deduplicate(sessions);
}
function scanAntigravityDatabase(path: string): ObservedToolSession[] {
  let db: SqliteDatabase | undefined;
  try {
    db = openDatabase(path);
    if (!hasTable(db, 'conversation_summaries')) return [];
    const columns = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map(row => String(row.name)));
    if (!['conversation_id', 'workspace_uris', 'last_modified_time'].every(name => columns.has(name))) return [];
    const field = (name: string) => columns.has(name) ? name : 'NULL';
    return db.prepare(`SELECT conversation_id, substr(${field('title')}, 1, 4096) AS title, substr(workspace_uris, 1, 65536) AS workspace_uris, last_modified_time, ${field('last_user_input_time')} AS last_user_input_time, ${field('not_fully_idle')} AS not_fully_idle, ${field('killed')} AS killed FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1000`).all().flatMap(row => {
      if (typeof row.conversation_id !== 'string' || row.killed === 1 || row.killed === true) return [];
      const roots = parseArray(row.workspace_uris);
      const busy = row.not_fully_idle === 1 || row.not_fully_idle === true ? true : row.not_fully_idle === 0 || row.not_fully_idle === false ? false : undefined;
      return [{ tool: 'antigravity' as const, id: row.conversation_id, title: string(row.title), cwds: uniquePaths(roots), source: 'antigravity-projection' as const,
        path, storageKey: row.conversation_id, lastActivityAtMs: time(row.last_modified_time) ?? time(row.last_user_input_time), ...(busy === undefined ? {} : { runningTurn: busy }) }];
    });
  } catch { return []; } finally { db?.close(); }
}
function readAntigravityOutput(sessionId: string, session: ObservedToolSession): SessionOutput {
  let db: SqliteDatabase | undefined;
  try {
    db = openDatabase(session.path);
    if (!hasTable(db, 'conversations_fts')) return unavailableSessionOutput(sessionId, 'conversation-summary-only', session.source);
    const id = session.storageKey ?? session.id;
    // The real FTS5 schema makes conversation_id UNINDEXED. Scan a bounded recent rowid
    // window first, then fetch bodies only for the selected conversation's rows.
    const recent = db.prepare('SELECT rowid AS outputRowId, conversation_id, chunk_index FROM conversations_fts ORDER BY rowid DESC LIMIT 1000').all();
    const matching = recent.filter(row => row.conversation_id === id).sort((left, right) => Number(right.chunk_index) - Number(left.chunk_index));
    const selected = matching.slice(0, 60).reverse();
    const statement = db.prepare(`SELECT chunk_index, substr(user_body, -${MAX_TEXT}) AS user_body, substr(agent_body, -${MAX_TEXT}) AS agent_body, length(user_body) AS user_length, length(agent_body) AS agent_length, last_step_created_at FROM conversations_fts WHERE rowid = ? AND conversation_id = ?`);
    const rows = selected.flatMap(row => { const body = statement.get(row.outputRowId, id); return body ? [body] : []; });
    const entries: SessionOutputEntry[] = [];
    for (const row of rows) {
      add(entries, `${String(row.chunk_index)}:user`, 'user', row.user_body, time(row.last_step_created_at));
      add(entries, `${String(row.chunk_index)}:assistant`, 'assistant', row.agent_body, time(row.last_step_created_at));
    }
    if (!entries.length) return unavailableSessionOutput(sessionId, recent.length >= MAX_SCAN_FILES ? 'transcript-too-large' : 'conversation-summary-only', session.source);
    return output(sessionId, session.source, entries, matching.length > 60 || recent.length >= MAX_SCAN_FILES || rows.some(row => Number(row.user_length) > MAX_TEXT || Number(row.agent_length) > MAX_TEXT));
  } catch (error) { return unavailableSessionOutput(sessionId, unavailableReason(error), session.source); } finally { db?.close(); }
}

function openDatabase(path: string): SqliteDatabase {
  return openObservedSqlite(path);
}
function hasTable(db: SqliteDatabase, name: string): boolean { return !!db.prepare("SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(name); }
async function boundedText(path: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
  if (lstatSync(path).isSymbolicLink()) throw new Error('transcript-symlink');
  const handle = await open(path, 'r');
  try {
    const details = await handle.stat(); if (!details.isFile() || details.size > maxBytes) throw new Error('transcript-too-large');
    const buffer = Buffer.alloc(details.size); let read = 0;
    while (read < buffer.length) { const result = await handle.read(buffer, read, buffer.length - read, read); if (!result.bytesRead) break; read += result.bytesRead; }
    return buffer.subarray(0, read).toString('utf8');
  } finally { await handle.close(); }
}
async function directoryEntries(path: string, kind: 'file' | 'directory'): Promise<string[]> {
  try {
    const details = lstatSync(path); if (!details.isDirectory() || details.isSymbolicLink()) return [];
    const entries: string[] = []; let inspected = 0;
    for await (const item of await opendir(path)) {
      if (++inspected > MAX_SCAN_FILES) break;
      if (kind === 'file' ? item.isFile() : item.isDirectory()) entries.push(item.name);
    }
    return entries;
  } catch { return []; }
}
async function directories(path: string): Promise<string[]> { return directoryEntries(path, 'directory'); }
async function files(path: string): Promise<string[]> { return directoryEntries(path, 'file'); }
async function transcriptFiles(root: string): Promise<string[]> {
  const result = (await files(root)).filter(name => name.endsWith('.jsonl')).map(name => join(root, name));
  for (const folder of await directories(root)) {
    if (result.length >= MAX_SCAN_FILES) break;
    result.push(...(await files(join(root, folder))).filter(name => name.endsWith('.jsonl')).slice(0, MAX_SCAN_FILES - result.length).map(name => join(root, folder, name)));
  }
  return result.slice(0, MAX_SCAN_FILES);
}
async function jsonLines(path: string): Promise<Row[]> { return parseLines(await boundedText(path)); }
function parseLines(text: string): Row[] { return text.split('\n').flatMap(line => { try { const row = object(JSON.parse(line)); return row ? [row] : []; } catch { return []; } }); }
function object(value: unknown): Row | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function parseArray(value: unknown): unknown[] { if (Array.isArray(value)) return value; try { return array(JSON.parse(String(value))); } catch { return []; } }
function jsonObject(value: unknown): Row | null { try { return object(typeof value === 'string' ? JSON.parse(value) : value instanceof Uint8Array ? JSON.parse(Buffer.from(value).toString('utf8')) : value); } catch { return null; } }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function time(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}
function maxTime(values: readonly (number | null)[]): number | null { const times = values.filter((value): value is number => value !== null); return times.length ? Math.max(...times) : null; }
function uniquePaths(values: readonly unknown[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    let path = typeof value === 'string' ? value : string(object(value)?.fsPath ?? object(value)?.path ?? object(value)?.uri);
    if (!path) continue;
    if (path.startsWith('file:')) { try { path = fileURLToPath(path); } catch { continue; } }
    if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1);
    if (path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path) || path.startsWith('\\\\')) result.add(path);
  }
  return [...result];
}
function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    const row = object(part);
    const response = object(object(row?.functionResponse)?.response);
    return string(row?.text) ?? (row?.type === 'tool_result' ? content(row.content) : response ? content(response.output ?? response.error ?? response.content) : '');
  }).filter(Boolean).join('\n');
}
function add(entries: SessionOutputEntry[], id: string, role: SessionOutputEntry['role'], text: unknown, timestampMs: number | null): void { if (typeof text === 'string' && text.trim()) entries.push({ id, role, text, timestampMs }); }
function addMessage(entries: SessionOutputEntry[], row: Row, fallback: string): void {
  const recordedRole = cursorRole(row); if (!recordedRole) return;
  const message = object(row.message);
  const parts = message?.content ?? row.content ?? row.text;
  const role = recordedRole === 'user' && array(parts).some(value => object(value)?.type === 'tool_result') ? 'tool' : recordedRole;
  add(entries, string(row.uuid ?? row.id) ?? fallback, role, content(parts), time(row.timestamp));
}
function cursorRole(row: Row): SessionOutputEntry['role'] | null {
  const role = row.role ?? row.type ?? object(row.message)?.role;
  return role === 'user' || role === 'assistant' || role === 'tool' ? role : null;
}
function output(sessionId: string, source: SessionOutputSource, entries: readonly SessionOutputEntry[], truncated = false): SessionOutput {
  let remaining = MAX_TEXT; const selected: SessionOutputEntry[] = [];
  for (const entry of entries.slice(-MAX_ENTRIES).reverse()) {
    if (!remaining) { truncated = true; break; }
    let text = entry.text.slice(-remaining); if (/^[\uDC00-\uDFFF]/u.test(text)) text = text.slice(1);
    if (text.length < entry.text.length) truncated = true;
    selected.push({ ...entry, text }); remaining -= text.length;
  }
  return { sessionId, state: 'ready', source, entries: selected.reverse(), truncated: truncated || entries.length > MAX_ENTRIES };
}
function deduplicate(sessions: readonly ObservedToolSession[]): ObservedToolSession[] {
  const result = new Map<string, ObservedToolSession>();
  for (const session of sessions) {
    const key = `${session.tool}:${session.id}`; const previous = result.get(key);
    if (previous?.tool === 'cursor' && (previous.source === 'cursor-jsonl' || session.source === 'cursor-jsonl')) {
      const transcript = previous.source === 'cursor-jsonl' ? previous : session;
      const metadata = previous.source !== 'cursor-jsonl' ? previous : session.source !== 'cursor-jsonl' ? session : transcript;
      result.set(key, { ...metadata, ...transcript, cwds: uniquePaths([...previous.cwds, ...session.cwds]),
        title: metadata.title ?? transcript.title, startedAtMs: metadata.startedAtMs ?? transcript.startedAtMs,
        lastActivityAtMs: maxTime([previous.lastActivityAtMs, session.lastActivityAtMs]),
        ...(metadata.runningTurn === undefined ? {} : { runningTurn: metadata.runningTurn }) });
    } else if (!previous || (session.lastActivityAtMs ?? 0) > (previous.lastActivityAtMs ?? 0)) result.set(key, session);
  }
  return [...result.values()];
}
function unavailableReason(error: unknown): string {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'transcript-missing';
  if (error instanceof Error && error.message === 'transcript-too-large') return 'transcript-too-large';
  if (error instanceof SyntaxError) return 'transcript-invalid';
  return 'transcript-unreadable';
}
