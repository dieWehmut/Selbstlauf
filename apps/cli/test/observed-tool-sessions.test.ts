import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, truncate, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { scanToolSessions, readObservedSessionOutput, cursorProjectDirectoryName, type ObservedToolSession } from '../src/monitoring/tool-sessions.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'selbstlauf-observed-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function save(path: string, value: unknown): Promise<void> { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
const timestamp = '2026-11-10T10:00:00.000Z';

test('Cursor project names match fixed bundled slug examples, preserve case and expose known collisions', () => {
  assert.equal(cursorProjectDirectoryName('/workspace/Native_Cursor'), 'workspace-Native-Cursor');
  assert.equal(cursorProjectDirectoryName('C:\\Users\\Han\\Project A'), 'C-Users-Han-Project-A');
  assert.notEqual(cursorProjectDirectoryName('/work/Example'), cursorProjectDirectoryName('/work/example'));
  assert.equal(cursorProjectDirectoryName('/work/a_b'), cursorProjectDirectoryName('/work/a-b'));
  assert.equal(cursorProjectDirectoryName('/工作/目录', 'cursor-daemon'), '384c12f');
  assert.equal(cursorProjectDirectoryName(`/${'a'.repeat(260)}`, 'cursor-daemon'), `${'a'.repeat(238)}-4b89d45a6663f2d8`);
  assert.throws(() => cursorProjectDirectoryName('relative/path', 'cursor-daemon'), /absolute/u);
});

test('Gemini legacy recordings expose a uniquely identifiable project and bounded typed output', async t => {
  const root = await fixture(t);
  const projectRoot = join(root, 'project');
  const projectHash = createHash('sha256').update(projectRoot).digest('hex');
  const path = join(root, '.gemini', 'tmp', projectHash, 'chats', 'session-2026-a.json');
  await save(path, { sessionId: 'gemini-main', projectHash, startTime: timestamp, lastUpdated: timestamp, messages: [
    { id: 'user-1', type: 'user', timestamp, content: [{ text: 'inspect the test workspace' }] },
    { id: 'reply-1', type: 'gemini', timestamp, content: 'workspace inspected', toolCalls: [{ id: 'read-1', name: 'read_file', status: 'success', timestamp, result: [{ text: 'test file content' }] }] },
  ] });
  const sessions = await scanToolSessions('gemini', { homeDirectory: root });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.projectHash, projectHash);
  assert.equal(sessions[0]!.runningTurn, undefined, 'mtime and a final Gemini record alone do not prove turn status');
  assert.deepEqual(sessions[0]!.cwds, []);
  const output = await readObservedSessionOutput('gemini:process', sessions[0]!);
  assert.equal(output.state, 'ready');
  assert.deepEqual(output.entries.map(row => [row.role, row.text]), [['user', 'inspect the test workspace'], ['assistant', 'workspace inspected'], ['tool', 'test file content']]);
  assert.equal(output.sessionId, 'gemini:process');
});

test('current Gemini JSONL replays actual $patch, $set, $rewindTo records and slug-to-root registry', async t => {
  const root = await fixture(t), project = join(root, 'work');
  await save(join(root, '.gemini', 'projects.json'), { projects: { [project]: 'work' } });
  const path = join(root, '.gemini', 'tmp', 'work', 'chats', 'session-current.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  const records = [
    { sessionId: 'gemini-current', projectHash: 'hash', startTime: timestamp, lastUpdated: timestamp },
    { id: 'user-1', type: 'user', timestamp, content: 'hello' },
    { id: 'assistant-1', type: 'gemini', timestamp, content: '', toolCalls: [{ id: 'tool-1', name: 'read', status: 'executing' }] },
    { $patch: { id: 'assistant-1', content: 'patched response', toolCalls: [{ id: 'tool-1', result: 'tool result' }] } },
    { id: 'remove', type: 'gemini', timestamp, content: 'discard me' },
    { $rewindTo: 'remove' },
    { $set: { lastUpdated: '2026-11-10T10:02:00Z', summary: 'test title' } },
  ];
  await writeFile(path, records.map(value => JSON.stringify(value)).join('\n') + '\n{"partial":');
  const session = (await scanToolSessions('gemini', { homeDirectory: root }))[0]!;
  assert.equal(session.source, 'gemini-jsonl');
  assert.deepEqual(session.cwds, [project]);
  assert.equal(session.title, 'test title');
  assert.equal(session.runningTurn, true, 'recorded executing tool proves activity');
  assert.equal(session.lastActivityAtMs, Date.parse('2026-11-10T10:02:00Z'));
  const result = await readObservedSessionOutput('process', session);
  assert.deepEqual(result.entries.map(row => row.text), ['hello', 'patched response', 'tool result']);
});

