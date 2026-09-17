import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export interface DesktopWindowOptions {
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
}

export const DEFAULT_WINDOW: Required<DesktopWindowOptions> = Object.freeze({
  width: 1440,
  height: 900,
  title: 'Selbstlauf Console',
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
  loadURL(url: string): Promise<void>;
  on(event: 'closed', listener: () => void): void;
}

export interface ElectronShell {
  readonly app: {
    whenReady(): Promise<void>;
    on(event: 'window-all-closed', listener: () => void): void;
    quit(): void;
    isPackaged?: boolean;
  };
  readonly BrowserWindow: new (options: {
    width: number;
    height: number;
    title: string;
    autoHideMenuBar: boolean;
    backgroundColor: string;
    webPreferences: { contextIsolation: boolean; nodeIntegration: boolean; sandbox: boolean };
  }) => ElectronWindow;
}

export async function launchDesktop(
  shell: ElectronShell,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTarget> {
  await shell.app.whenReady();
  const target = await resolveDesktopTarget(environment);
  const window = new shell.BrowserWindow({
    width: DEFAULT_WINDOW.width,
    height: DEFAULT_WINDOW.height,
    title: DEFAULT_WINDOW.title,
    autoHideMenuBar: true,
    backgroundColor: '#0b1120',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(target.url);
  window.on('closed', () => undefined);
  return target;
}

export interface DesktopHostOptions {
  readonly appRoot: string;
  readonly resourcesPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
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
  const window = new shell.BrowserWindow({
    width: DEFAULT_WINDOW.width,
    height: DEFAULT_WINDOW.height,
    title: DEFAULT_WINDOW.title,
    autoHideMenuBar: true,
    backgroundColor: '#0b1120',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(target.url);
  window.on('closed', () => undefined);
  return { target, host };
}

export async function main(): Promise<void> {
  const { app, BrowserWindow } = (await import('electron' as string)) as unknown as ElectronShell;
  // dist/src/main.js -> dist -> apps/desktop
  const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  let hosted: HostedDesktop;
  try {
    hosted = await hostAndLaunch({ app, BrowserWindow }, {
      appRoot,
      ...(app.isPackaged === true && typeof resourcesPath === 'string' ? { resourcesPath } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Packaged installs must stay usable when the service is already running or the
    // bundled artifacts are missing; the recorded service is the fallback target.
    const fallback = await resolveDesktopTarget().catch(() => null);
    if (fallback === null || fallback.kind !== 'service') throw error;
    process.stderr.write(`${message}\nfalling back to the recorded watchdog service\n`);
    const window = new BrowserWindow({
      width: DEFAULT_WINDOW.width,
      height: DEFAULT_WINDOW.height,
      title: DEFAULT_WINDOW.title,
      autoHideMenuBar: true,
      backgroundColor: '#0b1120',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
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
// module is imported, so compare against both forms before running the CLI entry.
if (isMainModule()) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export function isMainModule(argv: readonly string[] = process.argv, moduleUrl: string = import.meta.url): boolean {
  const entry = argv[1];
  if (entry === undefined || entry.length === 0) return false;
  const self = fileURLToPath(moduleUrl);
  const candidate = resolve(entry);
  if (candidate === self) return true;
  // "electron ." passes the app directory; the entry module lives in its dist tree.
  return resolve(candidate, 'dist', 'src', 'main.js') === self;
}
