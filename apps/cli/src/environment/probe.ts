import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AGENT_CATALOG } from './catalog.js';
import { runNpmCommand } from './npm-runtime.js';
import { executableExistsOnPath } from './system-path.js';

/**
 * Read what is installed locally and what the registry currently publishes.
 *
 * Two different mechanisms are used because the tools are not distributed the
 * same way: every catalog entry except Hermes is published on npm and is best
 * read from the package manager's own report, while Hermes is a Python install
 * that answers `hermes version` with a banner.
 *
 * Every probe is best-effort. A missing executable, a malformed report, or an
 * offline registry must degrade to "unknown" rather than fail the whole scan,
 * because the panel is diagnostic and must never block the watchdog.
 */

const execFileAsync = promisify(execFile);

export interface InstalledVersion {
  readonly id: string;
  /** Installed version, or null when the tool is not installed at all. */
  readonly installed: string | null;
}

export interface ProbeOptions {
  /** Runs `npm ls -g --json`; overridable for tests. */
  readonly runNpm?: () => Promise<string>;
  /** Runs `npm view <package> version`; overridable for tests. */
  readonly runNpmView?: (packageName: string) => Promise<string>;
  /** Runs `<executable> --version`; overridable for tests. */
  readonly runExecutable?: (executable: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
  /** Tests whether a catalog executable is available; overridable for tests. */
  readonly fileExists?: (path: string) => boolean;
}

async function run(executable: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

function defaultRunNpm(): Promise<string> {
  return runNpmCommand(['ls', '-g', '--json'], 120_000);
}

function defaultRunNpmView(packageName: string): Promise<string> {
  return runNpmCommand(['view', packageName, 'version'], 120_000);
}

/**
 * Read the package names and versions out of `npm ls -g --json`.
 *
 * The report nests what npm considers the dependency tree; only the top-level
 * `dependencies` map is meaningful here, and any entry that does not carry a
 * string version is skipped rather than surfaced as a version.
 */
export function parseNpmGlobalVersions(report: string): Map<string, string> {
  const versions = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(report) as unknown;
  } catch {
    return versions;
  }
  if (parsed === null || typeof parsed !== 'object') return versions;
  const dependencies = (parsed as { dependencies?: unknown }).dependencies;
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return versions;
  }
  for (const [name, entry] of Object.entries(dependencies as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') continue;
    const version = (entry as { version?: unknown }).version;
    if (typeof version === 'string' && version.trim().length > 0) {
      versions.set(name, version.trim());
    }
  }
  return versions;
}

const HERMES_VERSION_PATTERN = /\bv(\d+(?:\.\d+)+)/u;

/** Read `0.18.0` out of `Hermes Agent v0.18.0 (2026.7.1) ...`. */
export function parseHermesVersion(banner: string): string | null {
  const match = HERMES_VERSION_PATTERN.exec(banner);
  return match === null ? null : match[1];
}

/**
 * Report the installed version of every catalog tool.
 *
 * A tool that is not installed is null; a tool whose executable exists but whose
 * version cannot be read is `'unknown'`, which keeps the panel honest about the
 * difference between "absent" and "present, unreadable".
 */
export async function readInstalledVersions(options: ProbeOptions = {}): Promise<InstalledVersion[]> {
  const runNpm = options.runNpm ?? defaultRunNpm;
  const runExecutable = options.runExecutable ?? ((executable: string) => run(executable, ['--version']));
  const fileExists = options.fileExists
    ?? ((executable: string) => executableExistsOnPath(executable, options.platform ?? process.platform));

  let reported = new Map<string, string>();
  try {
    reported = parseNpmGlobalVersions(await runNpm());
  } catch {
    // A missing or failing package manager leaves every npm tool unknown below.
  }

  const results: InstalledVersion[] = [];
  for (const entry of AGENT_CATALOG) {
    const fromManager = reported.get(entry.packageName);
    if (fromManager !== undefined) {
      results.push({ id: entry.id, installed: fromManager });
      continue;
    }
    if (!fileExists(entry.executable)) {
      results.push({ id: entry.id, installed: null });
      continue;
    }
    let version: string | null = null;
    try {
      version = parseHermesVersion(await runExecutable(entry.executable));
    } catch {
      version = null;
    }
    results.push({ id: entry.id, installed: version ?? 'unknown' });
  }
  return results;
}

/**
 * Report the published version of every npm-distributed catalog tool.
 *
 * A registry error is not fatal: the entry is simply absent from the map so the
 * caller reports `unknown` rather than a fabricated upgrade.
 */
export async function readLatestVersions(options: ProbeOptions = {}): Promise<Map<string, string>> {
  const runNpmView = options.runNpmView ?? defaultRunNpmView;
  const latest = new Map<string, string>();
  const entries = AGENT_CATALOG.filter((entry) => entry.updateSource === 'npm');

  await Promise.all(entries.map(async (entry) => {
    try {
      const answer = (await runNpmView(entry.packageName)).trim();
      if (answer.length > 0) latest.set(entry.packageName, answer);
    } catch {
      // Unknown stays unknown; never invent a version.
    }
  }));
  return latest;
}