test('Gemini JSONL rewinds absent IDs by clearing stale history and supports legacy checkpoints', async t => {
  const root = await fixture(t), path = join(root, '.gemini', 'tmp', 'project', 'chats', 'session-rewind.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, [
    { sessionId: 'rewind', projectHash: 'root', lastUpdated: timestamp },
    { id: 'old', type: 'user', content: 'must not leak stale output' },
    { $rewindTo: 'missing' },
    { $set: { messages: [{ id: 'new', type: 'gemini', content: 'checkpoint output' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const session = (await scanToolSessions('gemini', { homeDirectory: root }))[0]!;
  assert.deepEqual((await readObservedSessionOutput('process', session)).entries.map(row => row.text), ['checkpoint output']);
});

test('Gemini replay preserves batched patch order/removals and actual functionResponse tool outputs', async t => {
  const root = await fixture(t), path = join(root, '.gemini', 'tmp', 'project', 'chats', 'session-patches.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, [
    { sessionId: 'batched', projectHash: 'root', lastUpdated: timestamp },
    { id: 'prefix', type: 'user', content: 'prefix prompt' },
    { id: 'first', type: 'gemini', content: 'first reply' },
    { id: 'second', type: 'gemini', content: 'second reply' },
    { id: 'remove', type: 'gemini', content: 'removed reply' },
    { $patch: { updates: [{ id: 'first', content: 'patched first reply' }], removeIds: ['remove'], orderIds: ['second', 'first'] } },
    { id: 'tool', type: 'gemini', content: '', toolCalls: [{ id: 'read', status: 'executing' }] },
    { id: 'tool', type: 'gemini', content: '', toolCalls: [{ id: 'read', status: 'success', result: [{ functionResponse: { name: 'read_file', response: { output: 'actual file output' } } }] }] },
  ].map(row => JSON.stringify(row)).join('\n'));
  const session = (await scanToolSessions('gemini', { homeDirectory: root }))[0]!;
  assert.equal(session.runningTurn, undefined, 'a completed tool does not prove the model turn has ended');
  assert.deepEqual((await readObservedSessionOutput('gemini:batch', session)).entries.map(row => row.text), ['prefix prompt', 'second reply', 'patched first reply', 'actual file output']);
});

test('unsupported, partial, subagent and oversized Gemini recordings do not become live associations', async t => {
  const root = await fixture(t), folder = join(root, '.gemini', 'tmp', 'project', 'chats');
  await mkdir(folder, { recursive: true });
  await save(join(folder, 'session-unknown.json'), { messages: [{ text: 'not a Gemini session' }] });
  await save(join(folder, 'session-subagent.json'), { sessionId: 'subagent', projectHash: 'hash', kind: 'subagent', messages: [] });
  await writeFile(join(folder, 'session-partial.json'), '{"sessionId":');
  await writeFile(join(folder, 'session-large.json'), '{}');
  await truncate(join(folder, 'session-large.json'), 16 * 1024 * 1024 + 1);
  assert.deepEqual(await scanToolSessions('gemini', { homeDirectory: root }), []);
  const session: ObservedToolSession = { tool: 'gemini', id: 'large', cwds: [], lastActivityAtMs: null, source: 'gemini-json', path: join(folder, 'session-large.json') };
  assert.equal((await readObservedSessionOutput('process', session)).reason, 'transcript-too-large');
});

test('Cursor agent transcript JSONL retains only recognized message records', async t => {
  const root = await fixture(t), path = join(root, '.cursor', 'projects', 'test', 'agent-transcripts', 'cursor-chat.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, [
    { session_id: 'cursor-chat', cwd: '/workspace/cursor', timestamp },
    { type: 'user', uuid: 'u', message: { content: [{ type: 'text', text: 'hello cursor' }] }, timestamp },
    { type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'cursor reply' }] }, timestamp },
    { type: 'diagnostic', secret: 'do not publish diagnostic data' },
  ].map(row => JSON.stringify(row)).join('\n'));
  const session = (await scanToolSessions('cursor', { homeDirectory: root }))[0]!;
  assert.equal(session.id, 'cursor-chat'); assert.deepEqual(session.cwds, ['/workspace/cursor']);
  const output = await readObservedSessionOutput('cursor:process', session);
  assert.deepEqual(output.entries.map(row => row.text), ['hello cursor', 'cursor reply']);
});

