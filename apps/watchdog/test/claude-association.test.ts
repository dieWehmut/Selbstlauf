import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  associateClaudeSession,
  hasClaudeSessionActivity,
  scanClaudeSessionFiles,
  type ClaudeProcessRecord,
  type ClaudeSessionFile,
} from '../src/association/claude.js';

const processRecord: ClaudeProcessRecord = {
  pid: 1200,
  cwd: 'C:\\work\\demo',
  creationTimeMs: 10_000,
  commandLine: 'claude --resume demo',
};

test('associates the newest unique Claude JSONL for the process project', () => {
  const files: ClaudeSessionFile[] = [
    { path: 'C:\\sessions\\old.jsonl', projectPath: 'C:\\work\\demo', sessionId: 'old', size: 20, mtimeMs: 9_000 },
    { path: 'C:\\sessions\\new.jsonl', projectPath: 'C:\\work\\demo', sessionId: 'new', size: 40, mtimeMs: 11_000 },
    { path: 'C:\\sessions\\other.jsonl', projectPath: 'C:\\work\\other', sessionId: 'other', size: 50, mtimeMs: 12_000 },
  ];

  const result = associateClaudeSession(processRecord, files);
  assert.equal(result.conversationId, 'new');
  assert.equal(result.sessionPath, 'C:\\sessions\\new.jsonl');
  assert.equal(result.transport, 'monitor-only');
  assert.deepEqual(result.activity, { size: 40, mtimeMs: 11_000 });
});

test('fails closed when project/session association is ambiguous', () => {
  const files: ClaudeSessionFile[] = [
    { path: 'a.jsonl', projectPath: 'C:\\work\\demo', sessionId: 'a', size: 1, mtimeMs: 10_100 },
    { path: 'b.jsonl', projectPath: 'C:\\work\\demo', sessionId: 'b', size: 2, mtimeMs: 10_200 },
  ];

  const result = associateClaudeSession(processRecord, files, { recentWindowMs: 500 });
  assert.equal(result.conversationId, null);
  assert.equal(result.transport, 'monitor-only');
  assert.match(result.reason ?? '', /ambiguous/i);
});

test('can expose an explicitly supplied writable transport only for a unique match', () => {
  const result = associateClaudeSession(
    processRecord,
    [{ path: 'a.jsonl', projectPath: 'C:\\work\\demo', sessionId: 'a', size: 1, mtimeMs: 10_100 }],
    { transport: 'pty' },
  );
  assert.equal(result.conversationId, 'a');
  assert.equal(result.transport, 'pty');
});

test('scans only JSONL metadata and detects file activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-projects-'));
  const project = join(root, 'D--work--demo');
  await mkdir(project);
  const path = join(project, 'session-a.jsonl');
  await writeFile(path, `${JSON.stringify({ cwd: 'D:\\work\\demo', sessionId: 'session-a', transcript: 'not retained' })}\nsecond line`);
  await writeFile(join(project, 'memory.md'), 'ignored');

  const files = await scanClaudeSessionFiles(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].projectPath, 'D:\\work\\demo');
  assert.equal(files[0].sessionId, 'session-a');
  assert.equal('transcript' in files[0], false);
  assert.equal(hasClaudeSessionActivity(files[0], { ...files[0], size: files[0].size + 1 }), true);
  assert.equal(hasClaudeSessionActivity(files[0], files[0]), false);
});
