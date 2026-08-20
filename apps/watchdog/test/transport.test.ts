import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { ConsoleTransport } from '../src/transport/console-bridge.js';
import { PtyTransport } from '../src/transport/pty-transport.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(
  new URL('../../../../', import.meta.url),
);
const consoleBridgePath = join(
  repositoryRoot,
  'native',
  'windows',
  'ConsoleBridge.ps1',
);

type FakeBridgeMode = 'success' | 'attach-failed' | 'wrong-pid' | 'wrong-command';

interface FakeBridge {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  readRequests(): Promise<unknown[]>;
}

async function createFakeBridge(
  directory: string,
  mode: FakeBridgeMode = 'success',
): Promise<FakeBridge> {
  const scriptPath = join(directory, 'fake-console-bridge.mjs');
  const logPath = join(directory, 'requests.jsonl');

  await writeFile(
    scriptPath,
    String.raw`
import { appendFile } from 'node:fs/promises';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const lines = input.split(/\r?\n/u).filter(Boolean);
if (lines.length !== 1) {
  process.stderr.write('expected exactly one JSON request\n');
  process.exitCode = 2;
} else {
  const request = JSON.parse(lines[0]);
  await appendFile(process.env.FAKE_BRIDGE_LOG, JSON.stringify(request) + '\n');

  if (process.env.FAKE_BRIDGE_MODE === 'attach-failed') {
    process.stdout.write(JSON.stringify({
      ok: false,
      kind: 'cannot-inject',
      command: request.command,
      pid: request.pid,
      error: {
        code: 'attach-failed',
        message: 'AttachConsole failed',
        nativeErrorCode: 5,
      },
    }) + '\n');
  } else if (process.env.FAKE_BRIDGE_MODE === 'wrong-pid') {
    process.stdout.write(JSON.stringify({
      ok: true,
      kind: 'classic-console',
      command: request.command,
      pid: request.pid + 1,
      consoleProcessIds: [request.pid],
      fingerprint: 'screen-v1',
      recordsWritten: 1,
    }) + '\n');
  } else if (process.env.FAKE_BRIDGE_MODE === 'wrong-command') {
    process.stdout.write(JSON.stringify({
      ok: true,
      kind: 'classic-console',
      command: request.command === 'probe' ? 'snapshot' : 'probe',
      pid: request.pid,
      consoleProcessIds: [request.pid],
      fingerprint: 'screen-v1',
      recordsWritten: 1,
    }) + '\n');
  } else if (request.command === 'probe') {
    process.stdout.write(JSON.stringify({
      ok: true,
      kind: 'classic-console',
      command: 'probe',
      pid: request.pid,
      consoleProcessIds: [request.pid],
    }) + '\n');
  } else if (request.command === 'snapshot') {
    process.stdout.write(JSON.stringify({
      ok: true,
      kind: 'classic-console',
      command: 'snapshot',
      pid: request.pid,
      fingerprint: 'screen-v1',
    }) + '\n');
  } else if (request.command === 'write') {
    process.stdout.write(JSON.stringify({
      ok: true,
      kind: 'classic-console',
      command: 'write',
      pid: request.pid,
      recordsWritten: [...request.text].length * 2 + 2,
    }) + '\n');
  } else {
    process.stderr.write('unknown bridge command\n');
    process.exitCode = 3;
  }
}
`,
    'utf8',
  );

  return {
    command: process.execPath,
    args: [scriptPath],
    env: {
      ...process.env,
      FAKE_BRIDGE_LOG: logPath,
      FAKE_BRIDGE_MODE: mode,
    },
    async readRequests() {
      try {
        const contents = await readFile(logPath, 'utf8');
        return contents
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

async function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'console-transport-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('bridge probe reports a classic console for the requested PID', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bridge = await createFakeBridge(directory);
    const transport = new ConsoleTransport({ bridge });

    const result = await transport.probe(4_321);

    assert.deepEqual(result, {
      ok: true,
      kind: 'classic-console',
      pid: 4_321,
      consoleProcessIds: [4_321],
    });
    assert.deepEqual(await bridge.readRequests(), [
      { command: 'probe', pid: 4_321 },
    ]);
  });
});

test('bridge snapshot returns a PID-bound activity fingerprint', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bridge = await createFakeBridge(directory);
    const transport = new ConsoleTransport({ bridge });

    const result = await transport.activityFingerprint(7_654);

    assert.deepEqual(result, {
      ok: true,
      kind: 'classic-console',
      pid: 7_654,
      fingerprint: 'screen-v1',
    });
    assert.deepEqual(await bridge.readRequests(), [
      { command: 'snapshot', pid: 7_654 },
    ]);
  });
});

test('bridge write submits one text sequence and lets the bridge append Enter', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bridge = await createFakeBridge(directory);
    const transport = new ConsoleTransport({ bridge });

    const result = await transport.write(8_008, '继续');

    assert.deepEqual(result, {
      ok: true,
      kind: 'classic-console',
      pid: 8_008,
      recordsWritten: 6,
    });
    assert.deepEqual(await bridge.readRequests(), [
      { command: 'write', pid: 8_008, text: '继续' },
    ]);
  });
});

