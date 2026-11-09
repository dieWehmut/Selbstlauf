import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConversationMetadata } from '../src/runtime/conversation-metadata.js';

test('Codex uses the latest complete lifecycle event, ignoring an unfinished JSONL write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-metadata-'));
  try {
    const path = join(dir, 'rollout.jsonl');
    const events = ['task_started', 'task_complete', 'task_started', 'turn_aborted'];
    await writeFile(path, events.map(type => JSON.stringify({ type: 'event_msg', payload: { type } })).join('\n') + '\n{"type":');
    assert.deepEqual(await readConversationMetadata(path, 'codex'), { runningTurn: false });
    await writeFile(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }));
    assert.deepEqual(await readConversationMetadata(path, 'codex'), { runningTurn: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Claude tracks tool continuation then final response and retains explicit title', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-metadata-'));
  try {
    const path = join(dir, 'session.jsonl');
    await writeFile(path, [
      { type: 'custom-title', customTitle: 'Project task' },
      { type: 'assistant', message: { stop_reason: 'tool_use' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    assert.deepEqual(await readConversationMetadata(path, 'claude'), { title: 'Project task', runningTurn: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('retains running lifecycle before a large output and refreshes after completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-metadata-'));
  try {
    const path = join(dir, 'rollout.jsonl');
    const content = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n'
      + JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(300_000) } }) + '\n';
    await writeFile(path, content);
    assert.equal((await readConversationMetadata(path, 'codex')).runningTurn, true);
    await writeFile(path, content + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }));
    assert.equal((await readConversationMetadata(path, 'codex')).runningTurn, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('incremental metadata rereads a split UTF-8 JSONL write and resets after truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-metadata-'));
  try {
    const path = join(dir, 'session.jsonl');
    await writeFile(path, JSON.stringify({ type: 'custom-title', customTitle: '项目标题' }) + '\n' + '{"type":"assistant","message":');
    assert.deepEqual(await readConversationMetadata(path, 'claude'), { title: '项目标题' });
    await appendFile(path, '{"stop_reason":"end_turn"}}\n');
    assert.deepEqual(await readConversationMetadata(path, 'claude'), { title: '项目标题', runningTurn: false });
    await writeFile(path, '');
    assert.deepEqual(await readConversationMetadata(path, 'claude'), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});
