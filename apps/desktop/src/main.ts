import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyNavigationPolicy,
  createWindowOptions,
  type DesktopWindowOptions,
  type NavigationPolicyTarget,
} from './navigation.js';
import { buildApplicationMenu, RENDERER_COMMANDS, type RendererCommand } from './menu.js';
import {
  SHELL_CHANNELS,
  applyShellAction,
  parseShellRequest,
} from './shell-actions.js';
import {
  readDesktopSettings,
  updateDesktopSettings,
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
} from './desktop-settings.js';
import { readStartupState, setStartupInstalled } from './startup-client.js';
import { installTray, showWindow, type TrayController, type TrayLike } from './tray.js';
import { createLifecycle } from './lifecycle.js';
import {
  readWatchdogRecord,
  resolveStateDirectory,
  waitForHealth,
  watchdogOrigin,
} from './service.js';
import {
  assertBundledDistribution,
  resolveBundledDistribution,
  startBundledService,
  type BundledServiceHost,
  type StartBundledServiceOptions,
} from './service-host.js';

export type { DesktopWindowOptions } from './navigation.js';

export const DEFAULT_WINDOW = Object.freeze({
  title: 'Selbstlauf Console',
  width: 1440,
  height: 900,
});

export interface ResolvedTarget {
  readonly kind: 'service' | 'placeholder';
  readonly url: string;
  readonly pid: number | null;
}

