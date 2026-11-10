import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';

import type { RawProcessRecord } from './process-provider.js';
import { readWslProcFilesystem, type WslProcFilesystemResult } from './wsl-proc-filesystem.js';
import { killWindowsOwnedTree } from './windows-owned-tree.js';

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
  /** Internal discovery deadline; WSL must not block Windows monitoring. */
  readonly timeoutMs?: number;
  /** Reads the running distribution without spawning WSL; overridden for isolated tests. */
  readonly readFilesystem?: (distribution: string) => Promise<WslProcFilesystemResult>;
  /** During a command failure cooldown, try the filesystem before another command. */
  readonly preferFilesystem?: boolean;
}

export const DEFAULT_WSL_PROBE_TIMEOUT_MS = 5_000;
const WSL_PROBE_CLEANUP_TIMEOUT_MS = 5_000;
const pendingProbeKills = new WeakMap<ChildProcess, Promise<void>>();
const completedProbeKills = new WeakSet<ChildProcess>();
const probeIdentities = new WeakMap<ChildProcess, { createdAfterMs: number; createdBeforeMs: number }>();

/** Capture the native creation interval immediately around this child's spawn, before its PID can exit. */
export function registerWslProbeProcess(child: ChildProcess, createdAfterMs: number, createdBeforeMs: number): void {
  probeIdentities.set(child, { createdAfterMs, createdBeforeMs });
}

/** Kill only the probe's process tree: the Windows WSL shim can launch another wsl.exe beneath it. */
export function killWslProbeProcess(child: ChildProcess): Promise<void> {
  const pending = pendingProbeKills.get(child);
  if (pending !== undefined) return pending;
  if (completedProbeKills.has(child)) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) {
    return process.platform === 'win32' && child.pid !== undefined
      ? Promise.reject(new Error('Owned probe root exited before its tree cleanup was verified'))
      : Promise.resolve();
  }
  const killChild = () => {
    try { child.kill('SIGKILL'); } catch { /* The probe may already have exited. */ }
  };
  if (process.platform !== 'win32' || child.pid === undefined) { killChild(); return Promise.resolve(); }
  const identity = probeIdentities.get(child);
  if (identity === undefined) {
    killChild();
    return Promise.reject(new Error('Owned probe tree cleanup could not verify its spawn identity'));
  }
  // Toolhelp snapshots avoid taskkill /T's slow process enumeration. Held native handles prevent PID reuse
  // from redirecting a termination, and descendants are stopped before the still-live probe root.
  const operation = killWindowsOwnedTree({ pid: child.pid, ...identity, timeoutMs: 4_000 }).then((result) => {
    if (!result.verified) {
      killChild();
      throw new Error(`Owned probe tree cleanup was not verified: ${result.error ?? 'unknown error'}`);
    }
    completedProbeKills.add(child);
  }).finally(() => { pendingProbeKills.delete(child); });
  pendingProbeKills.set(child, operation);
  return operation;
}

