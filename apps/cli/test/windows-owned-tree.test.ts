import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { killWindowsOwnedTree, selectWindowsOwnedTree } from '../src/process/windows-owned-tree.js';

const identity = { pid: 10, createdAfterMs: 1_000, createdBeforeMs: 1_100 };

test('owned-tree selection excludes original user roots and stale reused parent PIDs', () => {
  const selected = selectWindowsOwnedTree(identity, [
    { pid: 10, parentPid: 99, createdAtMs: 1_050 },
    { pid: 11, parentPid: 10, createdAtMs: 1_060 },
    { pid: 12, parentPid: 11, createdAtMs: 1_070 },
    { pid: 13, parentPid: 10, createdAtMs: 900 },
    { pid: 14, parentPid: 13, createdAtMs: 950 },
    { pid: 2614153, parentPid: 99, createdAtMs: 500 },
  ]);
  assert.deepEqual(selected.map(row => row.pid), [12, 11, 10]);
  assert.deepEqual(selectWindowsOwnedTree({ ...identity, pid: 2614153 }, [
    { pid: 2614153, parentPid: 99, createdAtMs: 500 },
  ]), []);
});

test('a vanished or reused root cannot authorize its old descendants', () => {
  assert.deepEqual(selectWindowsOwnedTree(identity, [{ pid: 11, parentPid: 10, createdAtMs: 1_060 }]), []);
  assert.deepEqual(selectWindowsOwnedTree(identity, [
    { pid: 10, parentPid: 99, createdAtMs: 2_000 },
    { pid: 11, parentPid: 10, createdAtMs: 2_010 },
  ]), []);
});

test('a hung cleanup runner returns a bounded explicit unverified deadline', async () => {
  let signal: AbortSignal | undefined;
  const started = Date.now();
  const result = await killWindowsOwnedTree({ ...identity, timeoutMs: 20,
    runCommand: async (_path, _args, abort) => { signal = abort; return await new Promise<string>(() => {}); },
  });
  assert.equal(result.verified, false);
  assert.match(result.error ?? '', /deadline.*20ms/iu);
  assert.equal(signal?.aborted, true);
  assert(Date.now() - started < 1_000);
});

test('cleanup rejects malformed identities before spawning any helper', async () => {
  let calls = 0;
  for (const bad of [{ ...identity, pid: 0 }, { ...identity, createdAfterMs: 2_000 }, { ...identity, createdBeforeMs: Number.NaN }]) {
    const result = await killWindowsOwnedTree({ ...bad, runCommand: async () => { calls++; return '{"verified":true}'; } });
    assert.equal(result.verified, false);
    assert.match(result.error ?? '', /identity/iu);
  }
  assert.equal(calls, 0);
});

test('the cleanup result must explicitly confirm every owned process terminated', async () => {
  assert.deepEqual(await killWindowsOwnedTree({ ...identity, runCommand: async () => '{"verified":true}' }), { verified: true });
  assert.deepEqual(await killWindowsOwnedTree({ ...identity, runCommand: async () => '{"verified":false,"error":"root identity mismatch"}' }),
    { verified: false, error: 'root identity mismatch' });
  const invalid = await killWindowsOwnedTree({ ...identity, runCommand: async () => 'not JSON' });
  assert.equal(invalid.verified, false);
});

test('Windows native cleanup terminates its exact tree and preserves a foreign original root', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-native-owned-tree-'));
  const pidFile = join(directory, 'pids.json');
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await delay(30);
  const createdAfterMs = Date.now();
  const root = spawn(process.execPath, ['-e', [
    'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
    'setInterval(() => {}, 1000);',
  ].join('\n')], { stdio: 'ignore', windowsHide: true });
  const createdBeforeMs = Date.now() + 1;
  let pids: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    for (let attempt = 0; attempt < 80 && pids.length === 0; attempt++) {
      try { pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[]; } catch { await delay(25); }
    }
    assert.equal(pids.length, 2);
    const refused = await killWindowsOwnedTree({ pid: foreign.pid!, createdAfterMs, createdBeforeMs, timeoutMs: 4_000 });
    assert.equal(refused.verified, false);
    assert.equal(alive(foreign.pid!), true, 'a foreign original root must remain running');
    const result = await killWindowsOwnedTree({ pid: root.pid!, createdAfterMs, createdBeforeMs, timeoutMs: 4_000 });
    assert.deepEqual(result, { verified: true });
    assert.deepEqual(pids.filter(alive), []);
    assert.equal(alive(foreign.pid!), true);
  } finally {
    for (const child of [root, foreign]) { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    await rm(directory, { recursive: true, force: true });
  }
});
