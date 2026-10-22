import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  applyProfile,
  captureActiveProfile,
  readConfigSummary,
  validateProfileEdits,
  type CodexProfile,
  type CodexProfileEdit,
} from "./config-profiles.js";

export interface CodexConfigProfilesOptions {
  readonly configPath: string;
  readonly now?: () => number;
}

export interface CodexProfilesView {
  readonly path: string;
  readonly exists: boolean;
  readonly active: Readonly<Record<string, string>>;
  readonly alternatives: Readonly<Record<string, readonly string[]>>;
  readonly current: CodexProfile | null;
}

export interface ApplyProfileOutcome {
  readonly text: string;
  readonly backupPath: string | null;
  readonly changes: readonly { key: string; action: string; value: string | null }[];
}

/** An expected refusal that the HTTP/UI may explain without exposing values. */
export class CodexProfileStoreError extends Error {
  public readonly status = 409;
  public readonly code = 'codex-config-missing';

  public constructor() {
    super('config.toml does not exist; restore or create the Codex configuration before applying endpoint changes');
    this.name = 'CodexProfileStoreError';
  }
}

/**
 * Owns the user config.toml for endpoint switching. Every write is serialized,
 * validated, and preceded by a checksummed backup so an interrupted switch can
 * be reverted by hand.
 */
export class CodexConfigProfiles {
  public readonly configPath: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: CodexConfigProfilesOptions) {
    if (typeof options.configPath !== "string" || options.configPath.trim().length === 0) {
      throw new TypeError("configPath must be a non-empty string");
    }
    this.configPath = options.configPath;
    this.now = options.now ?? Date.now;
  }

  public async describe(): Promise<CodexProfilesView> {
    const text = await this.readExisting();
    if (text === null) {
      return { path: this.configPath, exists: false, active: {}, alternatives: {}, current: null };
    }
    const summary = readConfigSummary(text);
    return {
      path: this.configPath,
      exists: true,
      active: summary.active,
      alternatives: summary.commented,
      current: captureActiveProfile(text),
    };
  }

  public apply(fields: readonly CodexProfileEdit[]): Promise<ApplyProfileOutcome> {
    // Snapshot validated edits before queueing; the caller may keep editing its
    // draft while another atomic write is pending.
    let edits: CodexProfileEdit[];
    try { edits = validateProfileEdits(fields); }
    catch (error) { return Promise.reject(error); }
    const task = this.queue.then(() => this.applyNow(edits));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async applyNow(fields: readonly CodexProfileEdit[]): Promise<ApplyProfileOutcome> {
    const text = await this.readExisting();
    if (text === null) {
      throw new CodexProfileStoreError();
    }
    const result = applyProfile(text, fields);
    if (result.text === text) return { text, backupPath: null, changes: result.changes };
    const backupPath = `${this.configPath}.${this.now()}.${randomUUID()}.bak`;
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    await writeFile(`${backupPath}.meta`, `sha256 ${digest}
`, { encoding: "utf8", mode: 0o600, flag: 'wx' });
    await writeFile(backupPath, text, { encoding: "utf8", mode: 0o600, flag: 'wx' });
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      const mode = (await stat(this.configPath)).mode & 0o777;
      await writeFile(temporaryPath, result.text, { encoding: "utf8", mode, flag: 'wx' });
      await replaceAtomically(temporaryPath, this.configPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return { text: result.text, backupPath, changes: result.changes };
  }

  private async readExisting(): Promise<string | null> {
    try {
      return await readFile(this.configPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }
}

async function replaceAtomically(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const displaced = `${destination}.${randomUUID()}.previous`;
  await rename(destination, displaced);
  try {
    await rename(source, destination);
  } catch (error) {
    await rename(displaced, destination).catch(() => undefined);
    throw error;
  }
  await rm(displaced, { force: true });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  const code = Boolean(error && typeof error === "object" && "code" in error)
    ? (error as { code?: string }).code
    : undefined;
  return code === "EEXIST" || code === "EPERM" || code === "ENOTEMPTY";
}
