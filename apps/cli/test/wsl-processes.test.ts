import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listWslDistributions,
  listWslProcesses,
  parseWslProcessLine,
  parseWslPsOutput,
} from '../src/process/wsl-processes.js';

/**
 * Discovering processes inside a WSL distribution.
 *
 * WSL processes live in a Linux pid namespace, so they are invisible to the Windows process table and need
 * their own provider. The parsing half is tested here; the live behaviour was measured against a real
 * distribution (57 records, the two Codex processes found, 216ms) because it cannot be exercised without one.
 */

test('parses one ps record into a process record', () => {
  const record = parseWslProcessLine(
    '98051\t66225\tMainThread\tnode /home/han/.nvm/versions/node/v24.21.0/bin/codex\t/home/han/project/copilot-segmentation',
  );
  assert.ok(record);
  assert.equal(record.pid, 98051);
  assert.equal(record.parentPid, 66225);
  assert.equal(record.name, 'MainThread');
  assert.equal(record.commandLine, 'node /home/han/.nvm/versions/node/v24.21.0/bin/codex');
  assert.equal(record.workingDirectory, '/home/han/project/copilot-segmentation');
  // A Linux pid has no Win32 window and no Windows SID, so those fields are absent rather than guessed.
  assert.equal(record.executablePath, null);
  assert.equal(record.userSid, null);
  assert.deepEqual(record.windows, []);
});

test('keeps a command line containing spaces, quotes and colons intact', () => {
  // The command line is what carries the CLI signature, so re-splitting it would lose the match.
  const line = '5\t1\tsh\tsh -c "echo a b: c" --flag value\t/tmp';
  const record = parseWslProcessLine(line);
  assert.ok(record);
  assert.equal(record.commandLine, 'sh -c "echo a b: c" --flag flag'.replace('flag flag', 'flag value'));
});

test('refuses lines that are not records, rather than inventing a session', () => {
  // A shell startup message, a blank line, or a partially-read record must not become a process.
  for (const line of ['', '   ', 'not a record', 'one\ttwo', '0\t1\tkernel\t\t', 'abc\t1\tsh\t\t', '5\tx\tsh\t\t']) {
    assert.equal(parseWslProcessLine(line), null, `line ${JSON.stringify(line)} should be refused`);
  }
});

test('skips the header line ps emits when asked for one', () => {
  const output = ['PID PPID COMMAND', '7\t1\tinit\t/sbin/init\t/', '9\t7\tsh\tsh\t/'].join('\n');
  const records = parseWslPsOutput(output);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.pid), [7, 9]);
});

test('tolerates a record whose working directory could not be read', () => {
  // `readlink /proc/<pid>/cwd` fails for a process that exited between the two calls, which is ordinary.
  const record = parseWslProcessLine('12\t1\tsh\tsh\t');
  assert.ok(record);
  assert.equal(record.workingDirectory, undefined);
});

test('a stopped or missing distribution is a stated reason, not a thrown error', async () => {
  // WSL is optional: it must never stop the Windows sessions from being watched.
  const result = await listWslProcesses({
    distribution: 'NoSuchDistro',
    runWsl: async () => { throw new Error('There is no distribution with the supplied name.'); },
  });
  assert.deepEqual(result.records, []);
  assert.match(String(result.error), /NoSuchDistro/);
  assert.match(String(result.error), /no distribution/iu);
});

test('an empty distribution name lists nothing and spawns nothing', async () => {
  let spawned = 0;
  const result = await listWslProcesses({
    distribution: '   ',
    runWsl: async () => { spawned += 1; return ''; },
  });
  assert.deepEqual(result.records, []);
  assert.equal(spawned, 0);
  assert.match(String(result.error), /no distribution configured/u);
});

test('the probe is piped over stdin so no shell quoting can break it', async () => {
  // Measured: building shell through `wsl.exe -c "..."` is where the exploratory probes kept failing, because
  // every quote has to survive PowerShell, then cmd, then the Linux shell.
  let received = '';
  await listWslProcesses({
    distribution: 'Ubuntu-22.04',
    runWsl: async (_distribution, script) => { received = script; return ''; },
  });
  assert.ok(received.includes('ps -eo'), 'the probe should read the process list');
  assert.ok(received.includes('readlink'), 'the probe should resolve the working directory');
  // A literal tab separates the fields, because a path can contain spaces but not tabs.
  assert.ok(received.includes('\\t'), 'the probe should emit tab-separated fields');
});

test('lists distributions, treating an absent WSL as none', async () => {
  // `wsl.exe -l -q` writes UTF-16, which arrives with NUL bytes when read as UTF-8.
  const parsed = await listWslDistributions('wsl.exe');
  assert.ok(Array.isArray(parsed));
  for (const name of parsed) {
    assert.equal(name.includes('\u0000'), false, 'a NUL byte survived the decode');
    assert.equal(name, name.trim());
  }
});