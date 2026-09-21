import { spawn } from 'node:child_process';

import type { RawProcessRecord } from './process-provider.js';

/**
 * Listing the processes running inside a WSL distribution.
 *
 * Why a distribution needs its own provider: WSL processes live in a Linux pid namespace, so they are
 * invisible to the Windows process table and never appear in `windows-processes.ps1`'s output. Measured:
 * `codex` running under Ubuntu-22.04 does not appear in `Get-CimInstance Win32_Process` at all.
 *
 * **The script is piped over stdin, not passed as an argument.** Building shell through
 * `wsl.exe -c "..."` means every quote, `$` and parenthesis has to survive PowerShell, then `cmd`, then the
 * Linux shell — and that is exactly where the exploratory probes for this feature kept breaking. With
 * `sh -s` the script never appears in an argument at all, so there is nothing to escape.
 *
 * Everything here is read-only. Discovery reports what exists; it never writes to a process.
 */

export interface WslDiscoveryOptions {
  /** The distribution to inspect, as `wsl.exe -d` names it. */
  readonly distribution: string;
  /** Overridden in tests so no child process is spawned. */
  readonly runWsl?: (distribution: string, script: string, signal?: AbortSignal) => Promise<string>;
  /** Overridden in tests, and defaulted to `wsl.exe` on Windows. */
  readonly wslPath?: string;
}

export interface WslDiscoveryResult {
  readonly records: readonly RawProcessRecord[];
  /** A stated reason when the distribution could not be inspected, rather than throwing. */
  readonly error?: string;
}

/**
 * The one-character field separator.
 *
 * A tab is used because the fields come from `ps` and a path or command line can contain spaces, quotes and
 * colons but not tabs.
 */
const FIELD_SEPARATOR = '\t';

/**
 * The probe script.
 *
 * `ps -eo pid=,ppid=,comm=,args=` gives the four fields a session needs; `readlink /proc/<pid>/cwd` adds the
 * working directory, which is how the app matches a session to a conversation. `/proc/<pid>/cwd` needs no
 * privilege for the same user, and a process that has exited between the two calls yields an empty string
 * rather than an error.
 *
 * The last two fields are the link back to the Windows terminal that launched the session. WSL sets
 * `WSL_INTEROP=/run/WSL/<relaypid>_interop` in everything an invocation launches, and that socket is created
 * when the invocation starts — so its timestamp identifies which `wsl.exe` this session belongs to. Measured on
 * this machine: the codex session's socket was created at 15:44:09 and `wsl.exe` 30044 (under `Tabby.exe`)
 * started at 15:44:08, which is what makes grouping by application possible instead of by operating system.
 */
const PROBE_SCRIPT = [
  'set -u',
  'ps -eo pid=,ppid=,comm=,args= --no-headers 2>/dev/null | while IFS= read -r line; do',
  '  # Split the first three fields off, then keep the remainder whole: the command line must not be',
  '  # re-split, because it is what carries the CLI signature.',
  '  pid=$(printf %s "$line" | awk \'{print $1}\')',
  '  ppid=$(printf %s "$line" | awk \'{print $2}\')',
  '  comm=$(printf %s "$line" | awk \'{print $3}\')',
  '  args=$(printf %s "$line" | sed \'s/^[[:space:]]*[^[:space:]]*[[:space:]]*[^[:space:]]*[[:space:]]*[^[:space:]]*[[:space:]]*//\')',
  '  cwd=$(readlink /proc/"$pid"/cwd 2>/dev/null || true)',
  '  interop=$(tr \'\\0\' \'\\n\' < /proc/"$pid"/environ 2>/dev/null | grep \'^WSL_INTEROP=\' | cut -d= -f2 || true)',
  '  created=$(stat -c %Y "$interop" 2>/dev/null || echo 0)',
  '  printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$pid" "$ppid" "$comm" "$args" "$cwd" "$interop" "$created"',
  'done',
].join('\n');

