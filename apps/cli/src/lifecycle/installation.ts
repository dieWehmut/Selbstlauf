import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const INSTALL_MANIFEST_NAME = 'install-manifest.json';
export const WATCHDOG_PRODUCT_NAME = 'Selbstlauf Continuation Watchdog';
export const STARTUP_TASK_NAME = WATCHDOG_PRODUCT_NAME;
export const START_SCRIPT_ENVIRONMENT_VARIABLE = 'WATCHDOG_START_SCRIPT';
/**
 * Candidates for the logon-task script, relative to the compiled module
 * directory (apps/cli/dist/src/lifecycle in the repository,
 * resources/service-dist/src/lifecycle in a packaged install). Both layouts keep
 * a root above the script that also contains the launcher next to it, so the
 * script can locate its own dependencies.
 */
export const START_SCRIPT_CANDIDATES = Object.freeze([
  ['..', '..', '..', '..', '..', 'scripts', 'continuation', 'start-watchdog.ps1'],
  ['..', '..', '..', 'scripts', 'continuation', 'start-watchdog.ps1'],
]);
/**
 * Per-user logon-task helper shipped next to the start script. schtasks.exe
 * refuses "/SC ONLOGON" for a non-elevated account, so the helper registers the
 * same task through the ScheduledTasks cmdlets, which need no elevation.
 */
export const STARTUP_TASK_HELPER_NAME = 'startup-task.ps1';

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
  /**
   * Absolute path of the PowerShell script the logon task runs. When omitted,
   * the first candidate next to this module that exists is used, so a packaged
   * install never registers a developer-tree path.
   */
  readonly startScriptPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly uninstallDelayMs?: number;
  readonly startupPort?: number;
  readonly scheduler?: StartupTaskScheduler;
}

export interface StartupTaskStatus {
  readonly installed: boolean;
  readonly name?: string;
}