test('Cursor 3.29 TranscriptStore role schema reads nested primary transcripts and explicit turn completion', async t => {
  const root = await fixture(t), path = join(root, '.cursor', 'projects', 'workspace-cursor', 'agent-transcripts', 'current-chat', 'current-chat.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, [
    { type: 'metadata', metadata: { overview: 'Current Cursor conversation' } },
    { role: 'user', message: { content: [{ type: 'text', text: 'current user question' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'current assistant reply' }, { type: 'tool_use', name: 'read_file', input: { path: '/workspace/test' } }] } },
    { type: 'turn_ended', status: 'success' },
  ].map(row => JSON.stringify(row)).join('\n'));
  const sessions = await scanToolSessions('cursor', { homeDirectory: root });
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.id, 'current-chat');
  assert.equal(sessions[0]!.projectSlug, 'workspace-cursor'); assert.equal(sessions[0]!.title, 'Current Cursor conversation');
  assert.equal(sessions[0]!.runningTurn, false); assert.equal(typeof sessions[0]!.lastActivityAtMs, 'number');
  assert.deepEqual((await readObservedSessionOutput('cursor:current', sessions[0]!)).entries.map(row => [row.role, row.text]), [['user', 'current user question'], ['assistant', 'current assistant reply']]);
});

test('Cursor SQLite composer state resolves workspace roots, status and bubble content without writes', async t => {
  const root = await fixture(t), config = join(root, 'config');
  const path = join(config, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  await mkdir(join(path, '..'), { recursive: true });
  await save(join(config, 'Cursor', 'User', 'workspaceStorage', 'workspace-id', 'workspace.json'), { folder: pathToFileURL(join(root, 'cursor-work')).href });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, value TEXT)');
  const insert = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  const data = { composerId: 'composer-1', workspaceIdentifier: { id: 'workspace-id' }, createdAt: Date.parse(timestamp), lastUpdatedAt: Date.parse(timestamp), status: 'generating', fullConversationHeadersOnly: [{ bubbleId: 'user' }, { bubbleId: 'reply' }], conversationMap: {}, name: 'Cursor test chat' };
  insert.run('composerData:composer-1', JSON.stringify(data));
  insert.run('composerData:draft', JSON.stringify({ ...data, composerId: 'draft', isDraft: true }));
  insert.run('composerData:archived', JSON.stringify({ ...data, composerId: 'archived', isArchived: true }));
  insert.run('bubbleId:composer-1:user', JSON.stringify({ bubbleId: 'user', type: 1, text: 'user question', createdAt: Date.parse(timestamp) }));
  insert.run('bubbleId:composer-1:reply', JSON.stringify({ bubbleId: 'reply', type: 2, text: 'assistant reply', createdAt: Date.parse(timestamp) }));
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?)').run('composer-1', 'workspace-id', JSON.stringify({ composerId: 'composer-1' }));
  db.close();
  const before = await readFile(path);
  const sessions = await scanToolSessions('cursor', { homeDirectory: root, appDataDirectory: config });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.runningTurn, true);
  assert.deepEqual(sessions[0]!.cwds, [join(root, 'cursor-work')]);
  const result = await readObservedSessionOutput('cursor:process', sessions[0]!);
  assert.deepEqual(result.entries.map(row => [row.role, row.text]), [['user', 'user question'], ['assistant', 'assistant reply']]);
  assert.deepEqual(await readFile(path), before, 'database content remains untouched');
});

