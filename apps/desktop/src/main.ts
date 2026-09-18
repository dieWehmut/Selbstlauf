import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyNavigationPolicy,
  createWindowOptions,
  type DesktopWindowOptions,
  type NavigationPolicyTarget,
} from './navigation.js';
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
  once(event: 'ready-to-show', listener: () => void): void;
  show(): void;
}

export interface ElectronShell {
  readonly app: {
    whenReady(): Promise<void>;
    on(event: 'window-all-closed', listener: () => void): void;
    quit(): void;
    isPackaged?: boolean;
  };
  readonly BrowserWindow: new (options: DesktopWindowOptions) => ElectronWindow;
  readonly shell: { openExternal(url: string): Promise<void> };
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

function openWindow(shell: ElectronShell, request: DesktopWindowRequest): ElectronWindow {
  const window = new shell.BrowserWindow({
    ...createWindowOptions({ serviceOrigin: request.serviceOrigin }),
    ...(request.preloadPath === undefined ? {} : { preload: request.preloadPath }),
    ...(request.iconPath === undefined ? {} : { icon: request.iconPath }),
  } as DesktopWindowOptions);
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
}

export interface HostedDesktop {
  readonly target: ResolvedTarget;
  readonly host: BundledServiceHost | null;
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
  await window.loadURL(target.url);
  window.on('closed', () => undefined);
  return { target, host };
}

export async function main(): Promise<void> {
  const shell = (await import('electron' as string)) as unknown as ElectronShell;
  const { app } = shell;
  // dist/src/main.js -> dist -> apps/desktop
  const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const preloadPath = resolvePreloadPath({
    appRoot,
    ...(app.isPackaged === true && typeof resourcesPath === 'string' ? { resourcesPath } : {}),
  });
  let hosted: HostedDesktop;
  try {
    hosted = await hostAndLaunch(shell, {
      appRoot,
      preloadPath,
      ...(app.isPackaged === true && typeof resourcesPath === 'string' ? { resourcesPath } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Packaged installs must stay usable when the service is already running or the
    // bundled artifacts are missing; the recorded service is the fallback target.
    const fallback = await resolveDesktopTarget().catch(() => null);
    if (fallback === null || fallback.kind !== 'service') throw error;
    process.stderr.write(`${message}\nfalling back to the recorded watchdog service\n`);
    const window = openWindow(shell, { serviceOrigin: fallback.url, preloadPath, ...windowIcon(appRoot) });
    await window.loadURL(fallback.url);
    window.on('closed', () => undefined);
    hosted = { target: fallback, host: null };
  }
  app.on('window-all-closed', () => {
    void (async () => {
      await hosted.host?.stop().catch(() => undefined);
      app.quit();
    })();
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