function defaultRunWsl(wslPath: string) {
  return async (distribution: string, script: string, signal?: AbortSignal): Promise<string> => {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(wslPath, ['-d', distribution, '--', 'sh', '-s'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        // A distribution that is not running, or is not installed, is an ordinary state rather than a bug,
        // so the message is carried out rather than swallowed.
        reject(new Error(stderr.trim().length > 0 ? stderr.trim() : `wsl exited with code ${code}`));
      });
      child.stdin.end(script);
    });
  };
}

/**
 * Convert one line of the probe's output into a process record.
 *
 * Returns null for a line that is not shaped like a record, so a partially-failed `readlink` or a stray line
 * from a shell startup file cannot become a malformed session.
 */
export function parseWslProcessLine(line: string): RawProcessRecord | null {
  if (line.trim().length === 0) return null;
  const parts = line.split(FIELD_SEPARATOR);
  if (parts.length < 4) return null;

  const pid = Number.parseInt(parts[0] ?? '', 10);
  const parentPid = Number.parseInt(parts[1] ?? '', 10);
  // A pid of 0 is the kernel's idle task and is never a session; a non-numeric field means the line is not
  // one of ours.
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) return null;

  const name = (parts[2] ?? '').trim();
  if (name.length === 0) return null;

  const commandLine = (parts[3] ?? '').trim();
  const workingDirectory = (parts[4] ?? '').trim();
  // The interop socket names the `wsl.exe` invocation this process belongs to, and its creation time is when
  // that invocation started. Both are carried so the caller can pair the session with a Windows terminal.
  const interopSocket = (parts[5] ?? '').trim();
  const interopCreatedSec = Number.parseInt((parts[6] ?? '').trim(), 10);

  return {
    pid,
    parentPid,
    name,
    // A Linux pid is not a Windows pid, so there is deliberately no executablePath, no userSid to compare
    // against the Windows one, and no windows: this record describes a process the window layer cannot see.
    commandLine: commandLine.length > 0 ? commandLine : null,
    executablePath: null,
    creationTimeMs: null,
    userSid: null,
    ...(workingDirectory.length > 0 ? { workingDirectory } : {}),
    ancestors: [],
    windows: [],
    ...(interopSocket.length > 0
      ? {
        interopSocket,
        ...(Number.isSafeInteger(interopCreatedSec) && interopCreatedSec > 0
          ? { interopCreatedSec }
          : {}),
      }
      : {}),
  };
}

export function parseWslPsOutput(stdout: string): RawProcessRecord[] {
  const records: RawProcessRecord[] = [];
  for (const line of stdout.split('\n')) {
    const record = parseWslProcessLine(line);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * List the processes in one distribution.
 *
 * Fails soft: a distribution that is stopped, missing, or slow yields a stated error and no records, because
 * WSL is an optional extra and must never stop the Windows sessions from being watched.
 */
export async function listWslProcesses(options: WslDiscoveryOptions): Promise<WslDiscoveryResult> {
  const distribution = options.distribution.trim();
  if (distribution.length === 0) return { records: [], error: 'no distribution configured' };

  const wslPath = options.wslPath ?? 'wsl.exe';
  const run = options.runWsl ?? defaultRunWsl(wslPath);
  try {
    const stdout = await run(distribution, PROBE_SCRIPT);
    return { records: parseWslPsOutput(stdout) };
  } catch (error) {
    return {
      records: [],
      error: `${distribution}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The distributions this machine has, as `wsl.exe -l -q` reports them. */
export async function listWslDistributions(wslPath = 'wsl.exe'): Promise<string[]> {
  return await new Promise<string[]>((resolve) => {
    const child = spawn(wslPath, ['-l', '-q'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    // A machine without WSL, or with none installed, is an ordinary state.
    child.on('error', () => { resolve([]); });
    child.on('close', () => {
      resolve(
        stdout
          // `wsl.exe` emits UTF-16LE, which arrives with NUL bytes interleaved when read as UTF-8.
          .replaceAll('\u0000', '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );
    });
  });
}