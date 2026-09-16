import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWatchdogRecord, resolveStateDirectory, waitForHealth, watchdogOrigin } from './service.js';

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

export interface ElectronShell {
  readonly app: {
    whenReady(): Promise<void>;
    on(event: 'window-all-closed', listener: () => void): void;
    quit(): void;
  };
  readonly BrowserWindow: new (options: {
    width: number;
    height: number;
    title: string;
    autoHideMenuBar: boolean;
    backgroundColor: string;
    webPreferences: { contextIsolation: boolean; nodeIntegration: boolean; sandbox: boolean };
  }) => {
    loadURL(url: string): Promise<void>;
    on(event: 'closed', listener: () => void): void;
  };
}

export async function launchDesktop(shell: ElectronShell, environment: NodeJS.ProcessEnv = process.env): Promise<ResolvedTarget> {
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

export async function main(): Promise<void> {
  const electron = (await import('electron' as string)) as unknown as ElectronShell;
  const target = await launchDesktop(electron);
  electron.app.on('window-all-closed', () => electron.app.quit());
  process.stdout.write(`desktop target: ${target.kind} ${target.url}\n`);
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

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
