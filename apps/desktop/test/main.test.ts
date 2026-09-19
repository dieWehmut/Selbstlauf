import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_WINDOW,
  createRendererSender,
  hostAndLaunch,
  installApplicationMenu,
  isMainModule,
  launchDesktop,
  placeholderUrl,
  registerShellHandlers,
  resolveDesktopTarget,
  resolveWindowIconPath,
  type ElectronShell,
  type ElectronWindow,
} from '../src/main.js';
import { PROJECT_HOMEPAGE, RENDERER_COMMANDS, type MenuItemTemplate } from '../src/menu.js';
import { SHELL_CHANNELS } from '../src/shell-actions.js';
import { createLifecycle } from '../src/lifecycle.js';

interface StubWindow {
  readonly loaded: string[];
  readonly navigations: Array<{ url: string; prevented: number }>;
  readonly opened: string[];
}

interface ShellStub extends StubWindow {
  readonly shell: ElectronShell;
  readonly windows: Array<Record<string, unknown>>;
  /** Commands delivered to the renderer over webContents. */
  readonly sent: Array<{ channel: string; payload: unknown }>;
  /** The most recently opened window, with its recorded listeners. */
  readonly windowHandle: {
    readonly closed: number;
    readonly close: Array<(event: { preventDefault(): void }) => void>;
    hidden: number;
    shown: number;
  };
}

/** Minimal Electron stand-in that records what the app asks the window layer to do. */
function buildShell(options: { isPackaged?: boolean } = {}): ShellStub {
  const loaded: string[] = [];
  const navigations: Array<{ url: string; prevented: number }> = [];
  const opened: string[] = [];
  const windows: Array<Record<string, unknown>> = [];
  const windowHandle = {
    closed: 0,
    close: [] as Array<(event: { preventDefault(): void }) => void>,
    hidden: 0,
    shown: 0,
  };
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | null = null;

  const webContents = {
    sent: [] as Array<{ channel: string; payload: unknown }>,
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
      openHandler = handler;
    },
    send: (channel: string, payload: unknown) => {
      webContents.sent.push({ channel, payload });
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
      public on(event: string, listener: () => void): void {
        if (event === 'close') windowHandle.close.push(listener as (event: { preventDefault(): void }) => void);
      }
      public once(): void {
        /* no-op */
      }
      public show(): void {
        windowHandle.shown += 1;
      }
      public hide(): void {
        windowHandle.hidden += 1;
      }
      public focus(): void {
        /* no-op */
      }
      public isMinimized(): boolean {
        return false;
      }
      public restore(): void {
        /* no-op */
      }
      public isDestroyed(): boolean {
        return false;
      }
      public send(): void {
        /* no-op */
      }
    } as unknown as ElectronShell['BrowserWindow'],
  } as unknown as ElectronShell;

  return { shell, windows, loaded, navigations, opened, windowHandle, sent: webContents.sent };
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
    // The hardening must be nested: Electron reads it only from webPreferences, so
    // a flattened spelling is silently ignored (see navigation.test.ts).
    const prefs = stub.windows[0]?.webPreferences as Record<string, unknown> | undefined;
    assert.equal(prefs?.contextIsolation, true);
    assert.equal(prefs?.nodeIntegration, false);
    assert.equal(prefs?.sandbox, true);
    assert.equal(stub.windows[0]?.show, false);
  } finally {
    await new Promise<void>((resolve_) => server.close(() => resolve_()));
    await rm(localAppData, { recursive: true, force: true });
  }
});

/**
 * Regression: `preload` must be nested under `webPreferences`.
 *
 * On the top level Electron ignores it, so the renderer gets no bridge at all:
 * `window.selbstlaufDesktop` is undefined and the window menus, the settings
 * store and the title-bar colour report all silently stop working, because every
 * bridge call is fire-and-forget. Verified live: a minimal preload exposing
 * `minimalProbe` also produced `undefined` while the option sat on the top level.
 */