export async function resolveDesktopTarget(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTarget> {
  const stateDirectory = resolveStateDirectory(environment);
  const record = await readWatchdogRecord(stateDirectory);
  if (record === null) {
    return { kind: 'placeholder', url: placeholderUrl(), pid: null };
  }
  const origin = watchdogOrigin(record.port);
  if (!(await waitForHealth(origin))) {
    return { kind: 'placeholder', url: placeholderUrl(), pid: null };
  }
  return { kind: 'service', url: origin, pid: record.pid };
}

export function placeholderUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(PLACEHOLDER_HTML)}`;
}

export interface ElectronWindow {
  readonly webContents: NavigationPolicyTarget;
  loadURL(url: string): Promise<void>;
  on(event: 'closed', listener: () => void): void;
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void;
  once(event: 'ready-to-show', listener: () => void): void;
  show(): void;
  /** Present once the window can be hidden to the tray. */
  hide?(): void;
  focus?(): void;
  isMinimized?(): boolean;
  restore?(): void;
  isDestroyed?(): boolean;
  /** Used by the renderer's full-screen menu item. */
  toggleFullScreen?(): void;
  reload?(): void;
  /** Deliver a named command to the renderer (menu bar, tray). */
  send?(channel: string, ...args: unknown[]): void;
}

/**
 * The Electron pieces the desktop shell uses.
 *
 * Everything past `shell` is optional so existing test doubles that only model
 * `app`/`BrowserWindow`/`shell` keep type-checking, and so a missing member
 * degrades to "feature off" instead of a startup crash.
 */
export interface ElectronShell {
  readonly app: {
    whenReady(): Promise<void>;
    on(event: 'window-all-closed', listener: () => void): void;
    on(event: 'second-instance', listener: () => void): void;
    quit(): void;
    isPackaged?: boolean;
    requestSingleInstanceLock?(): boolean;
  };
  readonly BrowserWindow: new (options: DesktopWindowOptions) => ElectronWindow;
  readonly shell: { openExternal(url: string): Promise<void> };
  /** Optional so a stub without menus still satisfies the interface. */
  readonly Menu?: {
    setApplicationMenu(menu: unknown): void;
    buildFromTemplate(template: unknown[]): unknown;
  };
  readonly Tray?: new (icon: unknown) => TrayLike;
  readonly nativeImage?: { createFromPath(path: string): unknown };
  readonly ipcMain?: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    removeHandler?(channel: string): void;
  };
}

/** The window with the extra lifecycle members the shell drives. */
export interface ManagedWindow extends ElectronWindow {
  show(): void;
  hide(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  isDestroyed(): boolean;
}

export interface DesktopWindowRequest {
  readonly serviceOrigin: string;
  readonly preloadPath?: string;
  /** Branded window/taskbar icon; falls back to the Electron default when absent. */
  readonly iconPath?: string;
}

export interface WindowIconOptions {
  readonly appRoot: string;
}

/**
 * Locate the icon installed with the app.
 *
 * The asset ships beside the app (`apps/desktop/build` in a checkout,
 * `resources/build` in a packaged install) and is loaded by absolute path,
 * which is the only form Electron accepts without a registered protocol.
 * A build without the asset still opens its window; it just keeps the default.
 */
export function resolveWindowIconPath(options: WindowIconOptions): string | undefined {
  const candidate = resolve(options.appRoot, 'build', 'icon.ico');
  return existsSync(candidate) ? candidate : undefined;
}

/** Spreadable form so callers never build an `undefined` icon option. */
function windowIcon(appRoot: string): { readonly iconPath?: string } {
  const iconPath = resolveWindowIconPath({ appRoot });
  return iconPath === undefined ? {} : { iconPath };
}

function openWindow(shell: ElectronShell, request: DesktopWindowRequest): ManagedWindow {
  const window = new shell.BrowserWindow({
    ...createWindowOptions({ serviceOrigin: request.serviceOrigin }),
    ...(request.preloadPath === undefined ? {} : { preload: request.preloadPath }),
    ...(request.iconPath === undefined ? {} : { icon: request.iconPath }),
  } as DesktopWindowOptions) as ManagedWindow;
  applyNavigationPolicy({
    webContents: window.webContents,
    serviceOrigin: request.serviceOrigin,
    openExternal: (url) => {
      void shell.shell.openExternal(url);
    },
  });
  window.once('ready-to-show', () => window.show());
  return window;
}

export async function launchDesktop(
  shell: ElectronShell,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly appRoot?: string } = {},
): Promise<ResolvedTarget> {
  await shell.app.whenReady();
  const target = await resolveDesktopTarget(environment);
  const window = openWindow(shell, {
    serviceOrigin: target.url,
    ...(options.appRoot === undefined ? {} : windowIcon(options.appRoot)),
  });
  await window.loadURL(target.url);
  window.on('closed', () => undefined);
  return target;
}

export interface DesktopHostOptions {
  readonly appRoot: string;
  readonly resourcesPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly preloadPath?: string;
  /** Test seam: replace the bundled service launcher. */
  readonly startService?: (options: StartBundledServiceOptions) => Promise<BundledServiceHost>;
  /** Called with the window as soon as it exists, before it is loaded. */
  readonly attach?: (window: ManagedWindow) => void;
}

export interface HostedDesktop {
  readonly target: ResolvedTarget;
  readonly host: BundledServiceHost | null;
  /** The opened window; present for every path that actually opened one. */
  readonly window?: ManagedWindow;
}

/** Start the bundled service (when its artifacts exist) and open the window on it. */
export async function hostAndLaunch(
  shell: ElectronShell,
  options: DesktopHostOptions,
): Promise<HostedDesktop> {
  const environment = options.environment ?? process.env;
  const distribution = resolveBundledDistribution({
    appRoot: options.appRoot,
    resourcesPath: options.resourcesPath,
  });
  assertBundledDistribution(distribution);
  await shell.app.whenReady();
  const startService = options.startService ?? startBundledService;
  const host = await startService({ appRoot: options.appRoot, resourcesPath: options.resourcesPath, environment });
  const target: ResolvedTarget = { kind: 'service', url: host.origin, pid: host.pid };
  const window = openWindow(shell, {
    serviceOrigin: target.url,
    ...(options.preloadPath === undefined ? {} : { preloadPath: options.preloadPath }),
    ...windowIcon(options.appRoot),
  });
  options.attach?.(window);
  await window.loadURL(target.url);
  window.on('closed', () => undefined);
  return { target, host, window };
}

/**
 * Install the application menu.
 *
 * A no-op when the shell has no `Menu`, so a stub (or a platform without a menu
 * bar) simply skips it instead of failing to start.
 */
export function installApplicationMenu(
  shell: ElectronShell,
  actions: {
    readonly send: (command: RendererCommand, section?: string) => void;
    readonly hide: () => void;
    readonly openExternal: (url: string) => void;
  },
): unknown {
  if (shell.Menu === undefined) return null;
  const template = buildApplicationMenu({
    send: actions.send,
    hide: actions.hide,
    openExternal: actions.openExternal,
  });
  const menu = shell.Menu.buildFromTemplate(template as unknown[]);
  shell.Menu.setApplicationMenu(menu);
  return menu;
}

/** Register the five renderer-facing shell actions exactly once. */
export function registerShellHandlers(
  shell: ElectronShell,
  context: {
    readonly window: () => ManagedWindow | null;
    readonly quit: () => void;
    readonly openExternal: (url: string) => Promise<void> | void;
    readonly settings: () => Promise<DesktopSettings>;
    readonly saveSettings: (patch: unknown) => Promise<DesktopSettings>;
  },
): boolean {
  const ipcMain = shell.ipcMain;
  if (ipcMain === undefined) return false;
  ipcMain.handle(SHELL_CHANNELS.invoke, (_event, payload: unknown) => {
    const request = parseShellRequest(payload);
    const window = context.window();
    if (window === null) return null;
    applyShellAction(
      {
        window: {
          reload: () => window.reload?.(),
          toggleFullScreen: () => window.toggleFullScreen?.(),
          webContents: {
            ...(window.webContents as { setZoomLevel?: (level: number) => void; getZoomLevel?: () => number }),
          },
        },
        quit: context.quit,
        openExternal: context.openExternal,
      },
      request,
    );
    return null;
  });
  ipcMain.handle(SHELL_CHANNELS.settingsGet, () => context.settings());
  ipcMain.handle(SHELL_CHANNELS.settingsSet, (_event, patch: unknown) => context.saveSettings(patch));
  return true;
}

export async function main(): Promise<void> {
  const shell = (await import('electron' as string)) as unknown as ElectronShell;
  const { app } = shell;

  // A second launch must surface the window the first launch already owns rather
  // than starting a second watchdog service.
  if (app.requestSingleInstanceLock !== undefined && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // dist/src/main.js -> dist -> apps/desktop
  const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const preloadPath = resolvePreloadPath({
    appRoot,
    ...(app.isPackaged === true && typeof resourcesPath === 'string' ? { resourcesPath } : {}),
  });

  const stateDirectory = resolveStateDirectory();
  // Tracked in a mutable box so the close handler always reads the current value.
  let closeToTray = true;

  let tray: TrayController | null = null;
  let window: ManagedWindow | null = null;
  let serviceHost: BundledServiceHost | null = null;

  const lifecycle = createLifecycle({
    window: () => window,
    closeToTray: () => closeToTray,
    shutdown: {
      stopService: async () => {
        await serviceHost?.stop().catch(() => undefined);
      },
      destroyTray: () => {
        tray?.destroy();
        tray = null;
      },
      quit: () => app.quit(),
    },
    hasTray: () => tray !== null && tray.tray !== null,
  });

  // Preferences are read before the window opens so the first close already
  // honours them; a state directory that cannot be read keeps the defaults.
  const stored = await readDesktopSettings(stateDirectory).catch(() => DEFAULT_DESKTOP_SETTINGS);
  closeToTray = stored.closeToTray;

  const sendToRenderer = (command: RendererCommand, section?: string): void => {
    const target = window;
    if (target === null || target.isDestroyed?.() === true) return;
    target.send?.(SHELL_CHANNELS.command, { command, ...(section === undefined ? {} : { section }) });
  };

  let hosted: HostedDesktop;
  try {
    hosted = await hostAndLaunch(shell, {
      appRoot,
      preloadPath,
      ...(app.isPackaged === true && typeof resourcesPath === 'string' ? { resourcesPath } : {}),
      attach: (opened) => {
        window = opened;
        opened.on('close', (event) => lifecycle.handleWindowClose(event));
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Packaged installs must stay usable when the service is already running or the
    // bundled artifacts are missing; the recorded service is the fallback target.
    const fallback = await resolveDesktopTarget().catch(() => null);
    if (fallback === null || fallback.kind !== 'service') throw error;
    process.stderr.write(`${message}\nfalling back to the recorded watchdog service\n`);
    const opened = openWindow(shell, { serviceOrigin: fallback.url, preloadPath, ...windowIcon(appRoot) });
    opened.on('close', (event) => lifecycle.handleWindowClose(event));
    window = opened;
    await opened.loadURL(fallback.url);
    opened.on('closed', () => undefined);
    hosted = { target: fallback, host: null, window: opened };
  }
  serviceHost = hosted.host;

  const origin = hosted.target.url;
  const startupClient = { origin };

  registerShellHandlers(shell, {
    window: () => window,
    quit: () => void lifecycle.shutdown(),
    openExternal: (url) => shell.shell.openExternal(url),
    settings: () => readDesktopSettings(stateDirectory).catch(() => DEFAULT_DESKTOP_SETTINGS),
    saveSettings: async (patch) => {
      const saved = await updateDesktopSettings(stateDirectory, patch);
      closeToTray = saved.closeToTray;
      return saved;
    },
  });

  const revealWindow = () => showWindow(window);

  installApplicationMenu(shell, {
    send: sendToRenderer,
    // With the native menu bar hidden behind the custom title bar, the menu's
    // "hide" item is the same gesture as the window's own close button.
    hide: () => window?.hide(),
    openExternal: (url) => { void shell.shell.openExternal(url); },
  });

  tray = installTray({
    dependencies: {
      createIcon: (path) =>
        path === undefined || shell.nativeImage === undefined ? null : shell.nativeImage.createFromPath(path),
      createTray: (icon) => (shell.Tray === undefined ? null : new shell.Tray(icon)),
      buildMenu: (template) => {
        if (shell.Menu === undefined) return null;
        return shell.Menu.buildFromTemplate(template as unknown[]);
      },
    },
    actions: {
      window: () => window,
      send: sendToRenderer,
      readStartup: () => readStartupState(startupClient).then((state) => state.installed),
      toggleStartup: (installed) =>
        setStartupInstalled(startupClient, installed).then(async (state) => {
          // Windows renders a static context menu, so the checkbox is repainted
          // from the service's answer rather than from the click.
          await tray?.refreshStartupState();
          return state.installed;
        }),
      quit: () => void lifecycle.shutdown(),
    },
    ...(hosted.host === null ? {} : windowIcon(appRoot)),
  });

  // The startup task can be created or removed by the service at any time, so
  // the checkbox is refreshed once the tray exists rather than staying stale.
  void tray.refreshStartupState();

  app.on('second-instance', () => revealWindow());
  app.on('window-all-closed', () => {
    lifecycle.handleWindowAllClosed();
  });
  process.stdout.write(`desktop target: ${hosted.target.kind} ${hosted.target.url}\n`);
}


export interface PreloadPathOptions {
  readonly appRoot: string;
  readonly resourcesPath?: string;
}

/** The packaged build copies the preload next to the asar; the dev tree keeps it in src. */
export function resolvePreloadPath(options: PreloadPathOptions): string {
  if (options.resourcesPath !== undefined && options.resourcesPath.trim().length > 0) {
    return resolve(options.resourcesPath, 'preload.mjs');
  }
  return resolve(options.appRoot, 'src', 'preload.mjs');
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Selbstlauf Console</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1120; color: #e2e8f0; font: 15px/1.6 "Segoe UI", system-ui, sans-serif; }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      code { background: #1e293b; border-radius: 4px; padding: 0.15rem 0.4rem; font-size: 0.9em; }
    </style>
  </head>
  <body>
    <main>
      <h1>Selbstlauf Console</h1>
      <p>The local continuation watchdog is not running.</p>
      <p>Start it with <code>scripts/continuation/start-watchdog.ps1</code>, then reopen this window.</p>
    </main>
  </body>
</html>`;

