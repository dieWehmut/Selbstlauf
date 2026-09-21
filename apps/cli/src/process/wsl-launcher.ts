import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Attributing a WSL session to the Windows terminal it was launched from.
 *
 * The user's request is that a Codex session running inside WSL, started from Tabby, should be grouped **with
 * Tabby** rather than shown as its own WSL group: the grouping should follow the application a person works in,
 * not the operating system the process happens to run on.
 *
 * Measured, and the reason this module exists: a Linux pid can reach no Windows window, and the distribution-side
 * ancestry dead-ends at `Relay → SessionLeader → systemd`, so nothing inside the distribution names a terminal.
 * The link is on the Windows side instead — `wsl.exe` processes under `Tabby.exe` really do exist — and WSL
 * supplies the join: it sets `WSL_INTEROP=/run/WSL/<relaypid>_interop` in everything an invocation launches, and
 * creates that socket when the invocation starts.
 *
 * Measured pairing on this machine:
 *
 *     socket 66223_interop created  2026-09-20 15:44:09   (the session on pts/8)
 *     wsl.exe 30044 started         2026-09-20 15:44:08   (wsl.exe < cmd.exe < Tabby.exe)
 *
 * One second apart, and under Tabby — which is what makes the grouping the user asked for possible.
 *
 * The match is by time because it is the only property that connects the two sides, and it is deliberately
 * conservative: an ambiguous or distant match yields no attribution rather than a guess, because filing a
 * session under the wrong terminal is worse than filing it under its distribution.
 */

export interface WslLauncher {
  readonly pid: number;
  readonly startedAtSec: number;
  /** The process chain, outermost last, as `name` values. */
  readonly chain: readonly string[];
  /** The terminal that owns it, when the chain reaches a recognised one. */
  readonly terminal: string | null;
}

/** How close the socket time must be to a `wsl.exe` start time to count as the same invocation. */
export const LAUNCHER_MATCH_TOLERANCE_SEC = 10;

/**
 * Applications that are known to be where a person runs a CLI.
 *
 * Only these are used for grouping, because the chain also passes through shells and `wsl.exe` itself; the
 * terminal is the thing a person recognises.
 */
const TERMINAL_NAMES: readonly string[] = [
  'tabby.exe',
  'windowsterminal.exe',
  'wt.exe',
  'alacritty.exe',
  'wezterm-gui.exe',
  'conhost.exe',
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'windsurf.exe',
];

export interface WslLauncherOptions {
  /** Overridden in tests so no child process is spawned. */
  readonly runCommand?: (executable: string, args: readonly string[]) => Promise<string>;
  readonly powershellPath?: string;
}

/**
 * The `wsl.exe` processes running under a recognised terminal.
 *
 * `chain` is reported outermost-last so the terminal is the last entry that matches, which keeps a nested
 * `wsl.exe < wsl.exe < cmd.exe < Tabby.exe` resolving to Tabby rather than to the intermediate `wsl.exe`.
 */
const LIST_LAUNCHERS_SCRIPT = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$byId = @{}
foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
foreach ($p in $all) {
  if ($p.Name -ne 'wsl.exe') { continue }
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $chain = @()
  $cur = [int]$p.ProcessId
  for ($i = 0; $i -lt 10; $i++) {
    if (-not $byId.ContainsKey($cur)) { break }
    $chain += $byId[$cur].Name
    $cur = [int]$byId[$cur].ParentProcessId
    if ($cur -le 0) { break }
  }
  # A real epoch, not '-UFormat %s': measured, that format returns LOCAL time treated as UTC, which put every
  # start time 8 hours out on this machine and made the socket comparison match nothing.
  $started = [DateTimeOffset]::new($proc.StartTime).ToUnixTimeSeconds()
  Write-Output ($p.ProcessId.ToString() + '|' + $started.ToString() + '|' + ($chain -join ','))
}
`;

export function parseWslLaunchers(stdout: string): WslLauncher[] {
  const launchers: WslLauncher[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.length === 0 || !text.includes('|')) continue;
    const [pidText, startedText, chainText] = text.split('|');
    const pid = Number.parseInt(pidText ?? '', 10);
    const startedAtSec = Number.parseInt(startedText ?? '', 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!Number.isSafeInteger(startedAtSec) || startedAtSec <= 0) continue;
    const chain = (chainText ?? '').split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    // A line with no chain identifies no process at all, so it is dropped rather than carried as a launcher that
    // can never match a terminal.
    if (chain.length === 0) continue;
    // The outermost recognised terminal wins, so a nested wsl.exe does not shadow the real one.
    let terminal: string | null = null;
    for (const name of chain) {
      if (TERMINAL_NAMES.includes(name.toLowerCase())) terminal = name;
    }
    launchers.push({ pid, startedAtSec, chain, terminal });
  }
  return launchers;
}

/**
 * List the `wsl.exe` processes that are running under a terminal.
 *
 * Fails soft: a machine without WSL, or without PowerShell, yields no launchers, and the session is then grouped
 * under its distribution instead — which is honest, if less useful.
 */
export async function listWslLaunchers(options: WslLauncherOptions = {}): Promise<WslLauncher[]> {
  const run = options.runCommand ?? (async (executable: string, args: readonly string[]) => {
    const result = await execFileAsync(executable, [...args], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return result.stdout;
  });
  try {
    const stdout = await run(options.powershellPath ?? 'powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LIST_LAUNCHERS_SCRIPT,
    ]);
    return parseWslLaunchers(stdout);
  } catch {
    return [];
  }
}

/**
 * The terminal a session's interop socket belongs to, or null when it cannot be established.
 *
 * Only a terminal is returned, never an intermediate `wsl.exe` or shell: those are not what a person recognises,
 * and grouping under one would be less useful than grouping under the distribution.
 */
export function terminalForInterop(
  interopCreatedSec: number | undefined,
  launchers: readonly WslLauncher[],
  toleranceSec: number = LAUNCHER_MATCH_TOLERANCE_SEC,
): WslLauncher | null {
  if (interopCreatedSec === undefined || !Number.isSafeInteger(interopCreatedSec) || interopCreatedSec <= 0) {
    return null;
  }
  const candidates = launchers
    .filter((launcher) => launcher.terminal !== null)
    .map((launcher) => ({ launcher, delta: Math.abs(launcher.startedAtSec - interopCreatedSec) }))
    .filter(({ delta }) => delta <= toleranceSec)
    .sort((left, right) => left.delta - right.delta);

  if (candidates.length === 0) return null;

  /**
   * Several `wsl.exe` processes start together as one invocation, and they are not competing answers.
   *
   * Measured: launching WSL from Tabby produced `30044` and its child `12620`, both starting at the same second,
   * so both matched the socket with the same delta. An earlier version treated any equal delta as ambiguous and
   * returned nothing, which made this pairing fail even though the evidence was unambiguous — the whole point is
   * which *terminal* the session belongs to, and two `wsl.exe` processes in the same chain share one.
   *
   * The decision is therefore made on the terminal rather than on the process: several matches naming the same
   * terminal agree with each other, and only a genuine disagreement between terminals is ambiguous.
   */
  const terminals = new Set(candidates.map(({ launcher }) => launcher.terminal));
  if (terminals.size > 1) {
    // The closest match still wins, because the socket names one invocation; only an exact tie is unresolved.
    const closest = candidates[0]!;
    const tied = candidates.filter(({ delta }) => delta === closest.delta);
    if (new Set(tied.map(({ launcher }) => launcher.terminal)).size > 1) return null;
  }
  return candidates[0]!.launcher;
}