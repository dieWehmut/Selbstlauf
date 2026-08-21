import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

export const CLAUDE_HOOK_OWNER = 'selbstlauf-continuation-v1';
export const CLAUDE_HOOK_MANIFEST_NAME = 'claude-hook-manifest.json';
export const CLAUDE_HOOK_BACKUP_NAME = 'claude-settings.backup.json';

const DEFAULT_COMMAND_TIMEOUT_MS = 1_500;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface ClaudeHookInstallationStatus {
  readonly installed: boolean;
  readonly restartRequired: boolean;
  readonly manualReviewRequired: boolean;
  readonly lastError?: string;
}

export interface ClaudeHookInstallationOptions {
  readonly settingsPath: string;
  readonly stateDirectory: string;
  readonly hookCommand: string;
  readonly commandTimeoutMs?: number | (() => number | Promise<number>);
  readonly now?: () => number;
}

interface ClaudeHookManifest {
  readonly schemaVersion: 1;
  readonly owner: typeof CLAUDE_HOOK_OWNER;
  readonly settingsPath: string;
  readonly hookCommand: string;
  readonly commandTimeoutMs: number;
  readonly settingsExisted: boolean;
  readonly backupFile: typeof CLAUDE_HOOK_BACKUP_NAME;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly installedAtMs: number;
  readonly updatedAtMs: number;
}

interface SettingsFile {
  readonly exists: boolean;
  readonly bytes: Buffer;
}

interface OwnedHookMatches {
  readonly exactCount: number;
  readonly markerCount: number;
}

type JsonRecord = Record<string, unknown>;