// Electron sets process.argv[1] to the app directory (".") or the script path while the
// module is imported, and omits it entirely for a packaged launch.
if (isMainModule(process.argv, import.meta.url, { isPackaged: isPackagedProcess() })) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

/** Electron defines resourcesPath only in a packaged build. */
function isPackagedProcess(): boolean {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  return typeof resourcesPath === 'string' && resourcesPath.length > 0;
}

/**
 * True when this module is the process entry point.
 *
 * Electron passes the script path or the app directory in argv[1] for unpackaged
 * launches ("electron ." / "electron dist/src/main.js"), but a packaged app is
 * started from its executable with no script argument at all. A packaged process
 * therefore counts as the entry whenever resourcesPath is set, which Electron only
 * defines for packaged builds.
 */
export function isMainModule(
  argv: readonly string[] = process.argv,
  moduleUrl: string = import.meta.url,
  options: { readonly isPackaged?: boolean } = {},
): boolean {
  const entry = argv[1];
  const self = fileURLToPath(moduleUrl);
  if (entry !== undefined && entry.length > 0) {
    const candidate = resolve(entry);
    if (candidate === self) return true;
    // "electron ." passes the app directory; the entry module lives in its dist tree.
    if (resolve(candidate, 'dist', 'src', 'main.js') === self) return true;
  }
  if (options.isPackaged !== true) return false;
  // A packaged launch has no script argument, so the module path is the only
  // signal left: the packaged layout always places the main script at
  // dist/src/main.js (inside app.asar), and no other shipped module lives there.
  return self.replaceAll('\\', '/').endsWith('/dist/src/main.js');
}

