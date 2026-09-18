import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { AGENT_CATALOG, type AgentCatalogEntry } from './catalog.js';
import type { EnvironmentCheck, EnvironmentReport } from './environment-check.js';

/**
 * Install and upgrade the agent CLIs the panel reports on.
 *
 * This is the one place the watchdog mutates the machine outside its own state
 * directory, so the rules are deliberately narrow:
 *
 *  - Only catalog ids are accepted. The id is looked up in the catalog and the
 *    command is built from the catalog entry, so a caller can never hand an
 *    arbitrary package name or extra npm argument to the runner.
 *  - Installs run one at a time. Concurrent global npm installs fight over the
 *    same prefix and can leave a half-written tree behind.
 *  - The scan is refreshed afterwards so the panel shows what actually
 *    happened rather than what was requested.
 */

const execFileAsync = promisify(execFile);

export interface UpgradeResult {
  readonly id: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
}

export interface ToolUpgraderOptions {
  /** Runs the npm CLI with the given arguments; overridable for tests. */
  readonly runNpm?: (args: readonly string[]) => Promise<string>;
  /** The environment check whose scan is refreshed after an install. */
  readonly check?: EnvironmentCheck;
  /** Supplies the current report for upgradeAll; overridable for tests. */
  readonly report?: () => Promise<EnvironmentReport>;
}

/** True when the id names a catalog entry, ignoring anything else. */
export function isKnownToolId(id: string): boolean {
  return AGENT_CATALOG.some((entry) => entry.id === id);
}

function findEntry(id: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find((entry) => entry.id === id);
}

/**
 * Turn a catalog install command into an argv array.
 *
 * The catalog is authored as display text (`npm i -g <package>@latest`), so the
 * arguments are derived from the parsed command rather than by handing the whole
 * string to a shell interpreter.
 */
export function installArguments(entry: AgentCatalogEntry): readonly string[] {
  const parts = entry.installCommand.split(/\s+/u).filter(Boolean);
  if (parts[0] !== 'npm' || parts[1] !== 'i' || parts[2] !== '-g' || parts.length !== 4) {
    throw new TypeError(`catalog install command is not a supported shape: ${entry.installCommand}`);
  }
  return [parts[1], parts[2], parts[3]];
}

export class ToolUpgrader {
  private readonly runNpm: (args: readonly string[]) => Promise<string>;
  private readonly check?: EnvironmentCheck;
  private readonly reportFn?: () => Promise<EnvironmentReport>;
  /** Tail of the install queue; serializes every install on one promise chain. */
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: ToolUpgraderOptions = {}) {
    this.runNpm = options.runNpm ?? defaultRunNpm;
    this.check = options.check;
    this.reportFn = options.report;
  }

  /** Install or upgrade one catalog tool. */
  public async upgrade(id: string): Promise<UpgradeResult> {
    const entry = findEntry(id);
    if (entry === undefined) {
      return { id, ok: false, error: `unknown tool: ${id}` };
    }

    const run = async (): Promise<UpgradeResult> => {
      try {
        const output = await this.runNpm(installArguments(entry));
        await this.refresh();
        return { id, ok: true, output: output.trim() };
      } catch (error) {
        return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    // Chain onto the tail so a second install waits for the first to finish even
    // when it is requested while one is already running.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Upgrade every tool the report marks outdated.
   *
   * Tools that are not installed are skipped rather than installed, because a
   * bulk action must not add software the person never had.
   */
  public async upgradeAll(): Promise<UpgradeResult[]> {
    const report = await (this.reportFn ?? (async () => {
      if (this.check === undefined) throw new TypeError('no environment check is configured');
      return this.check.report();
    }))();

    const results: UpgradeResult[] = [];
    for (const tool of report.tools) {
      if (tool.state !== 'outdated') continue;
      results.push(await this.upgrade(tool.id));
    }
    return results;
  }

  private async refresh(): Promise<void> {
    // A failed refresh must not turn a successful install into a failure.
    await this.check?.report({ refresh: true }).catch(() => undefined);
  }
}

/**
 * Run npm without a shell, exactly as the version probe does: invoking npm's own
 * entry script with the current Node binary keeps every argument out of a command
 * interpreter's hands.
 */
async function defaultRunNpm(args: readonly string[]): Promise<string> {
  const npmCli = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const { stdout } = await execFileAsync(process.execPath, [npmCli, ...args], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    // A global install downloads and links the whole tree.
    timeout: 600_000,
  });
  return stdout;
}