/** Owns one exact Claude Stop Hook while preserving the user's original settings bytes. */
export class ClaudeHookInstallation {
  private readonly settingsPath: string;
  private readonly stateDirectory: string;
  private readonly hookCommand: string;
  private readonly commandTimeoutMs: number | (() => number | Promise<number>);
  private readonly now: () => number;
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(options: ClaudeHookInstallationOptions) {
    this.settingsPath = assertClaudeSettingsPath(options.settingsPath);
    this.stateDirectory = assertOwnedStateDirectory(options.stateDirectory);
    this.hookCommand = assertOwnedHookCommand(options.hookCommand);
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  public status(): Promise<ClaudeHookInstallationStatus> {
    return this.enqueue(async () => {
      try {
        const manifest = await this.readManifest();
        if (manifest === null) return await this.statusWithoutManifest();
        return await this.inspectManifest(manifest);
      } catch (error) {
        return manualReview(safeMessage(error, 'Claude Hook status could not be verified safely.'));
      }
    });
  }

  public install(): Promise<ClaudeHookInstallationStatus> {
    return this.enqueue(async () => {
      try {
        const existingManifest = await this.readManifest();
        if (existingManifest !== null) return await this.resumeOrInspectInstall(existingManifest);

        if (await pathExists(this.backupPath())) {
          return manualReview('Claude Hook backup exists without a valid ownership manifest.');
        }

        const current = await readOptionalFile(this.settingsPath);
        const settings = parseSettings(current);
        if (findOwnedHooks(settings, this.hookCommand, DEFAULT_COMMAND_TIMEOUT_MS).markerCount > 0) {
          return manualReview('Claude Hook ownership marker already exists without a manifest.');
        }

        const commandTimeoutMs = await resolveCommandTimeout(this.commandTimeoutMs);
        const installedSettings = addOwnedStopHook(settings, this.hookCommand, commandTimeoutMs);
        const installedBytes = Buffer.from(`${JSON.stringify(installedSettings, null, 2)}\n`, 'utf8');
        const timestamp = this.now();
        const manifest: ClaudeHookManifest = Object.freeze({
          schemaVersion: 1,
          owner: CLAUDE_HOOK_OWNER,
          settingsPath: this.settingsPath,
          hookCommand: this.hookCommand,
          commandTimeoutMs,
          settingsExisted: current.exists,
          backupFile: CLAUDE_HOOK_BACKUP_NAME,
          beforeSha256: sha256(current.bytes),
          afterSha256: sha256(installedBytes),
          installedAtMs: timestamp,
          updatedAtMs: timestamp,
        });

        await mkdir(this.stateDirectory, { recursive: true });
        await writeNewPrivateFile(this.backupPath(), current.bytes);
        try {
          await writeJsonAtomically(this.manifestPath(), manifest);
        } catch (error) {
          await rm(this.backupPath(), { force: true }).catch(() => undefined);
          throw error;
        }
        try {
          await writeBytesAtomically(this.settingsPath, installedBytes, current);
        } catch (error) {
          if (error instanceof SettingsChangedError) {
            await this.removeOwnershipState();
            return manualReview('Claude settings changed during installation; no changes were made.');
          }
          throw error;
        }
        return installedStatus();
      } catch (error) {
        return manualReview(safeMessage(error, 'Claude Hook installation could not update settings safely.'));
      }
    });
  }

  public uninstall(): Promise<ClaudeHookInstallationStatus> {
    return this.enqueue(async () => {
      try {
        const manifest = await this.readManifest(false);
        if (manifest === null) return await this.statusWithoutManifest();

        const current = await readOptionalFile(this.settingsPath);
        const currentHash = sha256(current.bytes);
        const currentSettings = parseSettings(current);
        const matches = findOwnedHooks(currentSettings, manifest.hookCommand, manifest.commandTimeoutMs);

        // A prior uninstall may have restored the original bytes before state cleanup completed.
        if (currentHash === manifest.beforeSha256 && matches.markerCount === 0) {
          await this.removeOwnershipState();
          return notInstalledStatus();
        }

        if (currentHash !== manifest.afterSha256) {
          return {
            installed: matches.exactCount === 1,
            restartRequired: matches.exactCount === 1,
            manualReviewRequired: true,
            lastError: 'Claude settings changed after installation; the owned Hook was not removed.',
          };
        }
        if (matches.exactCount !== 1 || matches.markerCount !== 1) {
          return manualReview('Claude Hook ownership entry no longer matches its manifest.');
        }

        const backup = await readFile(this.backupPath());
        if (sha256(backup) !== manifest.beforeSha256) {
          return manualReview('Claude Hook backup checksum does not match its manifest.');
        }

        if (manifest.settingsExisted) {
          try {
            await writeBytesAtomically(this.settingsPath, backup, current);
          } catch (error) {
            if (error instanceof SettingsChangedError) {
              return manualReview('Claude settings changed during uninstall; the owned Hook was not removed.');
            }
            throw error;
          }
        } else {
          if (!await fileMatches(this.settingsPath, current)) {
            return manualReview('Claude settings changed during uninstall; the owned Hook was not removed.');
          }
          await rm(this.settingsPath, { force: true, recursive: false });
        }
        await this.removeOwnershipState();
        return notInstalledStatus();
      } catch (error) {
        return manualReview(safeMessage(error, 'Claude Hook uninstall could not restore settings safely.'));
      }
    });
  }

  private async resumeOrInspectInstall(manifest: ClaudeHookManifest): Promise<ClaudeHookInstallationStatus> {
    const current = await readOptionalFile(this.settingsPath);
    const currentHash = sha256(current.bytes);
    const settings = parseSettings(current);
    const matches = findOwnedHooks(settings, manifest.hookCommand, manifest.commandTimeoutMs);
    const backup = await readFile(this.backupPath());
    if (sha256(backup) !== manifest.beforeSha256) {
      return manualReview('Claude Hook backup checksum does not match its manifest.');
    }

    if (currentHash === manifest.afterSha256 && matches.exactCount === 1 && matches.markerCount === 1) {
      return installedStatus();
    }

    // Complete a safely interrupted install only while settings still equal the owned backup.
    if (currentHash === manifest.beforeSha256 && matches.markerCount === 0) {
      const installedSettings = addOwnedStopHook(settings, manifest.hookCommand, manifest.commandTimeoutMs);
      const installedBytes = Buffer.from(`${JSON.stringify(installedSettings, null, 2)}\n`, 'utf8');
      if (sha256(installedBytes) !== manifest.afterSha256) {
        return manualReview('Claude Hook interrupted installation could not be reconstructed safely.');
      }
      try {
        await writeBytesAtomically(this.settingsPath, installedBytes, current);
      } catch (error) {
        if (error instanceof SettingsChangedError) {
          return manualReview('Claude settings changed while resuming installation; no changes were made.');
        }
        throw error;
      }
      return installedStatus();
    }

    return {
      installed: matches.exactCount === 1,
      restartRequired: matches.exactCount === 1,
      manualReviewRequired: true,
      lastError: 'Claude settings changed after installation; automatic reinstall was refused.',
    };
  }

  private async inspectManifest(manifest: ClaudeHookManifest): Promise<ClaudeHookInstallationStatus> {
    const current = await readOptionalFile(this.settingsPath);
    const settings = parseSettings(current);
    const matches = findOwnedHooks(settings, manifest.hookCommand, manifest.commandTimeoutMs);
    const backup = await readFile(this.backupPath());
    const checksumMatches = sha256(current.bytes) === manifest.afterSha256 &&
      sha256(backup) === manifest.beforeSha256;
    if (checksumMatches && matches.exactCount === 1 && matches.markerCount === 1) {
      return installedStatus();
    }
    return {
      installed: matches.exactCount === 1,
      restartRequired: matches.exactCount === 1,
      manualReviewRequired: true,
      lastError: 'Claude Hook installation no longer matches its ownership manifest.',
    };
  }

  private async statusWithoutManifest(): Promise<ClaudeHookInstallationStatus> {
    if (await pathExists(this.backupPath())) {
      return manualReview('Claude Hook backup exists without a valid ownership manifest.');
    }
    const current = await readOptionalFile(this.settingsPath);
    if (!current.exists) return notInstalledStatus();
    if (current.bytes.includes(Buffer.from(CLAUDE_HOOK_OWNER, 'utf8'))) {
      return manualReview('Claude Hook ownership marker exists without a manifest.');
    }
    return notInstalledStatus();
  }

  private async readManifest(requireCurrentCommand = true): Promise<ClaudeHookManifest | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.manifestPath(), 'utf8')) as unknown;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return null;
      throw new SafeInstallationError('Claude Hook ownership manifest is invalid.');
    }
    const manifest = parseManifest(value, this.settingsPath);
    if (requireCurrentCommand && manifest.hookCommand !== this.hookCommand) {
      throw new SafeInstallationError('Claude Hook ownership manifest belongs to a different command.');
    }
    return manifest;
  }

  private async removeOwnershipState(): Promise<void> {
    await rm(this.manifestPath(), { force: true, recursive: false });
    await rm(this.backupPath(), { force: true, recursive: false });
  }

  private manifestPath(): string {
    return resolve(this.stateDirectory, CLAUDE_HOOK_MANIFEST_NAME);
  }

  private backupPath(): string {
    return resolve(this.stateDirectory, CLAUDE_HOOK_BACKUP_NAME);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseManifest(value: unknown, expectedSettingsPath: string): ClaudeHookManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.owner !== CLAUDE_HOOK_OWNER ||
      typeof value.settingsPath !== 'string' || resolve(value.settingsPath) !== expectedSettingsPath ||
      typeof value.hookCommand !== 'string' ||
      value.backupFile !== CLAUDE_HOOK_BACKUP_NAME ||
      typeof value.settingsExisted !== 'boolean' || typeof value.beforeSha256 !== 'string' ||
      typeof value.afterSha256 !== 'string' || !HASH_PATTERN.test(value.beforeSha256) ||
      !HASH_PATTERN.test(value.afterSha256) || !isPositiveInteger(value.commandTimeoutMs) ||
      typeof value.installedAtMs !== 'number' || !Number.isFinite(value.installedAtMs) ||
      typeof value.updatedAtMs !== 'number' || !Number.isFinite(value.updatedAtMs)) {
    throw new SafeInstallationError('Claude Hook ownership manifest is invalid.');
  }
  assertOwnedHookCommand(value.hookCommand);
  return Object.freeze({
    schemaVersion: 1,
    owner: CLAUDE_HOOK_OWNER,
    settingsPath: expectedSettingsPath,
    hookCommand: value.hookCommand,
    commandTimeoutMs: value.commandTimeoutMs,
    settingsExisted: value.settingsExisted,
    backupFile: CLAUDE_HOOK_BACKUP_NAME,
    beforeSha256: value.beforeSha256,
    afterSha256: value.afterSha256,
    installedAtMs: value.installedAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

function parseSettings(file: SettingsFile): JsonRecord {
  if (!file.exists) return {};
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    throw new SafeInstallationError('Claude settings JSON is invalid; no changes were made.');
  }
  if (!isRecord(parsed)) {
    throw new SafeInstallationError('Claude settings JSON must contain an object; no changes were made.');
  }
  validateHooksShape(parsed);
  return parsed;
}

function validateHooksShape(settings: JsonRecord): void {
  if (settings.hooks === undefined) return;
  if (!isRecord(settings.hooks)) {
    throw new SafeInstallationError('Claude settings hooks must contain an object; no changes were made.');
  }
  if (settings.hooks.Stop !== undefined && !Array.isArray(settings.hooks.Stop)) {
    throw new SafeInstallationError('Claude settings Stop hooks must contain an array; no changes were made.');
  }
}

function addOwnedStopHook(settings: JsonRecord, command: string, commandTimeoutMs: number): JsonRecord {
  const hooks = settings.hooks === undefined ? {} : settings.hooks as JsonRecord;
  const stop = hooks.Stop === undefined ? [] : hooks.Stop as unknown[];
  return {
    ...settings,
    hooks: {
      ...hooks,
      Stop: [
        ...stop,
        {
          hooks: [{ type: 'command', command, timeout: commandTimeoutMs / 1_000 }],
        },
      ],
    },
  };
}

function findOwnedHooks(settings: JsonRecord, expectedCommand: string, commandTimeoutMs: number): OwnedHookMatches {
  if (!isRecord(settings.hooks) || !Array.isArray(settings.hooks.Stop)) {
    return { exactCount: 0, markerCount: 0 };
  }
  let exactCount = 0;
  let markerCount = 0;
  for (const group of settings.hooks.Stop) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (!isRecord(hook) || hook.type !== 'command' || typeof hook.command !== 'string') continue;
      if (containsOwnerMarker(hook.command)) markerCount += 1;
    }
    if (isExactOwnedGroup(group, expectedCommand, commandTimeoutMs)) exactCount += 1;
  }
  return { exactCount, markerCount };
}