test('Cursor summary without readable bubble content reports unavailable instead of claiming a transcript', async t => {
  const root = await fixture(t), config = join(root, 'config'), path = join(config, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  await mkdir(join(path, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:chat', JSON.stringify({ composerId: 'chat', status: 'none', workspaceIdentifier: { folder: '/workspace/cursor' }, fullConversationHeadersOnly: [{ bubbleId: 'encrypted' }], blobEncryptionKey: 'private-key-should-not-be-output' }));
  db.close();
  const sessions = await scanToolSessions('cursor', { homeDirectory: root, appDataDirectory: config });
  assert.equal(sessions[0]!.runningTurn, false);
  const result = await readObservedSessionOutput('cursor:chat', sessions[0]!);
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'composer-transcript-unavailable');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('Cursor bubble reads prioritize recent output within a cumulative byte budget', async t => {
  const root = await fixture(t), config = join(root, 'config'), path = join(config, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  await mkdir(join(path, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB); BEGIN');
  const insert = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  insert.run('composerData:chat', JSON.stringify({ composerId: 'chat', fullConversationHeadersOnly: Array.from({ length: 5 }, (_, index) => ({ bubbleId: String(index) })) }));
  const padding = 'x'.repeat(15 * 1024 * 1024);
  for (let index = 0; index < 5; index++) insert.run(`bubbleId:chat:${index}`, JSON.stringify({ type: 2, text: `reply ${index}`, padding }));
  db.exec('COMMIT'); db.close();
  const session: ObservedToolSession = { tool: 'cursor', id: 'chat', source: 'cursor-composer', path, cwds: [], lastActivityAtMs: null };
  const result = await readObservedSessionOutput('cursor:chat', session);
  assert.equal(result.truncated, true); assert.deepEqual(result.entries.map(row => row.text), ['reply 1', 'reply 2', 'reply 3', 'reply 4']);
});

test('Cursor oversized bubble values report unavailable without returning an empty ready transcript', async t => {
  const root = await fixture(t), path = join(root, 'state.vscdb');
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:chat', JSON.stringify({ composerId: 'chat', fullConversationHeadersOnly: [{ bubbleId: 'large' }] }));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, zeroblob(?))').run('bubbleId:chat:large', 16 * 1024 * 1024 + 1); db.close();
  const result = await readObservedSessionOutput('cursor:chat', { tool: 'cursor', id: 'chat', source: 'cursor-composer', path, cwds: [], lastActivityAtMs: null });
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'transcript-too-large'); assert.deepEqual(result.entries, []);
});

test('Cursor transcript and composer metadata merge by exact conversation ID and preserve readable output', async t => {
  const root = await fixture(t), config = join(root, 'config'), database = join(config, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  const path = join(root, '.cursor', 'projects', 'workspace', 'agent-transcripts', 'shared-chat.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'readable transcript' }] } }));
  await utimes(path, new Date(Date.parse(timestamp) - 1000), new Date(Date.parse(timestamp) - 1000));
  await mkdir(join(database, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(database);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:shared-chat', JSON.stringify({ composerId: 'shared-chat', status: 'generating', name: 'Composer title', workspaceIdentifier: { folder: '/workspace/cursor' }, createdAt: Date.parse(timestamp), lastUpdatedAt: Date.parse(timestamp), fullConversationHeadersOnly: [{ bubbleId: 'unreadable' }] }));
  db.close();
  const sessions = await scanToolSessions('cursor', { homeDirectory: root, appDataDirectory: config });
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.source, 'cursor-jsonl');
  assert.equal(sessions[0]!.title, 'Composer title'); assert.equal(sessions[0]!.runningTurn, true);
  assert.equal(sessions[0]!.cursorProfileDirectory, join(config, 'Cursor'));
  assert.deepEqual(sessions[0]!.cwds, ['/workspace/cursor']); assert.equal(sessions[0]!.startedAtMs, Date.parse(timestamp));
  assert.deepEqual((await readObservedSessionOutput('cursor:process', sessions[0]!)).entries.map(row => row.text), ['readable transcript']);
});

test('Cursor native daemon metadata merges only with its exact exported transcript and leaves busy unknown', async t => {
  const root = await fixture(t), daemon = join(root, '.cursor-agents'), workspace = '/workspace/Native_Cursor';
  const meta = { schemaVersion: 1, sessionId: 'native-chat', origin: 'host-native', createdAtMs: Date.parse(timestamp), updatedAtMs: Date.parse(timestamp), title: 'Native title', isArchived: false, workspacePaths: [workspace], latestRootBlobIdHex: 'a'.repeat(64) };
  await save(join(daemon, 'sessions', 'native-chat', 'meta.json'), meta);
  await save(join(daemon, 'sessions', 'archived', 'meta.json'), { ...meta, sessionId: 'archived', isArchived: true });
  await save(join(daemon, 'sessions', 'unknown', 'meta.json'), { ...meta, sessionId: 'unknown', schemaVersion: 2 });
  const transcript = join(daemon, 'projects', 'workspace-Native-Cursor', 'agent-transcripts', 'native-chat', 'native-chat.jsonl');
  await mkdir(join(transcript, '..'), { recursive: true });
  await writeFile(transcript, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'native exported output' }] } }));
  const sessions = await scanToolSessions('cursor', { homeDirectory: root });
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.id, 'native-chat'); assert.equal(sessions[0]!.source, 'cursor-jsonl');
  assert.equal(sessions[0]!.projectSlugKind, 'cursor-daemon'); assert.equal(sessions[0]!.title, 'Native title');
  assert.equal(sessions[0]!.cursorProfileDirectory, undefined);
  assert.deepEqual(sessions[0]!.cwds, [workspace]); assert.equal(sessions[0]!.runningTurn, undefined);
  assert.deepEqual((await readObservedSessionOutput('cursor:native', sessions[0]!)).entries.map(row => row.text), ['native exported output']);
});

test('Cursor native activity invalidates only older exported terminal state while retaining transcript output', async t => {
  const base = Date.parse(timestamp);
  for (const [name, nativeTime, exportTime, terminal, expected] of [
    ['new native activity after a successful turn', base + 2000, base, 'success', undefined],
    ['new native activity after an aborted turn', base + 2000, base, 'aborted', undefined],
    ['new terminal export after native activity', base, base + 2000, 'success', false],
    ['equal activity retains explicit terminal evidence', base, base, 'error', false],
  ] as const) await t.test(name, async t => {
    const root = await fixture(t), daemon = join(root, '.cursor-agents');
    await save(join(daemon, 'sessions', 'native-chat', 'meta.json'), { schemaVersion: 1, sessionId: 'native-chat', origin: 'host-native', createdAtMs: base - 1000, updatedAtMs: nativeTime, title: 'Native title', isArchived: false, workspacePaths: ['/workspace/native'], latestRootBlobIdHex: 'a'.repeat(64) });
    const path = join(daemon, 'projects', 'workspace-native', 'agent-transcripts', 'native-chat', 'native-chat.jsonl');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, [
      { role: 'assistant', message: { content: [{ type: 'text', text: 'retained exported answer' }] } },
      { type: 'turn_ended', status: terminal },
    ].map(row => JSON.stringify(row)).join('\n'));
    await utimes(path, new Date(exportTime), new Date(exportTime));
    const sessions = await scanToolSessions('cursor', { homeDirectory: root });
    assert.equal(sessions.length, 1); const session = sessions[0]!;
    assert.equal(session.runningTurn, expected); assert.equal(session.lastActivityAtMs, Math.max(nativeTime, exportTime));
    assert.equal(session.source, 'cursor-jsonl'); assert.equal(session.cursorProfileDirectory, undefined);
    assert.deepEqual((await readObservedSessionOutput('cursor:native', session)).entries.map(row => row.text), ['retained exported answer']);
  });
});

