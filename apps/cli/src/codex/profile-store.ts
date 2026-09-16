import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  applyProfile,
  captureActiveProfile,
  readConfigSummary,
  type CodexProfile,
  type CodexProfileField,
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
  readonly changes: readonly { key: string; action: string; value: string }[];
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

  public apply(fields: readonly CodexProfileField[]): Promise<ApplyProfileOutcome> {
    const task = this.queue.then(() => this.applyNow(fields));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async applyNow(fields: readonly CodexProfileField[]): Promise<ApplyProfileOutcome> {
    const text = await this.readExisting();
    if (text === null) {
      throw new Error(`refusing to write ${this.configPath}: config.toml does not exist`);
    }
    const result = applyProfile(text, fields);
    const backupPath = `${this.configPath}.${this.now()}.bak`;
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    await writeFile(`${backupPath}.meta`, `sha256 ${digest}
`, "utf8");
    await writeFile(backupPath, text, "utf8");
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      await writeFile(temporaryPath, result.text, "utf8");
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
