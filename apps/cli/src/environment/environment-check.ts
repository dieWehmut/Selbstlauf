import { AGENT_CATALOG, decideToolState, type ToolState } from './catalog.js';
import { readInstalledVersions, readLatestVersions, type InstalledVersion } from './probe.js';

/**
 * Assemble the "local environment" panel: what each agent CLI is, which version
 * is installed, which version is published, and the exact command that installs
 * it.
 *
 * The scan shells out to npm, so it is cached and only refreshed on demand or
 * after it goes stale. The panel is diagnostic: a probe that throws must still
 * produce a report that names every tool.
 */

export interface ToolReport {
  readonly id: string;
  readonly label: string;
  readonly packageName: string;
  readonly installed: string | null;
  readonly latest: string | null;
  readonly state: ToolState;
  readonly installCommand: string;
}

export interface EnvironmentReport {
  readonly tools: readonly ToolReport[];
  /** Ids whose installed version is behind the published one. */
  readonly upgrades: readonly string[];
  /** Ids with no local install at all. */
  readonly missing: readonly string[];
  /** Ready-to-paste install block shown behind the manual-command toggle. */
  readonly manualCommands: readonly string[];
  readonly checkedAtMs: number;
}

export interface EnvironmentCheckOptions {
  readonly readInstalled?: () => Promise<readonly InstalledVersion[]>;
  readonly readLatest?: () => Promise<ReadonlyMap<string, string>>;
  readonly now?: () => number;
  /** How long one scan stays fresh; the default keeps startup snappy. */
  readonly cacheMs?: number;
}

export interface ReportOptions {
  /** Force a fresh scan instead of reusing a cached one. */
  readonly refresh?: boolean;
}

export class EnvironmentCheck {
  private readonly readInstalled: () => Promise<readonly InstalledVersion[]>;
  private readonly readLatest: () => Promise<ReadonlyMap<string, string>>;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private cached: EnvironmentReport | null = null;
  private inFlight: Promise<EnvironmentReport> | null = null;

  public constructor(options: EnvironmentCheckOptions = {}) {
    this.readInstalled = options.readInstalled ?? (() => readInstalledVersions());
    this.readLatest = options.readLatest ?? (() => readLatestVersions());
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? 300_000;
  }

  public async report(options: ReportOptions = {}): Promise<EnvironmentReport> {
    const cacheValid = this.cached !== null
      && options.refresh !== true
      && this.now() - this.cached.checkedAtMs < this.cacheMs;
    if (cacheValid) return this.cached!;
    // Concurrent callers share one scan instead of starting several npm runs.
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.scan().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async scan(): Promise<EnvironmentReport> {
    const [installed, latest] = await Promise.all([
      this.readInstalled().catch(() => [] as readonly InstalledVersion[]),
      this.readLatest().catch(() => new Map<string, string>()),
    ]);
    const report = buildReport(installed, latest, this.now());
    this.cached = report;
    return report;
  }
}

function buildReport(
  installed: readonly InstalledVersion[],
  latest: ReadonlyMap<string, string>,
  checkedAtMs: number,
): EnvironmentReport {
  const installedById = new Map(installed.map((entry) => [entry.id, entry.installed]));
  const tools: ToolReport[] = AGENT_CATALOG.map((entry) => {
    const local = installedById.get(entry.id) ?? null;
    const published = latest.get(entry.packageName) ?? null;
    return Object.freeze({
      id: entry.id,
      label: entry.label,
      packageName: entry.packageName,
      installed: local,
      latest: published,
      // 'unknown' is distinct from 'current' so an offline scan never claims an
      // install is up to date.
      state: decideToolState({ installed: local === 'unknown' ? '0.0.0' : local, latest: published }),
      installCommand: entry.installCommand,
    });
  });

  return Object.freeze({
    tools: Object.freeze(tools),
    upgrades: Object.freeze(tools.filter((tool) => tool.state === 'outdated').map((tool) => tool.id)),
    missing: Object.freeze(tools.filter((tool) => tool.state === 'missing').map((tool) => tool.id)),
    manualCommands: Object.freeze(AGENT_CATALOG.map((entry) => entry.installCommand)),
    checkedAtMs,
  });
}

/** Convenience wrapper for callers that only need one report. */
export async function buildCheckReport(
  options: EnvironmentCheckOptions & ReportOptions = {},
): Promise<EnvironmentReport> {
  return new EnvironmentCheck(options).report(options);
}