export interface WslDiscoveryResult {
  readonly records: readonly RawProcessRecord[];
  /** A stated reason when the distribution could not be inspected, rather than throwing. */
  readonly error?: string;
  readonly source?: 'filesystem';
  readonly homeDirectory?: string;
  /** Command discovery failed, but live filesystem records remain usable. */
  readonly warning?: string;
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
    signal?.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const createdAfterMs = Date.now();
      const child = spawn(wslPath, ['-d', distribution, '--exec', 'sh', '-s'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // An installed desktop can inherit a WSL UNC cwd. Probe startup must use a native Windows cwd.
        ...(process.platform === 'win32' ? { cwd: tmpdir() } : {}),
      });
      registerWslProbeProcess(child, createdAfterMs, Date.now());
      let stdout = '';
      let stderr = '';
      let settled = false;
      let stopping = false;
      const onStdout = (chunk: Buffer) => { stdout += String(chunk); };
      const onStderr = (chunk: Buffer) => { stderr += String(chunk); };
      const finish = (error: unknown, output = '') => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        if (error !== undefined) reject(error);
        else resolve(output);
      };
      const stop = (error: unknown) => {
        if (settled || stopping) return;
        stopping = true;
        // Terminate only this read-only probe, never the distribution or its user processes. SIGKILL also
        // prevents a stuck probe that ignores SIGTERM from surviving the discovery deadline.
        // Closing the pipes can make the WSL shim exit before its owned descendants are enumerated.
        // Preserve them until tree termination has completed, including simultaneous timeout/stdin errors.
        const completeStop = (cleanupError?: unknown) => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          finish(cleanupError === undefined ? error : new Error(`${error instanceof Error ? error.message : String(error)}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
        };
        void killWslProbeProcess(child).then(() => completeStop(), completeStop);
      };
      const onAbort = () => { stop(signal?.reason ?? new Error('WSL probe aborted')); };
      const onError = (error: Error) => { stop(error); };
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      // Keep error handlers until close: spawn or stdin errors can arrive after a timeout killed the child.
      child.on('error', onError);
      child.stdin.on('error', onError);
      child.once('close', (code) => {
        child.off('error', onError);
        child.stdin.off('error', onError);
        if (stopping) return;
        if (code === 0) {
          finish(undefined, stdout);
          return;
        }
        // A distribution that is not running, or is not installed, is an ordinary state rather than a bug,
        // so the message is carried out rather than swallowed.
        finish(new Error(stderr.trim().length > 0 ? stderr.trim() : `wsl exited with code ${code}`));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      child.stdin.end(script);
    });
  };
}

/** Run one read-only WSL script with a deadline, including injected runners that ignore cancellation. */
export async function runWslProbe(options: WslDiscoveryOptions, script: string): Promise<string> {
  const distribution = options.distribution.trim();
  if (distribution.length === 0) throw new Error('no distribution configured');
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_WSL_PROBE_TIMEOUT_MS;
  const run = options.runWsl ?? defaultRunWsl(options.wslPath ?? 'wsl.exe');
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`WSL probe timed out after ${timeoutMs}ms`);
        abort.abort(error);
        if (options.runWsl !== undefined) reject(error);
        else cleanupTimer = setTimeout(() => { reject(error); }, WSL_PROBE_CLEANUP_TIMEOUT_MS);
      }, timeoutMs);
      // Attach both handlers even when the deadline wins, so a late injected rejection is consumed.
      Promise.resolve().then(() => run(distribution, script, abort.signal)).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(cleanupTimer);
  }
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
 * A broken command bridge need not mean a stopped distribution: Windows can still read its live /proc
 * through UNC. Use those records on failure; neither path reads historical processes or starts a user task.
 */
export async function listWslProcesses(options: WslDiscoveryOptions): Promise<WslDiscoveryResult> {
  const distribution = options.distribution.trim();
  if (distribution.length === 0) return { records: [], error: 'no distribution configured' };

  // Injected command tests never touch the user's distributions unless they explicitly supply a fallback.
  const readFilesystem = options.readFilesystem ?? (process.platform === 'win32' && options.runWsl === undefined
    ? (name: string) => readWslProcFilesystem(name, { timeoutMs: options.timeoutMs })
    : undefined);
  const filesystemResult = async (): Promise<WslDiscoveryResult> => {
    const result = await readFilesystem!(distribution);
    if (result.error !== undefined && result.records.length === 0) throw new Error(result.error);
    return { records: result.records, source: 'filesystem',
      ...(result.homeDirectory === undefined ? {} : { homeDirectory: result.homeDirectory }),
      ...(result.error === undefined ? {} : { warning: result.error }),
    };
  };
  if (options.preferFilesystem && readFilesystem !== undefined) {
    try { return await filesystemResult(); } catch { /* Retry the command if the filesystem bridge is gone. */ }
  }

  try {
    const stdout = await runWslProbe(options, PROBE_SCRIPT);
    return { records: parseWslPsOutput(stdout) };
  } catch (error) {
    const reason = `${distribution}: ${error instanceof Error ? error.message : String(error)}`;
    if (readFilesystem !== undefined) {
      try {
        const result = await filesystemResult();
        return { ...result, warning: [reason, result.warning].filter(Boolean).join('; ') };
      } catch (filesystemError) {
        return { records: [], error: `${reason}; filesystem: ${filesystemError instanceof Error ? filesystemError.message : String(filesystemError)}` };
      }
    }
    return { records: [], error: reason };
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