test('Cursor uses original activity times across native, composer and export sources and keeps composer profile ownership', async t => {
  const base = Date.parse(timestamp);
  for (const [name, nativeTime, composerTime, exportTime, expected] of [
    ['latest native activity clears both old explicit states', base + 3000, base + 2000, base + 1000, undefined],
    ['latest composer generating state remains busy', base + 2000, base + 3000, base + 1000, true],
    ['latest exported terminal state remains idle', base + 1000, base + 2000, base + 3000, false],
  ] as const) await t.test(name, async t => {
    const root = await fixture(t), profile = join(root, 'custom-profile'), daemon = join(root, '.cursor-agents');
    await save(join(daemon, 'sessions', 'shared-chat', 'meta.json'), { schemaVersion: 1, sessionId: 'shared-chat', origin: 'migrated-from-renderer-cas', createdAtMs: base, updatedAtMs: nativeTime, isArchived: false, workspacePaths: ['/workspace/cursor'], latestRootBlobIdHex: 'b'.repeat(64) });
    const path = join(daemon, 'projects', 'workspace-cursor', 'agent-transcripts', 'shared-chat', 'shared-chat.jsonl');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, [
      { role: 'assistant', message: { content: [{ type: 'text', text: 'shared exported answer' }] } },
      { type: 'turn_ended', status: 'success' },
    ].map(row => JSON.stringify(row)).join('\n'));
    await utimes(path, new Date(exportTime), new Date(exportTime));
    const database = join(profile, 'User', 'globalStorage', 'state.vscdb');
    await mkdir(join(database, '..'), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(database);
    db.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:shared-chat', JSON.stringify({ composerId: 'shared-chat', status: 'generating', createdAt: base, lastUpdatedAt: composerTime, workspaceIdentifier: { folder: '/workspace/cursor' }, fullConversationHeadersOnly: [{ bubbleId: 'unreadable' }] }));
    db.close();
    const sessions = await scanToolSessions('cursor', { homeDirectory: root, cursorUserDataDirectory: profile });
    assert.equal(sessions.length, 1); const session = sessions[0]!;
    assert.equal(session.runningTurn, expected); assert.equal(session.lastActivityAtMs, Math.max(nativeTime, composerTime, exportTime));
    assert.equal(session.source, 'cursor-jsonl'); assert.equal(session.path, path); assert.equal(session.cursorProfileDirectory, profile);
    assert.deepEqual((await readObservedSessionOutput('cursor:shared', session)).entries.map(row => row.text), ['shared exported answer']);
  });
});