export interface StartupTaskScheduler {
  query(name: string): Promise<boolean>;
  create(name: string, action: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface StartupInstallOptions {
  readonly port?: number;
  readonly dryRun?: boolean;
}

const OWNED_PATHS = Object.freeze([
  'config.json',
  'audit.jsonl',
  'claude-leases.json',
  'claude-leases.json.lock',
  'claude-hook-manifest.json',
  'claude-settings.backup.json',
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
  private readonly startScriptPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly uninstallDelayMs: number;
  private readonly startupPort: number;
  private readonly scheduler: StartupTaskScheduler;

  public constructor(options: WatchdogInstallationOptions) {
    this.stateDirectory = assertOwnedStateDirectory(options.stateDirectory);
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.startScriptPath = resolveStartScriptPath(options.startScriptPath);
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.uninstallDelayMs = options.uninstallDelayMs ?? 1_000;
    if (!Number.isInteger(this.uninstallDelayMs) || this.uninstallDelayMs < 250 || this.uninstallDelayMs > 30_000) {
      throw new RangeError('uninstallDelayMs must be an integer between 250 and 30000');
    }
    this.startupPort = options.startupPort ?? 48_920;
    if (!Number.isInteger(this.startupPort) || this.startupPort < 0 || this.startupPort > 65_535) {
      throw new RangeError('startupPort must be an integer between 0 and 65535');
    }
    this.scheduler = options.scheduler ?? createSystemStartupTaskScheduler();
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

  public async startupStatus(): Promise<StartupTaskStatus> {
    if (this.platform !== 'win32') return { installed: false };
    const manifest = await readExistingManifest(join(this.stateDirectory, INSTALL_MANIFEST_NAME), this.stateDirectory);
    if (manifest?.startupTask === null || manifest === null) return { installed: false };
    if (manifest.startupTask.name !== STARTUP_TASK_NAME) {
      throw new Error(`refusing to inspect unexpected scheduled task '${manifest.startupTask.name}'`);
    }
    return {
      installed: await this.scheduler.query(STARTUP_TASK_NAME),
      name: STARTUP_TASK_NAME,
    };
  }

  public async installStartup(options: StartupInstallOptions = {}): Promise<WatchdogInstallManifest> {
    this.assertWindows();
    const port = options.port ?? this.startupPort;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new RangeError('startup task port must be an integer between 0 and 65535');
    }
    const manifest = await this.install();
    const ownsExistingTask = manifest.startupTask?.owned === true && manifest.startupTask.name === STARTUP_TASK_NAME;
    if (manifest.startupTask !== null && !ownsExistingTask) {
      throw new Error(`refusing to replace unexpected scheduled task '${manifest.startupTask.name}'`);
    }

    const taskExists = await this.scheduler.query(STARTUP_TASK_NAME);
    if (taskExists && !ownsExistingTask) {
      throw new Error(`refusing to replace unowned scheduled task '${STARTUP_TASK_NAME}'`);
    }

    await this.scheduler.create(STARTUP_TASK_NAME, this.startupAction(port, options.dryRun === true));
    const updated = withStartupTask(manifest, { name: STARTUP_TASK_NAME, owned: true }, this.now());
    try {
      await writeJsonAtomically(join(this.stateDirectory, INSTALL_MANIFEST_NAME), updated);
    } catch (error) {
      if (!ownsExistingTask) await this.scheduler.remove(STARTUP_TASK_NAME).catch(() => undefined);
      throw error;
    }
    return updated;
  }

  public async uninstallStartup(): Promise<WatchdogInstallManifest | null> {
    this.assertWindows();
    const manifestPath = join(this.stateDirectory, INSTALL_MANIFEST_NAME);
    const manifest = await readExistingManifest(manifestPath, this.stateDirectory);
    if (manifest === null || manifest.startupTask === null) return manifest;
    await this.removeOwnedStartupTask(manifest);
    const updated = withStartupTask(manifest, null, this.now());
    await writeJsonAtomically(manifestPath, updated);
    return updated;
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
    const manifest = await readExistingManifest(join(this.stateDirectory, INSTALL_MANIFEST_NAME), this.stateDirectory);
    if (manifest === null) throw new Error('watchdog install manifest is missing');
    await this.removeOwnedStartupTask(manifest);
    for (const relativePath of manifest.ownedPaths) {
      if (relativePath === INSTALL_MANIFEST_NAME) continue;
      const target = resolve(this.stateDirectory, relativePath);
      if (dirname(target) !== this.stateDirectory || !isSafeOwnedFileName(relativePath)) {
        throw new Error(`watchdog manifest contains an unsafe owned path: ${relativePath}`);
      }
      await rm(target, { force: true, recursive: false });
    }
    const remaining = await readdir(this.stateDirectory);
    const unknownFiles = remaining.filter((entry) => entry !== INSTALL_MANIFEST_NAME);
    if (unknownFiles.length > 0) {
      await writeFile(
        join(this.stateDirectory, 'watchdog-uninstall.log'),
        `preserved user files: ${unknownFiles.join(', ')}\n`,
        { encoding: 'utf8', flag: 'a' },
      );
      return;
    }
    await rm(join(this.stateDirectory, INSTALL_MANIFEST_NAME), { force: true, recursive: false });
    // The directory is known to be empty except for the owned manifest here;
    // Windows requires recursive removal for the final directory entry.
    await rm(this.stateDirectory, { force: true, recursive: true });
  }

  private assertWindows(): void {
    if (this.platform !== 'win32') throw new Error('watchdog startup tasks are supported only on Windows');
  }

  private async removeOwnedStartupTask(manifest: WatchdogInstallManifest): Promise<void> {
    if (manifest.startupTask === null) return;
    this.assertWindows();
    if (manifest.startupTask.name !== STARTUP_TASK_NAME) {
      throw new Error(`refusing to remove unexpected scheduled task '${manifest.startupTask.name}'`);
    }
    if (await this.scheduler.query(STARTUP_TASK_NAME)) await this.scheduler.remove(STARTUP_TASK_NAME);
  }

  private startupAction(port: number, dryRun: boolean): string {
    return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${this.startScriptPath}" -Port ${port} -NoBuild${dryRun ? ' -DryRun' : ''}`;
  }
}

/**
 * Locate the logon-task start script.
 *
 * The repository keeps it in scripts/continuation, and the packaged desktop app
 * ships the same folder under resources/scripts/continuation. Both are reachable
 * from the compiled module directory, so the search never depends on a working
 * directory or on the (dev-only) repository root recorded in the manifest.
 */
export function resolveStartScriptPath(
  configured: string | undefined = process.env[START_SCRIPT_ENVIRONMENT_VARIABLE],
  moduleUrl: string = import.meta.url,
): string {
  const trimmed = configured?.trim() ?? '';
  if (trimmed.length > 0) return resolve(trimmed);
  const moduleDirectory = resolve(fileURLToPath(moduleUrl), '..');
  const candidates = START_SCRIPT_CANDIDATES
    .map((segments) => resolve(moduleDirectory, ...segments))
    .filter((candidate) => existsSync(candidate));
  if (candidates.length > 0) return candidates[0] as string;
  // Nothing was found: report the repository-layout path so the failure names a
  // concrete location instead of an arbitrary one.
  return resolve(moduleDirectory, ...(START_SCRIPT_CANDIDATES[0] as string[]));
}

function withStartupTask(
  manifest: WatchdogInstallManifest,
  startupTask: StartupTaskOwnership | null,
  timestamp: number,
): WatchdogInstallManifest {
  return Object.freeze({ ...manifest, startupTask, updatedAtMs: timestamp });
}

function createSystemStartupTaskScheduler(): StartupTaskScheduler {
  const configuredTool = process.env.WATCHDOG_SCHTASKS_PATH?.trim() ?? '';
  // schtasks.exe denies "/SC ONLOGON" to a non-elevated account, so the default
  // scheduler drives the helper shipped next to the start script, which registers
  // the same per-user task through the ScheduledTasks cmdlets. A configured
  // WATCHDOG_SCHTASKS_PATH still replaces it for tests and overrides.
  const command = configuredTool.length > 0
    ? { file: configuredTool, prefix: [] as string[] }
    : {
        file: 'powershell.exe',
        prefix: [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', resolve(join(dirname(resolveStartScriptPath()), STARTUP_TASK_HELPER_NAME)),
        ],
      };
  return {
    query: async (name) => {
      try {
        await execFileAsync(command.file, [...command.prefix, '/Query', '/TN', name], { windowsHide: true, encoding: 'utf8' });
        return true;
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: number | string }).code
          : undefined;
        if (code === 1 || code === '1') return false;
        throw new Error(`scheduled task query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    create: async (name, action) => {
      await execFileAsync(
        command.file,
        [...command.prefix, '/Create', '/TN', name, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', action, '/F'],
        { windowsHide: true, encoding: 'utf8' },
      );
    },
    remove: async (name) => {
      await execFileAsync(command.file, [...command.prefix, '/Delete', '/TN', name, '/F'], { windowsHide: true, encoding: 'utf8' });
    },
  };
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
  const ownedPaths = parseOwnedPaths(value.ownedPaths);
  return {
    schemaVersion: 1,
    product: WATCHDOG_PRODUCT_NAME,
    stateRoot: expectedStateRoot,
    repositoryRoot: typeof value.repositoryRoot === 'string' ? resolve(value.repositoryRoot) : '',
    ownsStateRoot: true,
    ownedPaths,
    startupTask,
    installedAtMs: value.installedAtMs,
    updatedAtMs: typeof value.updatedAtMs === 'number' ? value.updatedAtMs : value.installedAtMs,
  };
}

function parseOwnedPaths(value: unknown): readonly string[] {
  if (value === undefined) return OWNED_PATHS;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('watchdog owned paths are invalid');
  }
  const paths = [...new Set(value as string[])];
  if (paths.some((entry) => !isSafeOwnedFileName(entry) || !OWNED_PATHS.includes(entry))) {
    throw new Error('watchdog owned paths contain an unexpected file');
  }
  return Object.freeze(paths);
}

function isSafeOwnedFileName(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' &&
    !value.includes('\\') && !value.includes('/') && !value.includes(':');
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
