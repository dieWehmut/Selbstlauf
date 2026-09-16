import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_WINDOW, launchDesktop, placeholderUrl, resolveDesktopTarget, type ElectronShell } from '../src/main.js';

test('falls back to the placeholder page when no watchdog is recorded', async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'desktop-target-'));
  try {
    const target = await resolveDesktopTarget({ LOCALAPPDATA: localAppData } as NodeJS.ProcessEnv);
    assert.equal(target.kind, 'placeholder');
    assert.equal(target.pid, null);
    assert.equal(target.url, placeholderUrl());
    assert.match(decodeURIComponent(target.url), /watchdog is not running/u);
  } finally {
    await rm(localAppData, { recursive: true, force: true });
  }
});

test('opens a hardened window pointed at a healthy watchdog service', async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'desktop-launch-'));
  const stateDirectory = join(localAppData, 'ai-cli-bypass', 'continuation');
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(join(stateDirectory, 'watchdog.pid.json'), JSON.stringify({
    pid: 4321,
    port: String(address.port),
    entryPath: 'X',
  }), 'utf8');

  const capturedOptions: Array<{ width?: number; webPreferences?: Record<string, unknown> }> = [];
  let loadedUrl = '';
  const shell: ElectronShell = {
    app: {
      whenReady: async () => undefined,
      on: () => undefined,
      quit: () => undefined,
    },
    BrowserWindow: class {
      public constructor(options: Record<string, unknown>) {
        capturedOptions.push(options as { width?: number; webPreferences?: Record<string, unknown> });
      }
      public async loadURL(url: string): Promise<void> { loadedUrl = url; }
      public on(): void { /* no-op */ }
    } as unknown as ElectronShell['BrowserWindow'],
  };

  try {
    const target = await launchDesktop(shell, { LOCALAPPDATA: localAppData, PATH: '' } as NodeJS.ProcessEnv);
    assert.equal(target.kind, 'service');
    assert.equal(target.pid, 4321);
    assert.equal(loadedUrl, watchdogOriginOf(address.port));
    assert.equal(capturedOptions[0]?.width, DEFAULT_WINDOW.width);
    const webPreferences = capturedOptions[0]?.webPreferences;
    assert.deepEqual(webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(localAppData, { recursive: true, force: true });
  }
});

function watchdogOriginOf(port: number): string {
  return `http://127.0.0.1:${port}`;
}
