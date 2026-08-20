import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('PowerShell lifecycle starts a loopback dry-run service and stops only its recorded PID', {
  skip: process.platform !== 'win32' ? 'Windows lifecycle only' : false,
  timeout: 20_000,
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'watchdog-lifecycle-'));
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const startScript = join(repositoryRoot, 'scripts', 'continuation', 'start-watchdog.ps1');
  const stopScript = join(repositoryRoot, 'scripts', 'continuation', 'stop-watchdog.ps1');
  const environment = { ...process.env, LOCALAPPDATA: stateRoot };
  let pid: number | undefined;

  try {
    const started = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript,
      '-Port', '0', '-DryRun', '-NoBuild',
    ], { cwd: repositoryRoot, env: environment });
    assert.match(started.stdout, /watchdog started/i);

    const recordPath = join(stateRoot, 'ai-cli-bypass', 'continuation', 'watchdog.pid.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { pid: number; port: string };
    pid = record.pid;
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