test('Cursor selects the newest exported transcript when legacy and native stores contain the same session ID', async t => {
  const root = await fixture(t), base = Date.parse(timestamp);
  for (const [directory, text, offset, terminal] of [['.cursor', 'old export', 0, true], ['.cursor-agents', 'new export', 2000, false]] as const) {
    const path = join(root, directory, 'projects', 'workspace-cursor', 'agent-transcripts', 'shared-chat.jsonl');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, [
      { role: 'assistant', message: { content: [{ type: 'text', text }] } },
      ...(terminal ? [{ type: 'turn_ended', status: 'success' }] : []),
    ].map(row => JSON.stringify(row)).join('\n'));
    await utimes(path, new Date(base + offset), new Date(base + offset));
  }
  const sessions = await scanToolSessions('cursor', { homeDirectory: root });
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.projectSlugKind, 'cursor-daemon');
  assert.equal(sessions[0]!.runningTurn, undefined); assert.equal(sessions[0]!.cursorProfileDirectory, undefined);
  assert.deepEqual((await readObservedSessionOutput('cursor:shared', sessions[0]!)).entries.map(row => row.text), ['new export']);
});

test('Cursor native metadata without an exported transcript reports unavailable and reads only the known exec-config key', async t => {
  const root = await fixture(t), daemon = join(root, '.cursor-agents-dev');
  await save(join(daemon, 'sessions', 'native-chat', 'meta.json'), { schemaVersion: 1, sessionId: 'native-chat', origin: 'host-native', createdAtMs: Date.parse(timestamp), isArchived: false, latestRootBlobIdHex: 'a'.repeat(64) });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(daemon, 'data.sqlite'));
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('agentHostDaemon:execConfig:native-chat', JSON.stringify({ workspacePaths: ['/workspace/native'] }));
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('agentHostDaemon:blobEncryptionKey:native-chat', 'private encryption key');
  db.close();
  const session = (await scanToolSessions('cursor', { homeDirectory: root }))[0]!;
  assert.deepEqual(session.cwds, ['/workspace/native']); assert.equal(session.source, 'cursor-agent-host'); assert.equal(session.runningTurn, undefined);
  assert.equal(session.cursorProfileDirectory, undefined);
  const result = await readObservedSessionOutput('cursor:native', session);
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'host-transcript-unavailable'); assert.deepEqual(result.entries, []);
  assert.equal(JSON.stringify(session).includes('private encryption'), false);
});

