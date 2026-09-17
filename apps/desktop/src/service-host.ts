import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readWatchdogRecord,
  resolveStateDirectory,
  waitForHealth,
  watchdogOrigin,
  type WatchdogRecord,
} from './service.js';

/** The bundled watchdog service and the web UI it serves for this launch. */
export interface BundledDistribution {
  readonly serviceEntry: string;
  readonly staticDirectory: string;
}

export interface ResolveDistributionOptions {
  /** Directory that contains the compiled desktop app (the apps/desktop root). */
  readonly appRoot: string;
  /** Electron resources directory; present only in a packaged build. */
  readonly resourcesPath?: string;
}

export const SERVICE_ENTRY_SEGMENTS = Object.freeze(['service-dist', 'src', 'index.js']);
export const STATIC_DIRECTORY_NAME = 'web-dist';

function normalizeOptionalPath(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : resolve(trimmed);
}

export function resolveBundledDistribution(options: ResolveDistributionOptions): BundledDistribution {
  const packagedResources = normalizeOptionalPath(options.resourcesPath);
  if (packagedResources !== null) {
    return {
      serviceEntry: join(packagedResources, ...SERVICE_ENTRY_SEGMENTS),
      staticDirectory: join(packagedResources, STATIC_DIRECTORY_NAME),
    };
  }
  const appRoot = resolve(options.appRoot);
  const repositoryRoot = resolve(appRoot, '..', '..');
  return {
    serviceEntry: join(repositoryRoot, 'apps', 'cli', 'dist', 'src', 'index.js'),
    staticDirectory: join(repositoryRoot, 'apps', 'web', 'dist'),
  };
}

/** Fail early with a path that names the missing artifact instead of opening an empty window. */
export function assertBundledDistribution(distribution: BundledDistribution): void {
  if (!existsSync(distribution.serviceEntry)) {
    throw new Error(
      `bundled watchdog service not found: ${distribution.serviceEntry}\nRun "npm --workspace apps/cli run build" before starting the desktop app.`,
    );
  }
  if (!existsSync(distribution.staticDirectory)) {
    throw new Error(
      `bundled web UI not found: ${distribution.staticDirectory}\nRun "npm --workspace apps/web run build" before starting the desktop app.`,
    );
  }
}

export interface WatchdogServiceHandle {
  readonly server: { url(): string };
  stop(): Promise<void>;
}

export interface WatchdogServiceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly staticDirectory?: string;
}

export interface WatchdogServiceModule {
  startWatchdogProcess(options?: WatchdogServiceOptions): Promise<WatchdogServiceHandle>;
}

export interface BundledServiceHost {
  readonly origin: string;
  readonly pid: number;
  /** True when an already-running service was adopted instead of started. */
  readonly reused: boolean;
  stop(): Promise<void>;
}

export interface StartBundledServiceOptions extends ResolveDistributionOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly port?: number;
  readonly loadServiceModule?: (entry: string) => Promise<WatchdogServiceModule>;
  readonly probeHealth?: (origin: string) => Promise<boolean>;
}

const SERVICE_MODULE = 'startWatchdogProcess';

export async function loadWatchdogServiceModule(entry: string): Promise<WatchdogServiceModule> {
  const imported = (await import(pathToFileURL(entry).href)) as Partial<WatchdogServiceModule>;
  if (typeof imported[SERVICE_MODULE] !== 'function') {
    throw new Error(`bundled watchdog service does not export ${SERVICE_MODULE}: ${entry}`);
  }
  return imported as WatchdogServiceModule;
}

async function readExistingRecord(environment: NodeJS.ProcessEnv): Promise<WatchdogRecord | null> {
  try {
    return await readWatchdogRecord(resolveStateDirectory(environment));
  } catch {
    return null;
  }
}

/** Remove a record left behind by a crashed service so a fresh start can claim the PID file. */
async function clearStaleRecord(environment: NodeJS.ProcessEnv): Promise<void> {
  try {
    await rm(join(resolveStateDirectory(environment), 'watchdog.pid.json'), { force: true });
  } catch {
    // A missing LOCALAPPDATA means there is no record directory to clean up.
  }
}

export async function startBundledService(
  options: StartBundledServiceOptions,
): Promise<BundledServiceHost> {
  const environment = options.environment ?? process.env;
  const probeHealth = options.probeHealth ?? ((origin: string) => waitForHealth(origin));
  const distribution = resolveBundledDistribution(options);
  assertBundledDistribution(distribution);

  const existing = await readExistingRecord(environment);
  if (existing !== null) {
    const origin = watchdogOrigin(existing.port);
    if (await probeHealth(origin)) {
      return { origin, pid: existing.pid, reused: true, stop: async () => undefined };
    }
    await clearStaleRecord(environment);
  }

  const loadServiceModule = options.loadServiceModule ?? loadWatchdogServiceModule;
  const serviceModule = await loadServiceModule(distribution.serviceEntry);
  const handle = await serviceModule.startWatchdogProcess({
    host: '127.0.0.1',
    ...(options.port === undefined ? {} : { port: options.port }),
    staticDirectory: distribution.staticDirectory,
  });
  return {
    origin: handle.server.url(),
    pid: process.pid,
    reused: false,
    stop: () => handle.stop(),
  };
}