function isExactOwnedGroup(group: JsonRecord, expectedCommand: string, commandTimeoutMs: number): boolean {
  if (Object.keys(group).length !== 1 || !Array.isArray(group.hooks) || group.hooks.length !== 1) return false;
  const hook = group.hooks[0];
  return isRecord(hook) && Object.keys(hook).length === 3 && hook.type === 'command' &&
    hook.command === expectedCommand && hook.timeout === commandTimeoutMs / 1_000;
}

async function resolveCommandTimeout(value: number | (() => number | Promise<number>)): Promise<number> {
  const resolved = typeof value === 'function' ? await value() : value;
  if (!isPositiveInteger(resolved)) {
    throw new SafeInstallationError('Claude Hook command timeout must be a positive integer.');
  }
  return resolved;
}

function assertClaudeSettingsPath(path: string): string {
  const resolved = resolve(path);
  if (basename(resolved).toLocaleLowerCase() !== 'settings.json' ||
      basename(dirname(resolved)).toLocaleLowerCase() !== '.claude') {
    throw new Error('Claude settings path must end with .claude/settings.json');
  }
  return resolved;
}

function assertOwnedStateDirectory(path: string): string {
  const resolved = resolve(path);
  if (basename(resolved).toLocaleLowerCase() !== 'continuation' ||
      basename(dirname(resolved)).toLocaleLowerCase() !== 'ai-cli-bypass') {
    throw new Error('watchdog state directory must end with ai-cli-bypass/continuation');
  }
  return resolved;
}

