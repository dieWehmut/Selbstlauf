import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_WINDOW,
  hostAndLaunch,
  isMainModule,
  launchDesktop,
  placeholderUrl,
  resolveDesktopTarget,
  type ElectronShell,
} from '../src/main.js';

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

test('detects the CLI entry for both "electron ." and direct script launches', () => {
  const moduleUrl = pathToFileURL(resolve('apps', 'desktop', 'dist', 'src', 'main.js')).href;
  const self = resolve('apps', 'desktop', 'dist', 'src', 'main.js');
  assert.equal(isMainModule([process.execPath, self], moduleUrl), true);
  assert.equal(isMainModule([process.execPath, resolve('apps', 'desktop')], moduleUrl), true, '"electron ." passes the app directory');
  assert.equal(isMainModule([process.execPath], moduleUrl), false);
  assert.equal(isMainModule([process.execPath, resolve('apps', 'desktop', 'dist', 'test', 'main.test.js')], moduleUrl), false);
});

test('opens the window on a freshly started bundled service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-hosted-'));
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');

  const loaded: string[] = [];
  const windows: Array<{ webPreferences?: Record<string, unknown> }> = [];
  const shell: ElectronShell = {
    app: {
      whenReady: async () => undefined,
      on: () => undefined,
      quit: () => undefined,
      isPackaged: false,
    },
    BrowserWindow: class {
      public constructor(options: { webPreferences?: Record<string, unknown> }) {
        windows.push(options);
      }
      public async loadURL(url: string): Promise<void> {
        loaded.push(url);
      }
      public on(): void {
        /* no-op */
      }
    } as unknown as ElectronShell['BrowserWindow'],
  };

  let stopped = 0;
  try {
    const hosted = await hostAndLaunch(shell, {
      appRoot: root,
      resourcesPath: root,
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      startService: async () => ({
        origin: 'http://127.0.0.1:48500',
        pid: 4242,
        reused: false,
        stop: async () => {
          stopped += 1;
        },
      }),
    });
    assert.equal(hosted.target.kind, 'service');
    assert.equal(hosted.target.url, 'http://127.0.0.1:48500');
    assert.equal(hosted.target.pid, 4242);
    assert.equal(loaded.at(0), 'http://127.0.0.1:48500');
    assert.deepEqual(windows[0]?.webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true });
    await hosted.host?.stop();
    assert.equal(stopped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to open a window when the bundled distribution is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-missing-'));
  const loaded: string[] = [];
  const shell: ElectronShell = {
    app: {
      whenReady: async () => undefined,
      on: () => undefined,
      quit: () => undefined,
      isPackaged: false,
    },
    BrowserWindow: class {
      public constructor() {
        /* no-op */
      }
      public async loadURL(url: string): Promise<void> {
        loaded.push(url);
      }
      public on(): void {
        /* no-op */
      }
    } as unknown as ElectronShell['BrowserWindow'],
  };
  try {
    await assert.rejects(
      hostAndLaunch(shell, { appRoot: root, resourcesPath: root }),
      /bundled watchdog service not found/u,
    );
    assert.deepEqual(loaded, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