test('failed attach returns cannot-inject and is not retried', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bridge = await createFakeBridge(directory, 'attach-failed');
    const transport = new ConsoleTransport({ bridge });

    const result = await transport.write(9_001, '继续');

    assert.deepEqual(result, {
      ok: false,
      kind: 'cannot-inject',
      pid: 9_001,
      error: {
        code: 'attach-failed',
        message: 'AttachConsole failed',
        nativeErrorCode: 5,
      },
    });
    assert.deepEqual(await bridge.readRequests(), [
      { command: 'write', pid: 9_001, text: '继续' },
    ]);
  });
});

test('invalid PIDs and multiline text fail closed before spawning the bridge', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bridge = await createFakeBridge(directory);
    const transport = new ConsoleTransport({ bridge });

    const invalidPid = await transport.probe(0);
    const multiline = await transport.write(4_321, 'first\nsecond');

    assert.equal(invalidPid.ok, false);
    assert.equal(invalidPid.kind, 'cannot-inject');
    assert.equal(invalidPid.error.code, 'invalid-pid');
    assert.equal(multiline.ok, false);
    assert.equal(multiline.kind, 'cannot-inject');
    assert.equal(multiline.error.code, 'invalid-text');
    assert.deepEqual(await bridge.readRequests(), []);
  });
});

test('bridge responses bound to another PID fail closed', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bridge = await createFakeBridge(directory, 'wrong-pid');
    const transport = new ConsoleTransport({ bridge });

    const result = await transport.probe(4_321);

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'cannot-inject');
    assert.equal(result.error.code, 'bridge-protocol');
    assert.deepEqual(await bridge.readRequests(), [
      { command: 'probe', pid: 4_321 },
    ]);
  });
});

test('bridge responses for another command fail closed', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bridge = await createFakeBridge(directory, 'wrong-command');
    const transport = new ConsoleTransport({ bridge });

    const result = await transport.activityFingerprint(4_321);

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'cannot-inject');
    assert.equal(result.error.code, 'bridge-protocol');
  });
});

test(
  'production ConsoleBridge accepts one UTF-8 JSON request and fails closed on attach',
  { skip: process.platform !== 'win32' },
  async () => {
    const transport = new ConsoleTransport({ timeoutMs: 15_000 });

    const result = await transport.probe(0xffff_fffe);

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'cannot-inject');
    assert.equal(result.error.code, 'attach-failed');
  },
);

test('service-owned PTY writes only to its validated PID', async () => {
  const writes: string[] = [];
  const input = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString('utf8'));
      callback();
    },
  });
  const output = new PassThrough();
  const transport = new PtyTransport({ pid: 6_060, input, output });

  assert.deepEqual(await transport.probe(6_060), {
    ok: true,
    kind: 'pty',
    pid: 6_060,
  });
  assert.equal((await transport.write(6_060, '继续')).ok, true);

  const wrongProcess = await transport.write(6_061, 'wrong process');
  assert.equal(wrongProcess.ok, false);
  assert.equal(wrongProcess.kind, 'cannot-inject');
  assert.equal(wrongProcess.error.code, 'pid-mismatch');
  assert.deepEqual(writes, ['继续\r']);
});

test('PTY transport rejects an invalid owner PID at construction', () => {
  const input = new PassThrough();
  const output = new PassThrough();

  assert.throws(
    () => new PtyTransport({ pid: 0, input, output }),
    /positive owner PID/u,
  );
});

test('PTY transport fails closed after its owned output closes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new PtyTransport({ pid: 6_062, input, output });

  output.end();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const result = await transport.write(6_062, 'after close');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'cannot-inject');
  assert.equal(result.error.code, 'transport-closed');
});

test('PTY transport fails closed after its owned input closes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new PtyTransport({ pid: 6_063, input, output });

  input.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const result = await transport.probe(6_063);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'cannot-inject');
  assert.equal(result.error.code, 'transport-closed');
});

test('service-owned PTY fingerprints output activity without exposing output', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new PtyTransport({ pid: 6_060, input, output });

  const before = await transport.activityFingerprint(6_060);
  output.write('response contents');
  const after = await transport.activityFingerprint(6_060);

  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.doesNotMatch(after.fingerprint, /response contents/u);
});

test('production transports do not contain a global keyboard fallback', async () => {
  const productionFiles = [
    consoleBridgePath,
    join(
      repositoryRoot,
      'apps',
      'watchdog',
      'src',
      'transport',
      'console-bridge.ts',
    ),
    join(
      repositoryRoot,
      'apps',
      'watchdog',
      'src',
      'transport',
      'pty-transport.ts',
    ),
  ];
  const contents = await Promise.all(
    productionFiles.map((path) => readFile(path, 'utf8')),
  );

  assert.doesNotMatch(
    contents.join('\n'),
    /(?:Send(?:Keys|Input)|keybd_event|mouse_event|PostMessage)/iu,
  );
});

test(
  'ConsoleBridge self-test validates its Unicode text and Enter records',
  { skip: process.platform !== 'win32' },
  async () => {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        consoleBridgePath,
        '-SelfTest',
      ],
      { windowsHide: true },
    );

    assert.equal(stderr, '');
    assert.equal(stdout.trim(), 'ConsoleBridge self-test passed');
  },
);
