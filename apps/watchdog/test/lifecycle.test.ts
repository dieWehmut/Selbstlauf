import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const startScript = join(repositoryRoot, 'scripts', 'continuation', 'start-watchdog.ps1');
const stopScript = join(repositoryRoot, 'scripts', 'continuation', 'stop-watchdog.ps1');
const installScript = join(repositoryRoot, 'scripts', 'continuation', 'install-watchdog.ps1');
const uninstallScript = join(repositoryRoot, 'scripts', 'continuation', 'uninstall-watchdog.ps1');

test('PowerShell lifecycle starts a loopback dry-run service and stops only its recorded PID', {
  skip: process.platform !== 'win32' ? 'Windows lifecycle only' : false,
  timeout: 20_000,
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'watchdog-lifecycle-'));
  const environment = { ...process.env, LOCALAPPDATA: stateRoot };
  let pid: number | undefined;

  try {
    const started = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript,
      '-Port', '0', '-DryRun', '-NoBuild',
    ], { cwd: repositoryRoot, env: environment });
    assert.match(started.stdout, /watchdog started/i);

    const recordPath = join(stateRoot, 'ai-cli-bypass', 'continuation', 'watchdog.pid.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      pid: number;
      port: string;
      processStartedAtMs: number;
      executablePath: string;
      entryPath: string;
    };
    pid = record.pid;
    assert.equal(resolve(record.entryPath), join(repositoryRoot, 'apps', 'watchdog', 'dist', 'src', 'index.js'));
    assert.equal(resolve(record.executablePath), resolve(process.execPath));
    assert.ok(Number.isFinite(record.processStartedAtMs));
    const health = await fetch(`http://127.0.0.1:${record.port}/api/health`).then((response) => response.json()) as { ok: boolean; loopbackOnly: boolean };
    const config = await fetch(`http://127.0.0.1:${record.port}/api/config`).then((response) => response.json()) as { dryRun: boolean };
    assert.deepEqual({ ok: health.ok, loopbackOnly: health.loopbackOnly, dryRun: config.dryRun }, {
      ok: true,
      loopbackOnly: true,
      dryRun: true,
    });

    const stopped = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScript,
    ], { cwd: repositoryRoot, env: environment });
    assert.match(stopped.stdout, /watchdog stopped/i);
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid); } catch { /* already stopped */ }
    }
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('local API installs an ownership manifest and asynchronously removes only watchdog state', {
  skip: process.platform !== 'win32' ? 'Windows lifecycle only' : false,
  timeout: 25_000,
}, async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'watchdog-api-uninstall-'));
  const parentState = join(localAppData, 'ai-cli-bypass');
  const continuationState = join(parentState, 'continuation');
  const unrelatedState = join(parentState, 'bypass-state.json');
  const environment = { ...process.env, LOCALAPPDATA: localAppData };
  let pid: number | undefined;

  try {
    await mkdir(parentState, { recursive: true });
    await writeFile(unrelatedState, '{"ownedBy":"wrapper"}\n', 'utf8');
    await runPowerShell(startScript, ['-Port', '0', '-DryRun', '-NoBuild'], environment);
    const record = JSON.parse(await readFile(join(continuationState, 'watchdog.pid.json'), 'utf8')) as {
      pid: number;
      port: string;
    };
    pid = record.pid;
    const origin = `http://127.0.0.1:${record.port}`;

    const installed = await fetch(`${origin}/api/install`, {
      method: 'POST',
      headers: { origin },
    });
    assert.equal(installed.status, 200);
    const manifest = JSON.parse(await readFile(join(continuationState, 'install-manifest.json'), 'utf8')) as {
      schemaVersion: number;
      product: string;
      stateRoot: string;
      repositoryRoot: string;
      ownsStateRoot: boolean;
    };
    assert.deepEqual({
      schemaVersion: manifest.schemaVersion,
      product: manifest.product,
      stateRoot: resolve(manifest.stateRoot),
      repositoryRoot: resolve(manifest.repositoryRoot),
      ownsStateRoot: manifest.ownsStateRoot,
    }, {
      schemaVersion: 1,
      product: 'Selbstlauf Continuation Watchdog',
      stateRoot: resolve(continuationState),
      repositoryRoot,
      ownsStateRoot: true,
    });

    const uninstalled = await fetch(`${origin}/api/uninstall`, {
      method: 'POST',
      headers: { origin },
    });
    assert.equal(uninstalled.status, 200);
    try {
      await waitUntil(async () => !(await pathExists(continuationState)), 12_000);
    } catch (error) {
      const uninstallLog = await readFile(join(continuationState, 'watchdog-uninstall.log'), 'utf8').catch(() => 'log unavailable');
      const manifestText = await readFile(join(continuationState, 'install-manifest.json'), 'utf8').catch(() => 'manifest unavailable');
      const files = await import('node:fs/promises').then(async ({ readdir }) => readdir(continuationState).catch(() => [] as string[]));
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nfiles=${files.join(',')}\n${uninstallLog}\n${manifestText}`);
    }
    pid = undefined;
    assert.equal(await readFile(unrelatedState, 'utf8'), '{"ownedBy":"wrapper"}\n');
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid); } catch { /* already stopped */ }
    }
    await rm(localAppData, { recursive: true, force: true });
  }
});

test('startup installation owns and removes only its per-user scheduled task', {
  skip: process.platform !== 'win32' ? 'Windows lifecycle only' : false,
  timeout: 25_000,
}, async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'watchdog-startup-install-'));
  const continuationState = join(localAppData, 'ai-cli-bypass', 'continuation');
  const scheduler = join(localAppData, 'fake-schtasks.cmd');
  const schedulerLog = join(localAppData, 'schtasks.log');
  const schedulerState = join(localAppData, 'schtasks.state');
  const environment = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    WATCHDOG_SCHTASKS_PATH: scheduler,
    WATCHDOG_SCHTASKS_LOG: schedulerLog,
    WATCHDOG_SCHTASKS_STATE: schedulerState,
  };
  let pid: number | undefined;

  await writeFile(scheduler, [
    '@echo off',
    'echo %*>>"%WATCHDOG_SCHTASKS_LOG%"',
    'if /I "%1"=="/Query" if exist "%WATCHDOG_SCHTASKS_STATE%" exit /b 0',
    'if /I "%1"=="/Query" exit /b 1',
    'if /I "%1"=="/Create" type nul >"%WATCHDOG_SCHTASKS_STATE%"',
    'if /I "%1"=="/Create" exit /b 0',
    'if /I "%1"=="/Delete" del /q "%WATCHDOG_SCHTASKS_STATE%" 2>nul',
    'if /I "%1"=="/Delete" exit /b 0',
    'exit /b 2',
    '',
  ].join('\r\n'), 'utf8');

  try {
    const installed = await runPowerShell(installScript, ['-Port', '0', '-DryRun', '-NoBuild', '-Startup'], environment);
    assert.match(installed.stdout, /watchdog installed/i);
    const record = JSON.parse(await readFile(join(continuationState, 'watchdog.pid.json'), 'utf8')) as { pid: number };
    pid = record.pid;
    const manifest = JSON.parse(await readFile(join(continuationState, 'install-manifest.json'), 'utf8')) as {
      startupTask: { name: string; owned: boolean } | null;
    };
    assert.deepEqual(manifest.startupTask, { name: 'Selbstlauf Continuation Watchdog', owned: true });

    await runPowerShell(uninstallScript, [], environment);
    pid = undefined;
    const calls = await readFile(schedulerLog, 'utf8');
    assert.match(calls, /\/Create .*Selbstlauf Continuation Watchdog/i);
    assert.match(calls, /\/Delete .*Selbstlauf Continuation Watchdog/i);
    assert.equal(await pathExists(schedulerState), false);
    assert.equal(await pathExists(continuationState), false);
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid); } catch { /* already stopped */ }
    }
    await rm(localAppData, { recursive: true, force: true });
  }
});

function runPowerShell(script: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv) {
  return run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...arguments_,
  ], { cwd: repositoryRoot, env: environment });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}
