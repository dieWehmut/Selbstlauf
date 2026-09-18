import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProcessCommandRunner } from '../process/process-provider.js';

/**
 * Harvest the loopback TCP ports one process is listening on.
 *
 * The harness web host takes its port from `--port` or from composed defaults,
 * and the port is not recorded anywhere the watchdog can read, so the host's own
 * listening sockets are the authoritative answer. Only loopback and
 * all-interface binds are reported: the harness refuses to expose itself to the
 * network, and the watchdog only ever talks to `127.0.0.1`.
 */

const execFileAsync = promisify(execFile);

export interface LoopbackPortOptions {
  readonly powershellPath?: string;
  readonly runCommand?: ProcessCommandRunner;
}

const LISTEN_QUERY = [
  '$ErrorActionPreference = \'SilentlyContinue\'',
  `$ports = Get-NetTCPConnection -State Listen -OwningProcess ${'${PID}'} |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') } |
    Select-Object -ExpandProperty LocalPort |
    Sort-Object -Unique`,
  '$ports -join "\\n"',
].join('\n');

async function runPowerShell(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, [...args], {
      windowsHide: true,
      maxBuffer: 1 * 1024 * 1024,
      encoding: 'utf8',
      signal,
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Loopback port lookup failed: ${message}`);
  }
}

function parsePorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const token of stdout.split(/\s+/u)) {
    if (!/^\d+$/u.test(token)) continue;
    const port = Number(token);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * List the loopback ports owned by one PID.
 * @param pid - the owning process id.
 * @param options - overrides for tests.
 * @returns distinct listening ports, ascending; empty when the query fails.
 */
export async function listLoopbackListenPorts(
  pid: number,
  options: LoopbackPortOptions = {},
): Promise<number[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  const runCommand = options.runCommand ?? runPowerShell;
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    LISTEN_QUERY.replace('${PID}', String(pid)),
  ];
  try {
    return parsePorts(await runCommand(options.powershellPath ?? 'powershell.exe', args));
  } catch {
    return [];
  }
}