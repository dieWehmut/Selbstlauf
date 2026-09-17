#!/usr/bin/env node
// Launch the desktop app headlessly, wait for its bundled service, and assert the
// console shell rendered. Exits non-zero when the app cannot serve its own UI.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertBundledDistribution, resolveBundledDistribution } from '../dist/src/service-host.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;

async function stopProcessTree(pid) {
  if (typeof pid !== 'number') return;
  // Electron leaves helper processes behind after the main process stops, so the
  // whole tree is terminated before the smoke script reports its result.
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('close', resolve);
    killer.on('error', () => resolve());
  });
}

async function waitForService(baseUrl) {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`the bundled service did not answer ${baseUrl}/api/health within ${PROBE_TIMEOUT_MS}ms`);
}

async function main() {
  const distribution = resolveBundledDistribution({ appRoot });
  assertBundledDistribution(distribution);
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'selbstlauf-smoke-'));
  const electronBinary = (await import('electron')).default;
  const child = spawn(electronBinary, ['.'], {
    cwd: appRoot,
    env: { ...process.env, LOCALAPPDATA: stateRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const port = Number(process.env.SELBSTLAUF_SMOKE_PORT ?? 48920);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForService(baseUrl);
    const index = await fetch(`${baseUrl}/`).then((response) => response.text());
    const assetPath = /src="([^"]+)"/u.exec(index)?.[1] ?? null;
    const asset = assetPath === null ? null : await fetch(`${baseUrl}${assetPath}`);
    const result = {
      service: health.watchdogRunning === true,
      servedIndex: index.includes('id="root"'),
      servedAsset: asset !== null && asset.ok,
      artifact: distribution.serviceEntry,
    };
    process.stdout.write(`desktop smoke: ${JSON.stringify(result)}\n`);
    process.exitCode = result.service && result.servedIndex && result.servedAsset ? 0 : 1;
  } catch (error) {
    process.stderr.write(`desktop smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(stdout.slice(-500) + stderr.slice(-500));
    process.exitCode = 1;
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await rm(stateRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`desktop smoke: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