test('Cursor explicit user-data profile scopes both composer data and workspace roots', async t => {
  const root = await fixture(t), config = join(root, 'config'), custom = join(root, 'custom-profile');
  const { DatabaseSync } = await import('node:sqlite');
  for (const [profile, id] of [[join(config, 'Cursor'), 'default-chat'], [custom, 'custom-chat']] as const) {
    const path = join(profile, 'User', 'globalStorage', 'state.vscdb'); await mkdir(join(path, '..'), { recursive: true });
    await save(join(profile, 'User', 'workspaceStorage', 'workspace-id', 'workspace.json'), { folder: pathToFileURL(join(root, id)).href });
    const db = new DatabaseSync(path); db.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`composerData:${id}`, JSON.stringify({ composerId: id, workspaceIdentifier: { id: 'workspace-id' }, status: 'none', fullConversationHeadersOnly: [{ bubbleId: 'user' }] })); db.close();
  }
  const sessions = await scanToolSessions('cursor', { homeDirectory: root, appDataDirectory: config, cursorUserDataDirectory: custom });
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.id, 'custom-chat'); assert.deepEqual(sessions[0]!.cwds, [join(root, 'custom-chat')]);
  assert.equal(sessions[0]!.cursorProfileDirectory, custom);
});

test('Antigravity uses explicit not_fully_idle and excludes killed conversations; summary-only output is unavailable', async t => {
  const root = await fixture(t), path = join(root, '.gemini', 'antigravity', 'conversation_summaries.db');
  await mkdir(join(path, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path);
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, last_user_input_time TEXT, status TEXT, not_fully_idle INTEGER, killed INTEGER)');
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('antigravity-main', 'Antigravity test', JSON.stringify([pathToFileURL(join(root, 'ag-work')).href]), timestamp, timestamp, 'running', 1, 0);
  insert.run('killed', 'Old process', '[]', timestamp, timestamp, 'stopped', 0, 1);
  db.close(); const before = await readFile(path);
  const sessions = await scanToolSessions('antigravity', { homeDirectory: root });
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.runningTurn, true); assert.deepEqual(sessions[0]!.cwds, [join(root, 'ag-work')]);
  const result = await readObservedSessionOutput('antigravity:process', sessions[0]!);
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'conversation-summary-only');
  assert.deepEqual(await readFile(path), before);
});

test('Antigravity CLI/IDE namespaces accept known summary columns without inventing missing busy status', async t => {
  const root = await fixture(t), path = join(root, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  await mkdir(join(path, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path);
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, last_modified_time TEXT)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('cli-chat', JSON.stringify(['/workspace/antigravity']), timestamp); db.close();
  const sessions = await scanToolSessions('antigravity', { homeDirectory: root });
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.id, 'cli-chat'); assert.equal(sessions[0]!.runningTurn, undefined);
  assert.deepEqual(sessions[0]!.cwds, ['/workspace/antigravity']); assert.equal((await readObservedSessionOutput('antigravity:cli', sessions[0]!)).reason, 'conversation-summary-only');
});

