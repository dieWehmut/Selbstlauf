import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionOutput } from '../src/runtime/session-output.js';

test('reads real Claude JSONL messages and tool results without treating reasoning or partial writes as responses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'session-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'claude.jsonl');
  await writeFile(path, [
    { type: 'user', timestamp: '2026-10-19T00:00:00Z', message: { content: '真实输入' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: '实际回复' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: '工具的实际输出' }] }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n{"type":"assistant"');
  const output = await readSessionOutput('claude:1', 'claude-jsonl', path);
  assert.equal(output.state, 'ready');
  assert.deepEqual(output.entries.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '真实输入' }, { role: 'assistant', text: '实际回复' }, { role: 'tool', text: '工具的实际输出' },
  ]);
  assert.equal(output.entries[0]?.timestampMs, Date.parse('2026-10-19T00:00:00Z'));
  assert.ok(!JSON.stringify(output).includes('PRIVATE_REASONING'));
});

test('reads a Codex rollout once per message, including tool output and excluding event mirrors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'session-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'codex.jsonl');
  await writeFile(path, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex 输入' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '回复' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回复' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'exit code 0' } },
  ].map((row) => JSON.stringify(row)).join('\n'));
  const result = await readSessionOutput('codex:2', 'codex-rollout', path);
  assert.deepEqual(result.entries.map((entry) => entry.text), ['Codex 输入', '回复', 'exit code 0']);
  assert.equal(result.entries[2]?.role, 'tool');
});

test('reads live DeepSeek Harness prompts, responses and the current response draft from its projection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'session-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'dsh.json');
  await writeFile(path, JSON.stringify({ version: 7, record: { rows: { turnOutline: { ver: 1, seq: 20, val: {
    turns: [{ turn: 1, seq: 10, prompt: 'Harness 输入', response: 'Harness 回复' }], draft: '正在输出的部分',
  } } } } }));
  const result = await readSessionOutput('dsh:3', 'dsh-projection', path);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.entries.map((entry) => entry.text), ['Harness 输入', 'Harness 回复', '正在输出的部分']);
  await writeFile(path, '{}');
  assert.equal((await readSessionOutput('dsh:3', 'dsh-projection', path)).reason, 'projection-format-unsupported');
});

test('bounds large histories, keeps the newest Unicode response and reports missing records truthfully', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'session-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'large.jsonl');
  const history = Array.from({ length: 180 }, (_, id) => JSON.stringify({ type: 'assistant', message: { content: `${id} ${'😀中文'.repeat(2000)}` } }));
  history.push(JSON.stringify({ type: 'assistant', message: { content: '最新真实回复 😀' } }));
  await writeFile(path, history.join('\n'));
  const result = await readSessionOutput('claude:4', 'claude-jsonl', path);
  assert.equal(result.truncated, true);
  assert.equal(result.entries.at(-1)?.text, '最新真实回复 😀');
  assert.ok(result.entries.length <= 120);
  assert.ok(result.entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 128 * 1024);
  assert.ok(!result.entries.some((entry) => /^[\uDC00-\uDFFF]/u.test(entry.text)));
  await rm(path);
  const missing = await readSessionOutput('claude:4', 'claude-jsonl', path);
  assert.equal(missing.state, 'unavailable'); assert.equal(missing.reason, 'transcript-missing');
  assert.deepEqual(missing.entries, []);
});
