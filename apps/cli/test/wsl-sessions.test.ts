import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { groupProcesses } from '../src/process/discovery.js';
import { snapshotWslCodexState } from '../src/codex/wsl-state.js';
import type { RawProcessRecord } from '../src/process/process-provider.js';

/**
 * WSL sessions in discovery, and reading their Codex state.
 *
 * Two things make WSL different enough to need their own tests: a Linux pid is unrelated to a Windows pid of
 * the same number, and the state database cannot be opened where it lives.
 */

function wslRecord(pid: number, parentPid: number, commandLine: string, cwd?: string): RawProcessRecord {
  return {
    pid,
    parentPid,
    name: 'node',
    commandLine,
    executablePath: null,
    userSid: null,
    creationTimeMs: null,
    ancestors: [],
    windows: [],
    ...(cwd === undefined ? {} : { workingDirectory: cwd }),
  };
}

test('a WSL group is stamped with its distribution and gets no host', () => {
  /**
   * The host is deliberately absent. `classifySessionHost` answers "which application is this running inside"
   * from the ancestor chain and the desktop's window list, and a Linux process has neither — measured, a WSL
   * pid has no Win32 window at all. Any host it produced would be a guess about Windows processes numbered the
   * same, and the UI says "no window" instead, which is true.
   *
   * The record below is given a Tabby ancestor and a Tabby window ON PURPOSE. A bare record would return no
   * host anyway, so the test would pass with or without the rule — the first version of this test did exactly
   * that and proved nothing. This one fails if the rule is removed, which is what makes it worth keeping.
   */
  const withTerminalAncestor: RawProcessRecord = {
    ...wslRecord(98051, 66225, 'node /home/han/.nvm/versions/node/v24.21.0/bin/codex', '/home/han/project'),
    ancestors: [
      { pid: 66225, name: 'bash' },
      { pid: 19272, name: 'Tabby.exe' },
    ],
    windows: [
      { handle: 67008, pid: 19272, processName: 'Tabby.exe', title: 'MicEye', className: 'CASCADIA_HOSTING_WINDOW_CLASS', visible: true },
    ],
  };

  const groups = groupProcesses([withTerminalAncestor], { distribution: 'Ubuntu-22.04', sameUserOnly: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.distribution, 'Ubuntu-22.04');
  assert.equal(
    groups[0]?.host,
    undefined,
    'a WSL session must not borrow a Windows window as its host: a Linux pid has no Win32 window',
  );
});

test('the Linux launcher is recognised without a file extension', () => {
  /**
   * Measured: inside Ubuntu the session root is `node <prefix>/bin/codex`, an extension-less launcher, while
   * the child is `.../@openai/codex-linux-x64/vendor/.../bin/codex`. Without the extension-less form the root
   * was missed and the session was reported as a bare child process.
   */
  const groups = groupProcesses(
    [
      wslRecord(98051, 66225, 'node /home/han/.nvm/versions/node/v24.21.0/bin/codex', '/home/han/project'),
      wslRecord(98058, 98051, '/home/han/.nvm/versions/node/v24.21.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex', '/home/han/project'),
    ],
    { distribution: 'Ubuntu-22.04', sameUserOnly: true },
  );
  assert.equal(groups.length, 1, 'the root and its child should be one session');
  assert.equal(groups[0]?.rootPid, 98051);
  assert.deepEqual(groups[0]?.childPids, [98058]);
});

test('a WSL session is not subject to the Windows same-user check', () => {
  // A Linux record carries no Windows SID, so requiring one would reject every WSL session.
  const groups = groupProcesses(
    [wslRecord(5, 1, 'node /usr/local/bin/codex')],
    { distribution: 'Ubuntu-22.04', sameUserOnly: true },
  );
  assert.equal(groups.length, 1);
});

test('the watchdog PID does not exclude anything inside a distribution', () => {
  /**
   * The watchdog's own buses are excluded on Windows so it cannot monitor its own transport. Inside a
   * distribution that number means nothing, so applying it would silently drop an unrelated process — and a
   * distribution's pid 1 is a real process.
   */
  const groups = groupProcesses(
    [wslRecord(1, 0, 'node /usr/local/bin/codex')],
    { distribution: 'Ubuntu-22.04', currentProcessId: 1, sameUserOnly: true },
  );
  assert.equal(groups.length, 1, 'pid 1 inside the distribution must not be treated as the watchdog');
});

test('snapshots the state database together with its write-ahead log', () => {
  /**
   * The sidecars are not optional: a database in WAL mode is not consistent without them, and copying only the
   * main file would silently read a stale view — measured, the threads table lives in the main file but recent
   * writes sit in the log.
   */
  const source = mkdtempSync(join(tmpdir(), 'wsl-state-src-'));
  const target = mkdtempSync(join(tmpdir(), 'wsl-state-dst-'));
  try {
    writeFileSync(join(source, 'state_5.sqlite'), 'main');
    writeFileSync(join(source, 'state_5.sqlite-wal'), 'log');
    writeFileSync(join(source, 'state_5.sqlite-shm'), 'shm');
    writeFileSync(join(source, 'goals_1.sqlite'), 'goals');

    const snapshot = snapshotWslCodexState({ uncCodexHome: source, targetDirectory: target });
    assert.ok(snapshot);
    assert.ok(snapshot.files.includes('state_5.sqlite-wal'), 'the write-ahead log was not copied');
    assert.ok(snapshot.files.includes('state_5.sqlite-shm'));
    assert.ok(snapshot.files.includes('goals_1.sqlite'));
    assert.ok(snapshot.statePath.endsWith('state_5.sqlite'));
    assert.ok(snapshot.goalPath.endsWith('goals_1.sqlite'));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('picks the newest numbered state database', () => {
  // Codex rolls these forward, so a fixed name would read a stale file after an upgrade.
  const source = mkdtempSync(join(tmpdir(), 'wsl-state-src-'));
  const target = mkdtempSync(join(tmpdir(), 'wsl-state-dst-'));
  try {
    writeFileSync(join(source, 'state_4.sqlite'), 'old');
    writeFileSync(join(source, 'state_5.sqlite'), 'new');
    const snapshot = snapshotWslCodexState({ uncCodexHome: source, targetDirectory: target });
    assert.ok(snapshot?.statePath.endsWith('state_5.sqlite'), `picked ${snapshot?.statePath}`);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('falls back to the state database when there is no goal database', () => {
  const source = mkdtempSync(join(tmpdir(), 'wsl-state-src-'));
  const target = mkdtempSync(join(tmpdir(), 'wsl-state-dst-'));
  try {
    writeFileSync(join(source, 'state_5.sqlite'), 'main');
    const snapshot = snapshotWslCodexState({ uncCodexHome: source, targetDirectory: target });
    assert.ok(snapshot);
    assert.equal(snapshot.goalPath, snapshot.statePath);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('reports a home with no state database as absent, not as an error', () => {
  // A distribution can have Codex installed without ever having run it.
  const source = mkdtempSync(join(tmpdir(), 'wsl-state-src-'));
  try {
    writeFileSync(join(source, 'config.toml'), 'x');
    assert.equal(snapshotWslCodexState({ uncCodexHome: source }), null);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test('an unreadable home is absent rather than thrown', () => {
  assert.equal(snapshotWslCodexState({ uncCodexHome: join(tmpdir(), 'does-not-exist-at-all-xyz') }), null);
});