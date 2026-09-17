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
  type ElectronWindow,
} from '../src/main.js';

interface StubWindow {
  readonly loaded: string[];
  readonly navigations: Array<{ url: string; prevented: number }>;
  readonly opened: string[];
}

interface ShellStub extends StubWindow {
  readonly shell: ElectronShell;
  readonly windows: Array<Record<string, unknown>>;
}

/** Minimal Electron stand-in that records what the app asks the window layer to do. */
function buildShell(options: { isPackaged?: boolean } = {}): ShellStub {
  const loaded: string[] = [];
  const navigations: Array<{ url: string; prevented: number }> = [];
  const opened: string[] = [];
  const windows: Array<Record<string, unknown>> = [];
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | null = null;

  const webContents = {
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
      openHandler = handler;
    },
    on: (event: string, listener: (detail: { preventDefault(): void }, url: string) => void) => {
      if (event === 'will-navigate') {
        navigations.push({ url: listener as unknown as string, prevented: 0 });
      }
    },
  };

  const shell = {
    app: {
      whenReady: async () => undefined,
      on: () => undefined,
      quit: () => undefined,
      isPackaged: options.isPackaged ?? false,
    },
    shell: {
      openExternal: async (url: string) => {
        opened.push(url);
      },
    },
    BrowserWindow: class {
      public readonly webContents = webContents;
      public constructor(windowOptions: Record<string, unknown>) {
        windows.push(windowOptions);
      }
      public async loadURL(url: string): Promise<void> {
        loaded.push(url);
      }
      public on(): void {
        /* no-op */
      }
      public once(): void {
        /* no-op */
      }
      public show(): void {
        /* no-op */
      }
    } as unknown as ElectronShell['BrowserWindow'],
  } as unknown as ElectronShell;

  return { shell, windows, loaded, navigations, opened };
}

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
  await new Promise<void>((resolve_) => server.listen(0, '127.0.0.1', resolve_));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(join(stateDirectory, 'watchdog.pid.json'), JSON.stringify({
    pid: 4321,
    port: String(address.port),
    entryPath: 'X',
  }), 'utf8');

  const stub = buildShell();
  try {
    const target = await launchDesktop(stub.shell, { LOCALAPPDATA: localAppData } as NodeJS.ProcessEnv);
    assert.equal(target.kind, 'service');
    assert.equal(target.pid, 4321);
    assert.equal(stub.loaded[0], `http://127.0.0.1:${address.port}`);
    assert.equal(stub.windows[0]?.width, DEFAULT_WINDOW.width);
    assert.equal(stub.windows[0]?.contextIsolation, true);
    assert.equal(stub.windows[0]?.nodeIntegration, false);
    assert.equal(stub.windows[0]?.sandbox, true);
    assert.equal(stub.windows[0]?.show, false);
  } finally {
    await new Promise<void>((resolve_) => server.close(() => resolve_()));
    await rm(localAppData, { recursive: true, force: true });
  }
});

test('detects the CLI entry for both "electron ." and direct script launches', () => {
  const moduleUrl = pathToFileURL(resolve('apps', 'desktop', 'dist', 'src', 'main.js')).href;
  const self = resolve('apps', 'desktop', 'dist', 'src', 'main.js');
  assert.equal(isMainModule([process.execPath, self], moduleUrl), true);
  assert.equal(isMainModule([process.execPath, resolve('apps', 'desktop')], moduleUrl), true, '"electron ." passes the app directory');
  assert.equal(isMainModule([process.execPath], moduleUrl), false);
  assert.equal(isMainModule([process.execPath, resolve('apps', 'desktop', 'dist', 'test', 'main.test.js')], moduleUrl), false);
});

test('treats a packaged launch as the entry point even without a script argument', () => {
  const moduleUrl = pathToFileURL(resolve('apps', 'desktop', 'dist', 'src', 'main.js')).href;
  // A packaged app starts from its executable, so Electron leaves argv[1] undefined.
  assert.equal(isMainModule([process.execPath], moduleUrl), false, "an unpackaged process without a script is not the entry");
  assert.equal(isMainModule([process.execPath], moduleUrl, { isPackaged: true }), true);
  assert.equal(
    isMainModule([process.execPath, '--some-switch'], moduleUrl, { isPackaged: true }),
    true,
    "flags do not displace the packaged entry",
  );
  const otherModule = pathToFileURL(resolve('apps', 'desktop', 'dist', 'src', 'navigation.js')).href;
  assert.equal(
    isMainModule([process.execPath], otherModule, { isPackaged: true }),
    false,
    "only the packaged main script claims the entry point",
  );
});

test('opens the window on a freshly started bundled service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-hosted-'));
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');

  const stub = buildShell();
  let stopped = 0;
  try {
    const hosted = await hostAndLaunch(stub.shell, {
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
    assert.equal(stub.loaded[0], 'http://127.0.0.1:48500');
    assert.equal(stub.windows[0]?.sandbox, true);
    await hosted.host?.stop();
    assert.equal(stopped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to open a window when the bundled distribution is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-missing-'));
  const stub = buildShell();
  try {
    await assert.rejects(
      hostAndLaunch(stub.shell, { appRoot: root, resourcesPath: root }),
      /bundled watchdog service not found/u,
    );
    assert.deepEqual(stub.loaded, []);
    assert.deepEqual(stub.windows, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
