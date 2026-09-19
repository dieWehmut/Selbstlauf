import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

interface Invocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: childProcess.ExecFileOptions;
}

const invocations: Invocation[] = [];
const originalExecFile = childProcess.execFile;
const capturedExecFile = (() => {
  throw new Error('the npm runner must use its promised execFile boundary');
}) as unknown as typeof childProcess.execFile;
Object.defineProperty(capturedExecFile, promisify.custom, {
  value: async (file: string, args: readonly string[], options: childProcess.ExecFileOptions) => {
    invocations.push({ file, args, options });
    const stdout = args.includes('ls')
      ? JSON.stringify({ dependencies: { '@openai/codex': { version: '1.2.3' } } })
      : args.includes('view') ? '2.3.4\n' : 'added fixture package\n';
    return { stdout, stderr: '' };
  },
});
childProcess.execFile = capturedExecFile;
syncBuiltinESMExports();
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
});

// Capture the process boundary before loading the defaults. In particular, no
// regression in the upgrade runner can install a real global package in this test.
const { readInstalledVersions, readLatestVersions } = await import('../src/environment/probe.js');
const { ToolUpgrader } = await import('../src/environment/upgrade.js');

async function packagedRuntime(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'packaged npm '));
  const npmDirectory = join(directory, 'global npm');
  const nodeDirectory = join(directory, 'system node');
  const npmCli = join(npmDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const nodeExecutable = join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  await mkdir(join(npmDirectory, 'node_modules', 'npm', 'bin'), { recursive: true });
  await mkdir(join(nodeDirectory, 'node_modules', 'npm', 'bin'), { recursive: true });
  await writeFile(npmCli, '// selected npm');
  await writeFile(join(npmDirectory, process.platform === 'win32' ? 'npm.cmd' : 'npm'), 'fixture');
  await writeFile(join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// lower-priority npm');
  await writeFile(nodeExecutable, 'fixture');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const previousPath = process.env[pathKey];
  const previousExecPath = process.execPath;
  process.env[pathKey] = [npmDirectory, nodeDirectory].join(delimiter);
  process.execPath = join(directory, 'Selbstlauf.exe');
  invocations.length = 0;
  t.after(async () => {
    process.execPath = previousExecPath;
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  return { npmCli, nodeExecutable, npmDirectory, nodeDirectory, pathKey };
}

function assertSystemNpm(
  invocation: Invocation,
  runtime: { npmCli: string; nodeExecutable: string },
  args: readonly string[],
  timeout: number,
) {
  assert.equal(invocation.file, process.platform === 'win32' ? runtime.nodeExecutable : 'npm');
  assert.deepEqual(invocation.args, process.platform === 'win32' ? [runtime.npmCli, ...args] : args);
  assert.notEqual(invocation.options.shell, true, 'npm arguments are never passed through a shell');
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, timeout);
}

test('installed-version scan uses system npm when hosted by the packaged desktop', async (t) => {
  const runtime = await packagedRuntime(t);
  const installed = await readInstalledVersions({ fileExists: () => false });
  assert.equal(installed.find((entry) => entry.id === 'codex')?.installed, '1.2.3');
  assert.equal(invocations.length, 1);
  assertSystemNpm(invocations[0], runtime, ['ls', '-g', '--json'], 120_000);
});

test('registry-version scan uses system npm when hosted by the packaged desktop', async (t) => {
  const runtime = await packagedRuntime(t);
  const latest = await readLatestVersions();
  assert.equal(latest.get('@openai/codex'), '2.3.4');
  const invocation = invocations.find((entry) => entry.args.includes('@openai/codex'));
  assert.ok(invocation);
  assertSystemNpm(invocation, runtime, ['view', '@openai/codex', 'version'], 120_000);
});

test('tool upgrade uses system npm when hosted by the packaged desktop', async (t) => {
  const runtime = await packagedRuntime(t);
  const result = await new ToolUpgrader().upgrade('codex');
  assert.deepEqual(result, { id: 'codex', ok: true, output: 'added fixture package' });
  assert.equal(invocations.length, 1);
  assertSystemNpm(invocations[0], runtime, ['i', '-g', '@openai/codex@latest'], 600_000);
});

test('a missing Windows Node runtime is reported without launching the desktop executable', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const runtime = await packagedRuntime(t);
  process.env[runtime.pathKey] = runtime.npmDirectory;
  const result = await new ToolUpgrader().upgrade('codex');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Node\.js.*PATH/u);
  assert.equal(invocations.length, 0);
});

test('a missing Windows npm entry script is reported without guessing a desktop-relative path', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const runtime = await packagedRuntime(t);
  await rm(join(runtime.nodeDirectory, 'node_modules'), { recursive: true });
  process.env[runtime.pathKey] = runtime.nodeDirectory;
  const result = await new ToolUpgrader().upgrade('codex');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /npm.*PATH/u);
  assert.equal(invocations.length, 0);
});