test('Antigravity FTS5 stored user/agent bodies provide real bounded projection output', async t => {
  const root = await fixture(t), path = join(root, '.gemini', 'antigravity', 'conversation_summaries.db');
  await mkdir(join(path, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path);
  db.exec('CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, user_body, agent_body, last_step_created_at UNINDEXED)');
  db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)').run('chat', 0, 'question', 'answer', timestamp);
  db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)').run('other', 1, 'other question', 'must not leak other conversations', timestamp);
  db.close();
  const session: ObservedToolSession = { tool: 'antigravity', id: 'chat', cwds: ['/workspace'], source: 'antigravity-projection', path, lastActivityAtMs: Date.parse(timestamp) };
  const result = await readObservedSessionOutput('antigravity:process', session);
  assert.equal(result.state, 'ready'); assert.deepEqual(result.entries.map(row => [row.role, row.text]), [['user', 'question'], ['assistant', 'answer']]);
});

test('Antigravity projection reads a bounded recent rowid window and never substitutes another conversation', async t => {
  const root = await fixture(t), path = join(root, '.gemini', 'antigravity', 'conversation_summaries.db');
  await mkdir(join(path, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path);
  db.exec('CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, user_body, agent_body, last_step_created_at UNINDEXED); BEGIN');
  const insert = db.prepare('INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)');
  insert.run('old-chat', 0, 'old question', 'old answer', timestamp);
  for (let index = 0; index < 1000; index++) insert.run('another-chat', index, '', 'unrelated conversation output', timestamp);
  db.exec('COMMIT'); db.close();
  const session: ObservedToolSession = { tool: 'antigravity', id: 'old-chat', cwds: [], source: 'antigravity-projection', path, lastActivityAtMs: Date.parse(timestamp) };
  const result = await readObservedSessionOutput('antigravity:old-process', session);
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'transcript-too-large'); assert.deepEqual(result.entries, []);
});

test('bounded readers truncate oversized output without splitting Unicode', async t => {
  const root = await fixture(t), folder = join(root, '.gemini', 'tmp', 'test', 'chats'), path = join(folder, 'session-real.json');
  await save(path, { sessionId: 'chat', projectHash: 'test', messages: [{ id: 'reply', type: 'gemini', content: '🚀'.repeat(100_000) }] });
  const sessions = await scanToolSessions('gemini', { homeDirectory: root });
  assert.equal(sessions.length, 1);
  const result = await readObservedSessionOutput('process', sessions[0]!);
  assert.equal(result.truncated, true); assert(result.entries[0]!.text.length <= 128 * 1024);
  assert.equal(/^[\uDC00-\uDFFF]/u.test(result.entries[0]!.text), false);
});

test('bounded discovery rejects symlink transcripts and project directories', { skip: process.platform === 'win32' && 'Windows file symlinks require developer mode or administrator privileges' }, async t => {
  const root = await fixture(t), folder = join(root, '.gemini', 'tmp', 'test', 'chats'), path = join(folder, 'session-real.json');
  await save(path, { sessionId: 'chat', projectHash: 'test', messages: [] });
  await symlink(path, join(folder, 'session-link.json'));
  await symlink(join(folder, '..'), join(root, '.gemini', 'tmp', 'linked-project'), 'dir');
  assert.equal((await scanToolSessions('gemini', { homeDirectory: root })).length, 1);
});

test('missing or unrelated product databases do not fabricate observed sessions', async t => {
  const root = await fixture(t);
  assert.deepEqual(await scanToolSessions('gemini', { homeDirectory: root }), []);
  assert.deepEqual(await scanToolSessions('cursor', { homeDirectory: root }), []);
  assert.deepEqual(await scanToolSessions('antigravity', { homeDirectory: root }), []);
});
