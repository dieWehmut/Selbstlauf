import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const INSTALL_MANIFEST_NAME = 'install-manifest.json';
export const WATCHDOG_PRODUCT_NAME = 'Selbstlauf Continuation Watchdog';

export interface StartupTaskOwnership {
  readonly name: string;
  readonly owned: boolean;
}

export interface WatchdogInstallManifest {
  readonly schemaVersion: 1;
  readonly product: typeof WATCHDOG_PRODUCT_NAME;
  readonly stateRoot: string;
  readonly repositoryRoot: string;
  readonly ownsStateRoot: true;
  readonly ownedPaths: readonly string[];
  readonly startupTask: StartupTaskOwnership | null;
  readonly installedAtMs: number;
  readonly updatedAtMs: number;
}

export interface WatchdogInstallationOptions {
  readonly stateDirectory: string;
  readonly repositoryRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly uninstallDelayMs?: number;
}

const OWNED_PATHS = Object.freeze([
  'config.json',
  'audit.jsonl',
  'watchdog.pid.json',
  'watchdog.log',
  'watchdog-error.log',
  'watchdog-uninstall.log',
  INSTALL_MANIFEST_NAME,
]);

/** Records ownership and schedules destructive work outside the HTTP process. */
export class WatchdogInstallation {
  private readonly stateDirectory: string;
  private readonly repositoryRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly uninstallDelayMs: number;

  public constructor(options: WatchdogInstallationOptions) {
    this.stateDirectory = assertOwnedStateDirectory(options.stateDirectory);
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.uninstallDelayMs = options.uninstallDelayMs ?? 1_000;
    if (!Number.isInteger(this.uninstallDelayMs) || this.uninstallDelayMs < 250 || this.uninstallDelayMs > 30_000) {
      throw new RangeError('uninstallDelayMs must be an integer between 250 and 30000');
    }
  }

  public async install(): Promise<WatchdogInstallManifest> {
    await mkdir(this.stateDirectory, { recursive: true });
    const manifestPath = join(this.stateDirectory, INSTALL_MANIFEST_NAME);
    const existing = await readExistingManifest(manifestPath, this.stateDirectory);
    const timestamp = this.now();
    const manifest: WatchdogInstallManifest = Object.freeze({
      schemaVersion: 1,
      product: WATCHDOG_PRODUCT_NAME,
      stateRoot: this.stateDirectory,
      repositoryRoot: this.repositoryRoot,
      ownsStateRoot: true,
      ownedPaths: OWNED_PATHS,
      startupTask: existing?.startupTask ?? null,
      installedAtMs: existing?.installedAtMs ?? timestamp,
      updatedAtMs: timestamp,
    });
    await writeJsonAtomically(manifestPath, manifest);
    return manifest;
  }

  public scheduleUninstall(
    cleanup: () => Promise<void>,
    complete: () => void = () => undefined,
  ): void {
    if (this.platform !== 'win32') throw new Error('watchdog uninstall is supported only on Windows');
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await cleanup();
          await this.removeOwnedState();
          complete();
        } catch (error) {
          await writeFile(
            join(this.stateDirectory, 'watchdog-uninstall.log'),
            `uninstall error: ${error instanceof Error ? error.message : String(error)}\n`,
            { encoding: 'utf8', flag: 'a' },
          ).catch(() => undefined);
        }
      })();
    }, this.uninstallDelayMs);
    timer.unref?.();
  }

  public async removeOwnedState(): Promise<void> {
    if (this.platform !== 'win32') throw new Error('watchdog uninstall is supported only on Windows');
    await readExistingManifest(join(this.stateDirectory, INSTALL_MANIFEST_NAME), this.stateDirectory);
    await rm(this.stateDirectory, { recursive: true, force: true });
  }
}

function assertOwnedStateDirectory(path: string): string {
  const resolved = resolve(path);
  if (basename(resolved).toLocaleLowerCase() !== 'continuation' ||
      basename(dirname(resolved)).toLocaleLowerCase() !== 'ai-cli-bypass') {
    throw new Error('watchdog state directory must end with ai-cli-bypass/continuation');
  }
  return resolved;
}

async function readExistingManifest(
  path: string,
  expectedStateRoot: string,
): Promise<WatchdogInstallManifest | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== WATCHDOG_PRODUCT_NAME ||
      value.ownsStateRoot !== true || typeof value.stateRoot !== 'string' ||
      resolve(value.stateRoot) !== expectedStateRoot || typeof value.installedAtMs !== 'number') {
    throw new Error('watchdog install manifest is invalid or does not own this state directory');
  }
  const startupTask = parseStartupTask(value.startupTask);
  return {
    schemaVersion: 1,
    product: WATCHDOG_PRODUCT_NAME,
    stateRoot: expectedStateRoot,
    repositoryRoot: typeof value.repositoryRoot === 'string' ? resolve(value.repositoryRoot) : '',
    ownsStateRoot: true,
    ownedPaths: OWNED_PATHS,
    startupTask,
    installedAtMs: value.installedAtMs,
    updatedAtMs: typeof value.updatedAtMs === 'number' ? value.updatedAtMs : value.installedAtMs,
  };
}

function parseStartupTask(value: unknown): StartupTaskOwnership | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim().length === 0 || value.owned !== true) {
    throw new Error('watchdog startup task ownership is invalid');
  }
  return Object.freeze({ name: value.name, owned: true });
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await replaceAtomically(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function replaceAtomically(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const backup = `${destination}.${randomUUID()}.bak`;
  await rename(destination, backup);
  try {
    await rename(source, destination);
  } catch (error) {
    await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await rm(backup, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isErrorCode(error, 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return ['EEXIST', 'EPERM', 'ENOTEMPTY'].some((code) => isErrorCode(error, code));
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}
