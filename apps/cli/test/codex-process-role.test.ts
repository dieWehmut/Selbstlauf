import assert from 'node:assert/strict';
import test from 'node:test';
import { groupProcesses } from '../src/process/discovery.js';
import type { RawProcessRecord } from '../src/process/process-provider.js';

function record(pid: number, parentPid: number, args: string[]): RawProcessRecord {
  return { pid, parentPid, name: 'codex.exe', executablePath: 'C:\\tools\\codex.exe', commandLine: args.join(' '), arguments: args, creationTimeMs: 1000, userSid: 'user' };
}

test('app-server prompt and flag values never classify an ordinary Codex CLI as a shared daemon', () => {
  for (const args of [['codex.exe', 'exec', 'app-server'], ['codex.exe', '-p', 'app-server'], ['codex.exe', '--cd', 'app-server']]) {
    assert.equal(groupProcesses([record(100, 1, args)], { sameUserOnly: false })[0]?.codexAppServer, undefined);
  }
});

test('a real App Server folded into a CLI root still exposes its child writer ownership', () => {
  const groups = groupProcesses([
    record(100, 1, ['codex.exe']),
    record(101, 100, ['codex.exe', 'app-server', '--managed-daemon']),
  ], { sameUserOnly: false });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.rootPid, 100);
  assert.deepEqual(groups[0]?.childPids, [101]);
  assert.equal(groups[0]?.codexAppServer, true);
});

test('Codex global option values before app-server preserve its true subcommand', () => {
  for (const args of [
    ['codex.exe', '-c', 'model_reasoning_effort="high"', 'app-server', '--managed-daemon'],
    ['codex.exe', '--cd', 'app-server', 'app-server'],
    ['codex.exe', '--model=app-server', '--full-auto', 'app-server'],
  ]) assert.equal(groupProcesses([record(100, 1, args)], { sameUserOnly: false })[0]?.codexAppServer, true);
  for (const args of [['codex.exe', '--model=app-server'], ['codex.exe', '--unknown', 'app-server']]) {
    assert.equal(groupProcesses([record(100, 1, args)], { sameUserOnly: false })[0]?.codexAppServer, undefined);
  }
});