function assertOwnedHookCommand(command: string): string {
  if (command.length === 0 || command.length > 8_192 || /[\0\r\n]/u.test(command) ||
      !command.endsWith(` --owner ${CLAUDE_HOOK_OWNER}`)) {
    throw new Error('Claude Hook command must end with the Selbstlauf ownership marker');
  }
  return command;
}

function containsOwnerMarker(command: string): boolean {
  return command === `--owner ${CLAUDE_HOOK_OWNER}` ||
    command.includes(` --owner ${CLAUDE_HOOK_OWNER}`);
}

async function readOptionalFile(path: string): Promise<SettingsFile> {
  try {
    return { exists: true, bytes: await readFile(path) };
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { exists: false, bytes: Buffer.alloc(0) };
    throw error;
  }
}

async function writeNewPrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeBytesAtomically(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

async function writeBytesAtomically(path: string, bytes: Uint8Array, expected?: SettingsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  try {
    if (expected !== undefined && !await fileMatches(path, expected)) throw new SettingsChangedError();
    await replaceAtomically(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function fileMatches(path: string, expected: SettingsFile): Promise<boolean> {
  const current = await readOptionalFile(path);
  return current.exists === expected.exists && sha256(current.bytes) === sha256(expected.bytes);
}

async function replaceAtomically(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!isReplaceConflict(error)) throw error;
  }
  const previousPath = `${destination}.${randomUUID()}.previous`;
  await rename(destination, previousPath);
  try {
    await rename(source, destination);
  } catch (error) {
    await rename(previousPath, destination).catch(() => undefined);
    throw error;
  }
  await rm(previousPath, { force: true });
}

function installedStatus(): ClaudeHookInstallationStatus {
  return { installed: true, restartRequired: true, manualReviewRequired: false };
}

function notInstalledStatus(): ClaudeHookInstallationStatus {
  return { installed: false, restartRequired: false, manualReviewRequired: false };
}

function manualReview(lastError: string): ClaudeHookInstallationStatus {
  return { installed: false, restartRequired: false, manualReviewRequired: true, lastError };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isReplaceConflict(error: unknown): boolean {
  return ['EEXIST', 'EPERM', 'ENOTEMPTY'].some((code) => isErrorCode(error, code));
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof SafeInstallationError ? error.message : fallback;
}

class SafeInstallationError extends Error {}
class SettingsChangedError extends Error {}
