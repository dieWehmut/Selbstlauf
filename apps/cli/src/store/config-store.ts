import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultConfig, parseConfig } from '../domain/config.js';
import type { WatchdogConfig } from '../domain/types.js';

export interface ConfigStoreOptions {
  readonly createIfMissing?: boolean;
}

/** Persists only validated watchdog configuration under its owned directory. */
export class ConfigStore {
  public readonly path: string;
  private readonly createIfMissing: boolean;
  private cached: WatchdogConfig | null = null;
  /**
   * Serializes saves.
   *
   * Two concurrent saves used to race in `replaceAtomically`'s Windows backup branch:
   * the first moved `config.json` aside, and the second then failed with ENOENT
   * because the destination it tried to move no longer existed. Saves come from
   * several places at once — the renderer's settings form, the tray, and the service's
   * own lifecycle routes — so this is reachable in normal use, and a lost save is a
   * setting the user watched change back.
   */
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(path: string, options: ConfigStoreOptions = {}) {
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new TypeError('config path must be a non-empty string');
    }
    this.path = path;
    this.createIfMissing = options.createIfMissing ?? true;
  }

  public async load(): Promise<WatchdogConfig> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      const config = parseConfig(raw);
      this.cached = config;
      return config;
    } catch (error) {
      if (this.cached !== null) return this.cached;
      if (!isMissingFile(error) || !this.createIfMissing) throw error;
      await this.save(defaultConfig);
      return defaultConfig;
    }
  }

  public async save(value: unknown): Promise<WatchdogConfig> {
    const config = parseConfig(value);
    // Validate before queueing, so a rejected value fails immediately and cannot
    // disturb the documents queued ahead of it.
    const run = this.queue.then(() => this.write(config));
    // Keep the chain alive even when this save rejects, or every later save would
    // inherit the rejection and fail for an unrelated reason.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(config: WatchdogConfig): Promise<WatchdogConfig> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await replaceAtomically(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    this.cached = config;
    return config;
  }

  public async update(mutator: (current: WatchdogConfig) => unknown): Promise<WatchdogConfig> {
    const current = await this.load();
    return this.save(mutator(current));
  }
}

async function replaceAtomically(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    // Windows rename refuses to replace an existing file. Keep the old file
    // recoverable until the new validated file has taken its place.
    if (!isAlreadyExists(error)) throw error;
  }

  const backup = `${destination}.${randomUUID()}.bak`;
  // Another writer may have already moved the destination aside, in which case there
  // is nothing to back up and the plain rename below is enough. This keeps a second
  // process (or a second ConfigStore on the same path) from failing the save.
  const staged = await rename(destination, backup).then(() => true).catch((error: unknown) => {
    if (isMissingFile(error)) return false;
    throw error;
  });
  try {
    await rename(source, destination);
  } catch (error) {
    if (staged) await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  if (staged) await rm(backup, { force: true });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      ['EEXIST', 'EPERM', 'ENOTEMPTY'].includes((error as { code?: string }).code ?? ''),
  );
}
