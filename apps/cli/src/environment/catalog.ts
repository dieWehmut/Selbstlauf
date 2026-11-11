import { AGENT_REGISTRY, agentInstallCommand } from '../agents/registry.js';

/** CLI-only view of the shared registry; desktop and extension installers remain publisher links. */
export interface AgentCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** Empty for tools distributed outside npm (Hermes). */
  readonly packageName: string;
  readonly executable: string;
  readonly installCommand: string;
  readonly installUrl?: string;
  readonly installArgs: readonly string[];
  readonly updateSource: 'npm' | 'none';
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = Object.freeze(
  AGENT_REGISTRY.filter((entry) => entry.kind === 'cli').map((entry) => Object.freeze({
    id: entry.id,
    label: entry.label,
    packageName: entry.packageName ?? '',
    executable: entry.command!,
    installCommand: agentInstallCommand(entry)!,
    installUrl: entry.installUrl,
    installArgs: entry.installArgs ?? [],
    updateSource: entry.packageName === undefined ? 'none' as const : 'npm' as const,
  })),
);

const VERSION_PATTERN = /^\d+(\.\d+)*$/u;

/** Split a dotted version into numeric segments, ignoring a leading `v`. */
function versionSegments(value: string): number[] | null {
  const trimmed = value.trim().replace(/^v/u, '');
  if (!VERSION_PATTERN.test(trimmed)) return null;
  return trimmed.split('.').map((segment) => Number(segment));
}

/**
 * Compare two dotted versions numerically.
 *
 * A plain string compare would order `2.1.9` after `2.1.10`, and date-style
 * versions such as OpenClaw's `2026.3.28` depend on numeric ordering too.
 * Returns -1, 0, or 1; a non-numeric input compares as equal so the caller
 * can fail closed instead of reporting a bogus upgrade.
 */
export function compareVersions(left: string, right: string): number {
  const a = versionSegments(left);
  const b = versionSegments(right);
  if (a === null || b === null) return 0;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export type ToolState = 'current' | 'outdated' | 'missing' | 'unknown';

export interface ToolVersionInput {
  readonly installed: string | null;
  readonly latest: string | null;
}

/**
 * Decide what the panel says about one tool.
 *
 * `unknown` is deliberately distinct from `current`: when the published
 * version could not be read (offline, registry error) the panel must not claim
 * the install is up to date, and it must not offer an upgrade either.
 */
export function decideToolState(input: ToolVersionInput): ToolState {
  if (input.installed === null) return 'missing';
  if (versionSegments(input.installed) === null
    || input.latest === null || versionSegments(input.latest) === null) return 'unknown';
  return compareVersions(input.installed, input.latest) < 0 ? 'outdated' : 'current';
}
