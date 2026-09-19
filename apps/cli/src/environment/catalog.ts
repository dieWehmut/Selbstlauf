/**
 * The agent CLIs Selbstlauf knows how to report on.
 *
 * CC Switch shows a "local environment" panel that lists the agent CLIs a person
 * actually runs, their installed and published versions, and the exact npm
 * command that installs each one. The catalog is data rather than code so the
 * panel, the version probes, and the documented install commands can never
 * disagree with each other.
 *
 * Command shapes were verified against the installed tools on this host:
 *   - `npm ls -g --json` reports the npm-installed CLIs and their versions.
 *   - `hermes version` prints `Hermes Agent v0.18.0 (2026.7.1)`.
 */

export interface AgentCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** npm package that publishes the CLI. */
  readonly packageName: string;
  /** Executable probed on PATH when the package manager cannot answer. */
  readonly executable: string;
  /** Cut-and-paste install/upgrade command shown in the manual panel. */
  readonly installCommand: string;
  /** How the published version is discovered. */
  readonly updateSource: 'npm' | 'none';
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    executable: 'claude',
    installCommand: 'npm i -g @anthropic-ai/claude-code@latest',
    updateSource: 'npm',
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    packageName: '@openai/codex',
    executable: 'codex',
    installCommand: 'npm i -g @openai/codex@latest',
    updateSource: 'npm',
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    packageName: '@google/gemini-cli',
    executable: 'gemini',
    installCommand: 'npm i -g @google/gemini-cli@latest',
    updateSource: 'npm',
  }),
  Object.freeze({
    id: 'grok',
    label: 'Grok Build',
    packageName: '@xai-official/grok',
    executable: 'grok',
    installCommand: 'npm i -g @xai-official/grok@latest',
    updateSource: 'npm',
  }),
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    packageName: 'opencode-ai',
    executable: 'opencode',
    installCommand: 'npm i -g opencode-ai@latest',
    updateSource: 'npm',
  }),
  Object.freeze({
    id: 'openclaw',
    label: 'OpenClaw',
    packageName: 'openclaw',
    executable: 'openclaw',
    installCommand: 'npm i -g openclaw@latest',
    updateSource: 'npm',
  }),
]);

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
