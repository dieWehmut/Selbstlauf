import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { ClaudeLeaseStore } from '../src/claude/lease-store.js';
import { decideClaudeStopHook } from '../src/claude/stop-hook.js';

const cliPath = resolve(fileURLToPath(import.meta.url), '../../src/claude/stop-hook-cli.js');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claude-stop-hook-'));
  const transcript = join(root, 'transcript.jsonl');
  const leasePath = join(root, 'state', 'claude-leases.json');
  await writeFile(transcript, '{"role":"assistant","text":"done"}\n', 'utf8');
  const store = new ClaudeLeaseStore(leasePath);
  const input = {
    hook_event_name: 'Stop',
    session_id: 'session-a',
    cwd: root,
    transcript_path: transcript,
    stop_hook_active: false,
    last_assistant_message: 'ignored',
  };
  return { root, transcript, leasePath, store, input };
}

async function arm(store: ClaudeLeaseStore, transcript: string, input: Record<string, unknown>, ttlMs = 10_000) {
  const activity = await stat(transcript);
  await store.arm({
    sessionId: input.session_id as string,
    cwd: input.cwd as string,
    prompt: '继续',
    rootPid: 100,
    processStartedAtMs: 1_000,
    activity: { size: activity.size, mtimeMs: activity.mtimeMs },
    transcriptPath: transcript,
    ttlMs,
  });
}

test('returns a block decision for one exact Claude Stop Hook lease', async () => {
  const { store, transcript, input } = await fixture();
  await arm(store, transcript, input);

  assert.deepEqual(await decideClaudeStopHook(store, input), {
    decision: 'block',
    reason: '继续',
    systemMessage: 'Continuation watchdog submitted a follow-up.',
  });
  assert.deepEqual(await decideClaudeStopHook(store, input), {});
});

test('fails closed for recursion, unrelated events, malformed input, or no store', async () => {
  const { store, transcript, input } = await fixture();
  await arm(store, transcript, input);

  assert.deepEqual(await decideClaudeStopHook(store, { ...input, stop_hook_active: true }), {});
  assert.deepEqual(await decideClaudeStopHook(store, { ...input, hook_event_name: 'UserPromptSubmit' }), {});
  assert.deepEqual(await decideClaudeStopHook(store, { ...input, session_id: '' }), {});
  assert.deepEqual(await decideClaudeStopHook(null, input), {});
});

test('fails closed when transcript activity changes or the lease expires', async () => {
  const { store, transcript, input } = await fixture();
  await arm(store, transcript, input, 1);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  assert.deepEqual(await decideClaudeStopHook(store, input), {});

  await arm(store, transcript, input);
  const changed = new Date(Date.now() + 2_000);
  await utimes(transcript, changed, changed);
  assert.deepEqual(await decideClaudeStopHook(store, input), {});
});

test('CLI emits one JSON response and never logs sensitive input', async () => {
  const { store, transcript, input, leasePath } = await fixture();
  await arm(store, transcript, input);
  const child = spawn(process.execPath, [
    cliPath,
    '--lease-file', leasePath,
    '--owner', 'selbstlauf-continuation-v1',
  ], {
    cwd: resolve(fileURLToPath(import.meta.url), '../../../..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  const [stdout, stderr, result] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    once(child, 'close'),
  ]);
  assert.equal((result as [number])[0], 0);
  assert.deepEqual(JSON.parse(stdout), {
    decision: 'block',
    reason: '继续',
    systemMessage: 'Continuation watchdog submitted a follow-up.',
  });
  assert.equal(stderr, '');
  assert.doesNotMatch(stderr, /继续|transcript|settings|token/u);
});

test('CLI fails closed for an unexpected ownership marker', async () => {
  const { leasePath } = await fixture();
  const child = spawn(process.execPath, [
    cliPath,
    '--lease-file', leasePath,
    '--owner', 'another-owner',
  ], {
    cwd: resolve(fileURLToPath(import.meta.url), '../../../..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.end('{}\n');
  const [stdout, stderr, result] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    once(child, 'close'),
  ]);
  assert.equal((result as [number])[0], 0);
  assert.deepEqual(JSON.parse(stdout), {});
  assert.equal(stderr, '');
});

test('CLI returns an empty decision for malformed and oversized stdin', async () => {
  const { leasePath } = await fixture();
  for (const payload of ['not-json\n', `${'x'.repeat(65_537)}\n`]) {
    const child = spawn(process.execPath, [cliPath, '--lease-file', leasePath], {
      cwd: resolve(fileURLToPath(import.meta.url), '../../../..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.end(payload);
    const [stdout, stderr, result] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      once(child, 'close'),
    ]);
    assert.equal((result as [number])[0], 0);
    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(stderr, '');
  }
});

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as string | Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}