test('passes the preload through webPreferences so the renderer gets its bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-preload-'));
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');

  const stub = buildShell();
  try {
    await hostAndLaunch(stub.shell, {
      appRoot: root,
      resourcesPath: root,
      preloadPath: join(root, 'preload.mjs'),
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      startService: async () => ({
        origin: 'http://127.0.0.1:48500',
        pid: 4242,
        reused: false,
        stop: async () => undefined,
      }),
    });
    const options = stub.windows[0] ?? {};
    const prefs = options.webPreferences as Record<string, unknown> | undefined;
    assert.equal(prefs?.preload, join(root, 'preload.mjs'), 'the preload must be nested');
    assert.equal('preload' in options, false, 'a top-level preload is silently ignored by Electron');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('omits the preload when none is configured, instead of passing undefined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-nopreload-'));
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');

  const stub = buildShell();
  try {
    await hostAndLaunch(stub.shell, {
      appRoot: root,
      resourcesPath: root,
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      startService: async () => ({
        origin: 'http://127.0.0.1:48500',
        pid: 4242,
        reused: false,
        stop: async () => undefined,
      }),
    });
    const prefs = (stub.windows[0] ?? {}).webPreferences as Record<string, unknown> | undefined;
    assert.equal('preload' in (prefs ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('brands the window with the shipped Selbstlauf icon', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-brand-'));
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await mkdir(join(root, 'build'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');
  await writeFile(join(root, 'build', 'icon.ico'), 'icon', 'utf8');

  const stub = buildShell();
  try {
    await hostAndLaunch(stub.shell, {
      appRoot: root,
      resourcesPath: root,
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      startService: async () => ({
        origin: 'http://127.0.0.1:48500',
        pid: 4242,
        reused: false,
        stop: async () => undefined,
      }),
    });
    assert.equal(stub.windows[0]?.icon, join(root, 'build', 'icon.ico'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Regression: the packaged install keeps the icon at `resources/build/icon.ico`,
 * but the packaging config did not copy it there. Resolution used to look only
 * beside the app (inside app.asar), so a packaged build found no icon and could
 * not construct a tray at all — which silently turned 关闭即隐藏 into a real quit
 * that also stopped the bundled service.
 */
test('finds the branded icon in the packaged resources layout', async () => {
  // `resourcesPath` is the install's resources directory: it holds service-dist,
  // web-dist and build/icon.ico. `appRoot` is the unpacked asar, which has no
  // build/ directory at all — that asymmetry is the whole point of the test.
  const resources = await mkdtemp(join(tmpdir(), 'desktop-packaged-res-'));
  const appRoot = await mkdtemp(join(tmpdir(), 'desktop-packaged-asar-'));
  try {
    await mkdir(join(resources, 'service-dist', 'src'), { recursive: true });
    await mkdir(join(resources, 'web-dist'), { recursive: true });
    await mkdir(join(resources, 'build'), { recursive: true });
    await writeFile(join(resources, 'service-dist', 'src', 'index.js'), '', 'utf8');
    await writeFile(join(resources, 'build', 'icon.ico'), 'icon', 'utf8');
    await writeFile(join(appRoot, 'package.json'), '{}', 'utf8');

    assert.equal(
      resolveWindowIconPath({ appRoot, resourcesPath: resources }),
      join(resources, 'build', 'icon.ico'),
      'the packaged resources path must be probed',
    );
    assert.equal(
      resolveWindowIconPath({ appRoot }),
      undefined,
      'beside the asar there is no icon, which is what the packaged layout used to rely on',
    );

    const stub = buildShell();
    await hostAndLaunch(stub.shell, {
      appRoot,
      resourcesPath: resources,
      environment: { LOCALAPPDATA: resources } as NodeJS.ProcessEnv,
      startService: async () => ({
        origin: 'http://127.0.0.1:48500',
        pid: 4242,
        reused: false,
        stop: async () => undefined,
      }),
    });
    assert.equal(stub.windows[0]?.icon, join(resources, 'build', 'icon.ico'));
  } finally {
    await rm(resources, { recursive: true, force: true });
    await rm(appRoot, { recursive: true, force: true });
  }
});

test('omits the window icon when no branded asset is installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-nobrand-'));
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');

  const stub = buildShell();
  try {
    await hostAndLaunch(stub.shell, {
      appRoot: root,
      resourcesPath: root,
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      startService: async () => ({
        origin: 'http://127.0.0.1:48500',
        pid: 4242,
        reused: false,
        stop: async () => undefined,
      }),
    });
    assert.equal('icon' in (stub.windows[0] ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    const prefs = stub.windows[0]?.webPreferences as Record<string, unknown> | undefined;
    assert.equal(prefs?.sandbox, true);
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

interface MenuStub {
  readonly shell: ElectronShell;
  readonly installed: unknown[];
  readonly templates: unknown[][];
  readonly opened: string[];
  readonly sent: Array<{ command: string; section?: string }>;
  readonly hidden: { count: number };
  /** Invoke a top-level item's click handler by its label. */
  click(top: string, child: string): void;
}

function buildMenuShell(): MenuStub {
  const installed: unknown[] = [];
  const templates: unknown[][] = [];
  const opened: string[] = [];
  const sent: Array<{ command: string; section?: string }> = [];
  const hidden = { count: 0 };
  const shell = {
    Menu: {
      setApplicationMenu: (menu: unknown) => installed.push(menu),
      buildFromTemplate: (template: unknown[]) => {
        templates.push(template);
        return { template };
      },
    },
  } as unknown as ElectronShell;
  return {
    shell,
    installed,
    templates,
    opened,
    sent,
    hidden,
    click(top: string, child: string) {
      const template = templates.at(-1) as MenuItemTemplate[];
      const item = template.find((entry) => entry.label === top);
      const found = item?.submenu?.find((entry) => entry.label === child);
      assert.ok(found, `${top} -> ${child} exists`);
      found.click?.();
    },
  };
}

test('installs the four-label application menu after the app is ready', () => {
  const stub = buildMenuShell();
  installApplicationMenu(stub.shell, {
    send: (command: string, section?: string) => {
      stub.sent.push(section === undefined ? { command } : { command, section });
    },
    hide: () => {
      stub.hidden.count += 1;
    },
    openExternal: (url) => stub.opened.push(url),
  });

  assert.equal(stub.installed.length, 1, 'the menu is handed to Electron once');
  const template = stub.templates[0] as MenuItemTemplate[];
  assert.deepEqual(template.map((item) => item.label), ['文件', '编辑', '视图', '帮助']);

  // 返回应用 goes through the injected renderer bridge.
  stub.click('文件', '返回应用');
  assert.deepEqual(stub.sent, [{ command: RENDERER_COMMANDS.backToApp }]);

  // 隐藏到托盘 hides; there is no quit item in the window's own menus.
  stub.click('文件', '隐藏到托盘');
  assert.equal(stub.hidden.count, 1);
  assert.equal(
    template.some((item) => (item.submenu ?? []).some((entry) => entry.role === 'quit')),
    false,
    'the tray owns the only quit affordance',
  );

  // 帮助 -> 项目主页 opens the GitHub homepage through the injected opener.
  stub.click('帮助', '项目主页');
  assert.deepEqual(stub.opened, [PROJECT_HOMEPAGE]);
  assert.equal(PROJECT_HOMEPAGE, 'https://github.com/dieWehmut/Selbstlauf');

  // The view items keep their Electron roles behind the custom title bar.
  const view = template.find((item) => item.label === '视图')?.submenu ?? [];
  assert.deepEqual(
    view.filter((item) => item.type !== 'separator').map((item) => item.role),
    ['reload', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'],
  );
});

test('menu installation is a no-op when the shell has no Menu', () => {
  const stub = buildShell();
  assert.equal(stub.shell.Menu, undefined);
  // A stub without menus (or a platform without a menu bar) must not throw.
  assert.equal(installApplicationMenu(stub.shell, {
    send: () => undefined,
    hide: () => undefined,
    openExternal: () => undefined,
  }), null);
});

interface IpcStub {
  readonly shell: ElectronShell;
  readonly handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  readonly channels: string[];
  invoke(channel: string, payload?: unknown): unknown;
}

function buildIpcShell(): IpcStub {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const channels: string[] = [];
  const shell = {
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        // A duplicate `handle` throws in Electron; recording the channel keeps
        // the "registered exactly once" check honest.
        channels.push(channel);
        handlers.set(channel, listener);
      },
    },
  } as unknown as ElectronShell;
  return {
    shell,
    handlers,
    channels,
    invoke: (channel: string, payload?: unknown) => handlers.get(channel)?.({}, payload),
  };
}

function buildShellActionContext(overrides: {
  readonly openExternal?: (url: string) => Promise<void> | void;
  readonly quit?: () => void;
  readonly window?: unknown;
} = {}) {
  const window = overrides.window ?? {
    reload: () => undefined,
    toggleFullScreen: () => undefined,
    webContents: { getZoomLevel: () => 0, setZoomLevel: () => undefined },
  };
  return {
    window: () => window as never,
    quit: overrides.quit ?? (() => undefined),
    openExternal: overrides.openExternal ?? (() => undefined),
    settings: async () => ({ closeToTray: true, preferredTerminal: null }),
    saveSettings: async (patch: unknown) => ({ closeToTray: true, preferredTerminal: null, patch }),
  };
}

test('registers the shell handlers exactly once', () => {
  const stub = buildIpcShell();
  const registered = registerShellHandlers(stub.shell, buildShellActionContext());
  assert.equal(registered, true);
  assert.equal(stub.channels.length, new Set(stub.channels).size, 'no channel is registered twice');
  assert.deepEqual(
    [...stub.channels].sort(),
    [SHELL_CHANNELS.invoke, SHELL_CHANNELS.settingsGet, SHELL_CHANNELS.settingsSet].sort(),
  );
});

test('registration is a no-op when ipcMain is missing', () => {
  const shell = {} as unknown as ElectronShell;
  assert.equal(registerShellHandlers(shell, buildShellActionContext()), false);
});

/**
 * The title bar is painted from the live palette, so the native window-button
 * strip must follow it; a fixed overlay colour left the row split into two
 * visibly different strips (measured on a real window as #0B1120 against a
 * #1A1E22 bar).
 *
 * The renderer reports its colour as soon as it paints, which can arrive while the
 * window is still being wired up, so this action must not be gated behind a live
 * window the way the other actions are.
 */
test('applies a renderer-supplied title bar colour even before a window exists', () => {
  const stub = buildIpcShell();
  const applied: Array<{ color: string; symbolColor?: string }> = [];
  registerShellHandlers(stub.shell, {
    ...buildShellActionContext(),
    window: () => null,
    setTitleBarOverlay: (colors) => applied.push(colors),
  });

  stub.invoke(SHELL_CHANNELS.invoke, { action: 'setTitleBarOverlay', color: '#1a1e22', symbolColor: '#e9eef0' });
  assert.deepEqual(applied, [{ color: '#1a1e22', symbolColor: '#e9eef0' }], 'the strip is repainted with no window');

  // A malformed colour is refused rather than repainting the strip with garbage.
  assert.throws(
    () => stub.invoke(SHELL_CHANNELS.invoke, { action: 'setTitleBarOverlay', color: 'red' }),
    /non-#rrggbb overlay colour/u,
  );
  assert.equal(applied.length, 1, 'nothing was repainted for the bad colour');
});

test('a window-dependent action still refuses to run without a window', () => {
  const stub = buildIpcShell();
  let reloads = 0;
  registerShellHandlers(stub.shell, {
    ...buildShellActionContext(),
    window: () => null,
  });
  const result = stub.invoke(SHELL_CHANNELS.invoke, { action: 'reload' });
  assert.equal(result, null, 'a missing window yields null rather than throwing');
  assert.equal(reloads, 0);
});

test('a menu command reaches the renderer through the window webContents', () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let destroyed = false;
  const window = {
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  };
  const send = createRendererSender(() => window as never);

  send('back-to-app');
  assert.deepEqual(sent, [{ channel: SHELL_CHANNELS.command, payload: { command: 'back-to-app' } }]);

  // A section travels alongside the command, for the tray's settings entries.
  send('open-settings', 'account');
  assert.deepEqual(sent.at(-1), {
    channel: SHELL_CHANNELS.command,
    payload: { command: 'open-settings', section: 'account' },
  });

  // A destroyed or not-yet-created window is skipped rather than throwing.
  destroyed = true;
  send('back-to-app');
  assert.equal(sent.length, 2);
  assert.doesNotThrow(() => createRendererSender(() => null)('back-to-app'));
});

test('the shell channel performs the action and refuses a non-http(s) URL', async () => {
  const stub = buildIpcShell();
  const opened: string[] = [];
  let quits = 0;
  let reloads = 0;
  registerShellHandlers(stub.shell, buildShellActionContext({
    openExternal: (url) => {
      opened.push(url);
    },
    quit: () => {
      quits += 1;
    },
    window: {
      reload: () => {
        reloads += 1;
      },
      toggleFullScreen: () => undefined,
      webContents: { getZoomLevel: () => 0, setZoomLevel: () => undefined },
    },
  }));

  await stub.invoke(SHELL_CHANNELS.invoke, { action: 'reload' });
  assert.equal(reloads, 1);
  await stub.invoke(SHELL_CHANNELS.invoke, { action: 'quit' });
  assert.equal(quits, 1);
  await stub.invoke(SHELL_CHANNELS.invoke, { action: 'openExternal', url: 'https://example.com/doc' });
  assert.deepEqual(opened, ['https://example.com/doc']);

  // The main process refuses anything that is not absolute http(s), so a
  // compromised renderer cannot reach the OS with a file: or javascript: URL.
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ms-settings:']) {
    assert.throws(() => stub.invoke(SHELL_CHANNELS.invoke, { action: 'openExternal', url }), /non-http\(s\) URL/u);
  }
  assert.deepEqual(opened, ['https://example.com/doc']);
  assert.throws(() => stub.invoke(SHELL_CHANNELS.invoke, { action: 'eval-something' }), /unknown shell action/u);
});

test('the settings channels read and write the persisted store', async () => {
  const stub = buildIpcShell();
  const patches: unknown[] = [];
  registerShellHandlers(stub.shell, {
    ...buildShellActionContext(),
    saveSettings: async (patch: unknown) => {
      patches.push(patch);
      return { closeToTray: false, preferredTerminal: null };
    },
  });
  assert.deepEqual(await stub.invoke(SHELL_CHANNELS.settingsGet), { closeToTray: true, preferredTerminal: null });
  assert.deepEqual(await stub.invoke(SHELL_CHANNELS.settingsSet, { closeToTray: false }), {
    closeToTray: false,
    preferredTerminal: null,
  });
  assert.deepEqual(patches, [{ closeToTray: false }]);
});

test('the window close hook hides the real window instead of quitting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-close-'));
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');

  const stub = buildShell();
  let stopped = 0;
  let quit = 0;
  try {
    await hostAndLaunch(stub.shell, {
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
      // `hostAndLaunch` hands the window over before loading it, which is where
      // main installs the close-to-tray hook on the real object.
      attach: (window) => {
        const lifecycle = createLifecycle({
          window: () => window,
          closeToTray: () => true,
          hasTray: () => true,
          shutdown: {
            stopService: async () => {
              stopped += 1;
            },
            destroyTray: () => undefined,
            quit: () => {
              quit += 1;
            },
          },
        });
        window.on('close', (event) => lifecycle.handleWindowClose(event));
      },
    });

    assert.equal(stub.windowHandle.close.length, 1, 'the window carries one close hook');
    let prevented = 0;
    stub.windowHandle.close[0]!({ preventDefault: () => { prevented += 1; } });
    // The X button hides the window; the bundled watchdog keeps running.
    assert.equal(prevented, 1, 'the default close is cancelled');
    assert.equal(stub.windowHandle.hidden, 1);
    assert.equal(stopped, 0, 'hiding the window never stops the service');
    assert.equal(quit, 0, 'hiding the window never quits the app');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
