import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_WSL_PROBE_TIMEOUT_MS,
  killWslProbeProcess,
  listWslDistributions,
  listWslProcesses,
  parseWslProcessLine,
  parseWslPsOutput,
  runWslProbe,
  registerWslProbeProcess,
} from '../src/process/wsl-processes.js';
import { listWslLaunchers } from '../src/process/wsl-launcher.js';
import { groupProcesses } from '../src/process/discovery.js';

function runLocalProbe(script: string, psBody: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${stderr.trim()} (exit ${code})`));
    });
    child.stdin.end(`ps() { ${psBody}; }\n${script}\n`);
  });
}

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

test('a hung injected WSL runner times out and receives cancellation', async () => {
  let receivedSignal: AbortSignal | undefined;
  const started = Date.now();
  const result = await listWslProcesses({
    distribution: 'Ubuntu-22.04',
    timeoutMs: 20,
    runWsl: async (_distribution, _script, signal) => {
      receivedSignal = signal;
      return await new Promise<string>(() => {});
    },
  });
  assert.deepEqual(result.records, []);
  assert.match(result.error ?? '', /Ubuntu-22\.04: WSL probe timed out after 20ms/u);
  assert.equal(receivedSignal?.aborted, true);
  assert.ok(Date.now() - started < 1_000, 'the Windows poll must not wait for the hung WSL runner');
  assert.equal(DEFAULT_WSL_PROBE_TIMEOUT_MS, 5_000);
});

test('the shared WSL probe keeps scripts intact and clears a successful deadline', async () => {
  let receivedSignal: AbortSignal | undefined;
  const output = await runWslProbe({
    distribution: ' Ubuntu-22.04 ',
    timeoutMs: 20,
    runWsl: async (distribution, script, signal) => {
      assert.equal(distribution, 'Ubuntu-22.04');
      assert.equal(script, 'printf "%s" "$HOME"');
      receivedSignal = signal;
      return '/home/test';
    },
  }, 'printf "%s" "$HOME"');
  assert.equal(output, '/home/test');
  await delay(30);
  assert.equal(receivedSignal?.aborted, false, 'a successful probe must not be cancelled later');
});

test('a late injected WSL rejection after timeout remains handled', async () => {
  await assert.rejects(runWslProbe({
    distribution: 'Ubuntu-22.04',
    timeoutMs: 10,
    runWsl: async () => {
      await delay(30);
      throw new Error('late runner failure');
    },
  }, 'pwd'), /timed out/u);
  await delay(40);
});

test('a failed WSL command still discovers the live processes readable through the filesystem', async () => {
  let filesystemReads = 0;
  const record = parseWslProcessLine('42\t1\tcodex\t/home/alice/bin/codex\t');
  assert.ok(record);
  const result = await listWslProcesses({
    distribution: 'Ubuntu',
    runWsl: async () => { throw new Error('WSL command channel unavailable'); },
    readFilesystem: async (distribution: string) => {
      assert.equal(distribution, 'Ubuntu');
      filesystemReads += 1;
      return { records: [record], homeDirectory: '/home/alice' };
    },
  });
  assert.deepEqual(result.records, [record]);
  assert.equal(filesystemReads, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.source, 'filesystem');
  assert.match(result.warning ?? '', /command channel unavailable/u);
});

test('filesystem recovery failure preserves both discovery errors', async () => {
  const result = await listWslProcesses({
    distribution: 'Ubuntu',
    runWsl: async () => { throw new Error('command failed'); },
    readFilesystem: async () => { throw new Error('UNC unavailable'); },
  });
  assert.deepEqual(result.records, []);
  assert.match(result.error ?? '', /command failed/u);
  assert.match(result.error ?? '', /UNC unavailable/u);
});

for (const output of ['', '   ', 'shell startup noise\nPID PPID COMMAND\n']) {
  test(`an empty or invalid process probe is unavailable: ${JSON.stringify(output)}`, async () => {
    const result = await listWslProcesses({ distribution: 'Ubuntu', runWsl: async () => output });
    assert.deepEqual(result.records, []);
    assert.match(result.error ?? '', /process.*(?:empty|valid|record|output)/iu);
  });
}

test('invalid process probe output falls back to the live filesystem', async () => {
  const record = parseWslProcessLine('7\t1\tinit\t/sbin/init\t/');
  assert.ok(record);
  const result = await listWslProcesses({
    distribution: 'Ubuntu',
    runWsl: async () => 'shell startup noise',
    readFilesystem: async () => ({ records: [record] }),
  });
  assert.deepEqual(result.records, [record]);
  assert.equal(result.source, 'filesystem');
  assert.equal(result.error, undefined);
  assert.match(result.warning ?? '', /process/iu);
});

test('a complete process table without supported agents produces a normal empty group list', async () => {
  const result = await listWslProcesses({
    distribution: 'Ubuntu',
    runWsl: async () => '7\t1\tinit\t/sbin/init\t/\n9\t7\tsh\tsh\t/\n',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.complete, undefined);
  assert.equal(result.records.length, 2);
  assert.deepEqual(groupProcesses(result.records, { distribution: 'Ubuntu', currentProcessId: 50, sameUserOnly: false }), []);
});

test('a complete empty filesystem fallback stays complete despite the command warning', async () => {
  const result = await listWslProcesses({
    distribution: 'Ubuntu',
    runWsl: async () => { throw new Error('command unavailable'); },
    readFilesystem: async () => ({ records: [] }),
  });
  assert.deepEqual(result.records, []);
  assert.equal(result.source, 'filesystem');
  assert.equal(result.error, undefined);
  assert.equal(result.complete, undefined);
  assert.match(result.warning ?? '', /command unavailable/u);
});

for (const preferFilesystem of [false, true]) {
  test(`partial filesystem records cannot establish process exits (filesystem first: ${preferFilesystem})`, async () => {
    const record = parseWslProcessLine('42\t1\tcodex\tcodex\t/work');
    assert.ok(record);
    let commandReads = 0;
    const result = await listWslProcesses({
      distribution: 'Ubuntu', preferFilesystem,
      runWsl: async () => { commandReads += 1; throw new Error('command unavailable'); },
      readFilesystem: async () => ({ records: [record], error: 'filesystem discovery timed out' }),
    });
    assert.deepEqual(result.records, [record]);
    assert.equal(result.error, undefined);
    assert.equal(result.source, 'filesystem');
    assert.equal(result.complete, false);
    assert.match(result.warning ?? '', /filesystem discovery timed out/u);
    assert.equal(commandReads, preferFilesystem ? 0 : 1);
  });
}

test('the process probe propagates ps failure instead of succeeding with an empty table', { skip: process.platform === 'win32' }, async () => {
  const result = await listWslProcesses({
    distribution: 'Ubuntu',
    runWsl: async (_distribution, script) => runLocalProbe(script, "printf '%s\\n' 'ps failed' >&2; return 23"),
  });
  assert.deepEqual(result.records, []);
  assert.match(result.error ?? '', /ps failed/u);
  assert.match(result.error ?? '', /exit 23/u);
});

test('the process probe preserves command arguments while reading the captured ps table', { skip: process.platform === 'win32' }, async () => {
  const result = await listWslProcesses({
    distribution: 'Ubuntu',
    runWsl: async (_distribution, script) => runLocalProbe(script,
      "printf '%s\\n' '2147483600 1 node node /work/codex \"two words\" --flag=literal\\value'"),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.pid, 2147483600);
  assert.equal(result.records[0]?.commandLine, 'node /work/codex "two words" --flag=literal\\value');
});

for (const discovery of ['WSL processes', 'WSL launchers', 'WSL distributions'] as const) {
  test(`${discovery} timeout kills a real probe that ignores SIGTERM`, {
    skip: process.platform === 'win32',
  }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'selbstlauf-wsl-timeout-'));
    const executable = path.join(directory, 'hanging-probe.cjs');
    const pidFile = path.join(directory, 'pid');
    let pid: number | undefined;
    try {
      await writeFile(executable, [
        '#!/usr/bin/env node',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'process.on("SIGTERM", () => {});',
        'process.stdin.resume();',
        'setInterval(() => {}, 1000);',
      ].join('\n'), { mode: 0o755 });
      if (discovery === 'WSL processes') {
        await assert.rejects(runWslProbe({
          distribution: 'Ubuntu-22.04', wslPath: executable, timeoutMs: 500,
        }, 'pwd'), /timed out after 500ms/u);
      } else if (discovery === 'WSL launchers') {
        assert.deepEqual(await listWslLaunchers({ powershellPath: executable, timeoutMs: 500 }), []);
      } else {
        const startedAt = Date.now();
        assert.deepEqual(await listWslDistributions(executable, { timeoutMs: 500 }), []);
        assert(Date.now() - startedAt < 2_000, 'a hung distribution command must meet its deadline');
      }
      pid = Number(await readFile(pidFile, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
        try { process.kill(pid, 0); } catch { alive = false; }
        if (alive) await delay(25);
      }
      assert.equal(alive, false, 'the default runner must not leave its child process behind');
    } finally {
      if (pid === undefined) {
        try { pid = Number(await readFile(pidFile, 'utf8')); } catch { /* The child did not start. */ }
      }
      if (pid !== undefined) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('Windows timeout cleanup kills the probe shim and its descendant only', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'selbstlauf-wsl-tree-timeout-'));
  const pidFile = path.join(directory, 'pids.json');
  const createdAfterMs = Date.now();
  const child = spawn(process.execPath, ['-e', [
    'const grandchild = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, grandchild.pid]));`,
    'setInterval(() => {}, 1000);',
  ].join('\n')], { stdio: 'pipe', windowsHide: true });
  registerWslProbeProcess(child, createdAfterMs, Date.now());
  let pids: number[] = [];
  try {
    for (let attempt = 0; attempt < 80 && pids.length === 0; attempt += 1) {
      try { pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[]; }
      catch { await delay(25); }
    }
    assert.equal(pids.length, 2, 'the test must start its own shim and descendant');
    const cleanup = killWslProbeProcess(child);
    assert.equal(killWslProbeProcess(child), cleanup, 'repeated cleanup must share the active tree kill');
    await cleanup;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let attempt = 0; attempt < 80 && pids.some(alive); attempt += 1) await delay(25);
    assert.deepEqual(pids.filter(alive), [], 'taskkill must not leave the shim descendant behind');
  } finally {
    await killWslProbeProcess(child);
    await delay(100);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows cleanup cannot verify a probe that exited before its tree was checked', {
  skip: process.platform !== 'win32',
}, async () => {
  const createdAfterMs = Date.now();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  registerWslProbeProcess(child, createdAfterMs, Date.now());
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  await assert.rejects(killWslProbeProcess(child), /exited before.*verified/iu);
});
