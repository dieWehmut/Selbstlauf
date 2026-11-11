import { execFile } from 'node:child_process';
import { open, opendir, readlink, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { RawProcessRecord } from './process-provider.js';

export interface WslProcFilesystemOptions {
  /** Distribution root; defaults to \\wsl.localhost\<distribution>. Overrides do not inherit host registry identity. */
  readonly rootDirectory?: string;
  /** Trusted distribution default UID, normally read from HKCU's Lxss registration. */
  readonly defaultUid?: number;
  readonly timeoutMs?: number;
  readonly maxProcesses?: number;
  readonly maxScanBytes?: number;
  /** Small dependency overrides for race/deadline fixtures; returned data is still size checked. */
  readonly readFile?: (path: string, maximumBytes: number, signal: AbortSignal) => Promise<Buffer>;
  readonly readlink?: (path: string) => Promise<string>;
}
export interface WslProcFilesystemResult {
  readonly records: readonly RawProcessRecord[];
  readonly homeDirectory?: string;
  readonly error?: string;
}
export const DEFAULT_WSL_FILESYSTEM_TIMEOUT_MS = 5_000;
const MAX_PROCESSES = 4096;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const CONCURRENCY = 8;
class ReadLimitError extends Error {}
class ByteBudgetError extends Error {}
interface ProcObservation {
  record: RawProcessRecord;
  uid?: number;
  home?: string;
}
interface ProcStat {
  parentPid: number;
  startTime: string;
  name: string;
}

/** Parse only DistributionName/DefaultUid; never return the other registry values. */
export function parseWslDefaultUidRegistryOutput(output: string, distribution: string): number | undefined {
  const matches = new Set<number>();
  let name: string | undefined;
  let uid: number | undefined;
  const finish = () => {
    if (name === distribution && uid !== undefined) matches.add(uid);
    name = undefined;
    uid = undefined;
  };
  for (const line of output.replaceAll('\0', '').split(/\r?\n/u)) {
    if (/^HKEY_CURRENT_USER\\/iu.test(line.trim())) {
      finish();
      continue;
    }
    const distributionMatch = /^\s*DistributionName\s+REG_SZ\s+(.+?)\s*$/iu.exec(line);
    if (distributionMatch) name = distributionMatch[1];
    const uidMatch = /^\s*DefaultUid\s+REG_DWORD\s+(0x[0-9a-f]+|[0-9]+)\s*$/iu.exec(line);
    if (uidMatch) {
      const value = Number(uidMatch[1]);
      if (validUid(value)) uid = value;
    }
  }
  finish();
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Read the already-running distribution through its proc filesystem without starting wsl.exe. */
export async function readWslProcFilesystem(distribution: string, options: WslProcFilesystemOptions = {}): Promise<WslProcFilesystemResult> {
  distribution = distribution.trim();
  if (!distribution || distribution === '.' || distribution === '..' || /[\\/\0\r\n]/u.test(distribution)) {
    return { records: [], error: 'invalid WSL distribution name' };
  }
  const root = options.rootDirectory ?? `\\\\wsl.localhost\\${distribution}`;
  const timeoutMs = boundedOption(options.timeoutMs, DEFAULT_WSL_FILESYSTEM_TIMEOUT_MS);
  const maxProcesses = boundedOption(options.maxProcesses, MAX_PROCESSES);
  const maxScanBytes = boundedOption(options.maxScanBytes, MAX_SCAN_BYTES);
  const abort = new AbortController();
  const warnings = new Set<string>();
  const observations: ProcObservation[] = [];
  let homeDirectory: string | undefined;
  let remainingBytes = maxScanBytes;
  const warn = (message: string, priority = false) => {
    if (warnings.has(message)) return;
    if (priority && warnings.size >= 4) warnings.delete(warnings.values().next().value!);
    if (warnings.size < 4) warnings.add(message);
  };
  const byteError = () => new ByteBudgetError(`filesystem byte budget exceeded (${maxScanBytes} bytes)`);
  const read = async (path: string, maximumBytes: number): Promise<Buffer> => {
    abort.signal.throwIfAborted();
    if (remainingBytes <= 0) throw byteError();
    if (options.readFile) {
      const data = await options.readFile(path, Math.min(maximumBytes, remainingBytes), abort.signal);
      abort.signal.throwIfAborted();
      if (data.length > remainingBytes) {
        remainingBytes = 0;
        throw byteError();
      }
      remainingBytes -= data.length;
      if (data.length > maximumBytes) throw new ReadLimitError(`filesystem file size limit exceeded: ${path}`);
      return data;
    }
    const handle = await open(path, 'r');
    try {
      abort.signal.throwIfAborted();
      // proc files commonly report size=0; read fixed chunks and one extra byte rather than trusting stat.size.
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= maximumBytes) {
        abort.signal.throwIfAborted();
        if (remainingBytes <= 0) throw byteError();
        const reservation = Math.min(16 * 1024, maximumBytes + 1 - size, remainingBytes);
        remainingBytes -= reservation;
        const buffer = Buffer.allocUnsafe(reservation);
        let bytesRead = 0;
        try { bytesRead = (await handle.read(buffer, 0, reservation, null)).bytesRead; }
        finally { remainingBytes += reservation - bytesRead; }
        abort.signal.throwIfAborted();
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maximumBytes) throw new ReadLimitError(`filesystem file size limit exceeded: ${path}`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, size);
    } finally { await handle.close(); }
  };
  const optionalRead = async (path: string, maximumBytes: number, reportBridgeFailure = false): Promise<Buffer | undefined> => {
    try {
      return await read(path, maximumBytes);
    } catch (error) {
      if (error instanceof ReadLimitError || error instanceof ByteBudgetError || abort.signal.aborted) throw error;
      const code = errorCode(error);
      // A lost command signature can hide an otherwise live tool. Ordinary exit and permission races
      // remain optional, but bridge failures cannot confirm that the process collection is complete.
      if (reportBridgeFailure && !['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(code)) {
        warn(`proc command line unavailable: ${code}`);
      }
      return undefined;
    }
  };
  const observe = async (pid: number): Promise<ProcObservation | undefined> => {
    const folder = join(root, 'proc', String(pid));
    const before = parseProcStat((await read(join(folder, 'stat'), 8192)).toString('utf8'), pid);
    if (!before) return undefined;
    const name = (await optionalRead(join(folder, 'comm'), 4096))?.toString('utf8').replace(/\n$/u, '') || before.name;
    const status = (await optionalRead(join(folder, 'status'), 64 * 1024))?.toString('utf8') ?? '';
    const parent = /^PPid:\s*([0-9]+)\s*$/mu.exec(status);
    const uid = /^Uid:\s*([0-9]+)(?:\s+[0-9]+){3}\s*$/mu.exec(status);
    const parentPid = parent && validPid(Number(parent[1]), true) ? Number(parent[1]) : before.parentPid;
    const command = await optionalRead(join(folder, 'cmdline'), 256 * 1024, true);
    const arguments_ = command === undefined ? undefined : procArguments(command);
    const commandLine = arguments_?.join(' ').trim() || null;
    const environment = selectedEnvironment(await optionalRead(join(folder, 'environ'), 64 * 1024));
    let workingDirectory: string | undefined;
    try {
      const path = await (options.readlink ?? readlink)(join(folder, 'cwd'));
      if (posix.isAbsolute(path) && !path.includes('\0')) workingDirectory = path;
    } catch {
      // UNC may expose cwd as a directory; PWD does not prove current cwd.
    }
    let interopCreatedSec: number | undefined;
    if (environment.interopSocket) {
      try {
        const details = await stat(join(root, ...environment.interopSocket.split('/').filter(Boolean)));
        if (Number.isFinite(details.mtimeMs) && details.mtimeMs > 0) interopCreatedSec = Math.floor(details.mtimeMs / 1000);
      } catch { /* A retired socket is optional. */ }
    }
    const after = parseProcStat((await read(join(folder, 'stat'), 8192)).toString('utf8'), pid);
    if (!after || after.startTime !== before.startTime || abort.signal.aborted) return undefined;
    return {
      uid: uid && validUid(Number(uid[1])) ? Number(uid[1]) : undefined,
      home: environment.home,
      record: {
        pid, parentPid, name, commandLine,
        executablePath: null, creationTimeMs: null, userSid: null,
        ancestors: [], windows: [],
        ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(environment.interopSocket ? { interopSocket: environment.interopSocket } : {}),
        ...(interopCreatedSec ? { interopCreatedSec } : {}),
      },
    };
  };
  const run = async () => {
    const ids: number[] = [];
    let directory;
    try {
      directory = await opendir(join(root, 'proc'));
      let inspected = 0;
      for await (const entry of directory) {
        abort.signal.throwIfAborted();
        if (++inspected > maxProcesses + 256) {
          warn(`filesystem process limit exceeded (${maxProcesses})`);
          break;
        }
        if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name) || !validPid(Number(entry.name))) continue;
        if (ids.length >= maxProcesses) {
          warn(`filesystem process limit exceeded (${maxProcesses})`);
          break;
        }
        ids.push(Number(entry.name));
      }
    } catch (error) {
      if (!abort.signal.aborted) warn(`proc filesystem unavailable: ${errorCode(error)}`);
      return;
    } finally {
      if (directory) await directory.close().catch(() => {});
    }
    ids.sort((a, b) => a - b);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (!abort.signal.aborted && remainingBytes > 0) {
        const pid = ids[next++];
        if (pid === undefined) break;
        try {
          const observation = await observe(pid);
          if (observation && !abort.signal.aborted) observations.push(observation);
        } catch (error) {
          if (error instanceof ReadLimitError || error instanceof ByteBudgetError) warn(error.message, error instanceof ByteBudgetError);
          else if (!abort.signal.aborted && !['ENOENT', 'ESRCH'].includes(errorCode(error))) {
            // The required before/after stat reads establish a current process. A failed bridge or
            // denied stat leaves its presence unknown while completed observations remain usable.
            warn(`proc process ${pid} unavailable: ${errorCode(error)}`);
          }
        }
      }
    }));
    if (abort.signal.aborted) return;
    let passwd: string | undefined;
    try {
      passwd = (await read(join(root, 'etc', 'passwd'), 128 * 1024)).toString('utf8');
    } catch (error) {
      if (error instanceof ReadLimitError || error instanceof ByteBudgetError) warn(error.message, error instanceof ByteBudgetError);
    }
    if (!passwd || abort.signal.aborted) return;
    const defaultUid = validUid(options.defaultUid) ? options.defaultUid
      : process.platform === 'win32' && options.rootDirectory === undefined
        ? await readRegistryDefaultUid(distribution, timeoutMs, abort.signal) : undefined;
    if (abort.signal.aborted) return;
    const homes = passwdHomes(passwd);
    if (defaultUid !== undefined) homeDirectory = homes.get(defaultUid);
    else if (!warnings.size) {
      const nonRootUids = new Set(observations
        .filter(observation => observation.uid !== undefined && observation.uid > 0)
        .map(observation => observation.uid!));
      if (nonRootUids.size === 1) {
        const uid = [...nonRootUids][0]!;
        const home = homes.get(uid);
        const group = observations.filter(observation => observation.uid === uid);
        if (home && group.some(observation => observation.home === home) &&
          !group.some(observation => observation.home !== undefined && observation.home !== home)) homeDirectory = home;
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run().catch(error => { if (!abort.signal.aborted) warn(`proc filesystem failed: ${errorCode(error)}`); }),
      new Promise<void>(resolve => {
        timer = setTimeout(() => {
          warn(`filesystem discovery timed out after ${timeoutMs}ms`, true);
          abort.abort();
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
  return {
    records: observations.map(observation => observation.record).sort((a, b) => a.pid - b.pid),
    ...(homeDirectory ? { homeDirectory } : {}),
    ...(warnings.size ? { error: `${distribution}: ${[...warnings].join('; ')}` } : {}),
  };
}
function parseProcStat(text: string, pid: number): ProcStat | undefined {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close <= open || text.slice(0, open).trim() !== String(pid)) return undefined;
  const fields = text.slice(close + 1).trim().split(/\s+/u);
  if (!/^[0-9]+$/u.test(fields[19] ?? '') || !/^[0-9]+$/u.test(fields[1] ?? '') || !validPid(Number(fields[1]), true)) return undefined;
  return { parentPid: Number(fields[1]), startTime: fields[19]!, name: text.slice(open + 1, close) };
}
function selectedEnvironment(data: Buffer | undefined): { home?: string; interopSocket?: string } {
  let home: string | undefined;
  let interopSocket: string | undefined;
  for (const entry of data?.toString('utf8').split('\0') ?? []) {
    if (entry.startsWith('HOME=') && posix.isAbsolute(entry.slice(5))) home = entry.slice(5);
    if (/^WSL_INTEROP=\/run\/WSL\/[0-9]+_interop$/u.test(entry)) interopSocket = entry.slice('WSL_INTEROP='.length);
  }
  return { home, interopSocket };
}
function procArguments(data: Buffer): readonly string[] {
  if (!data.length) return [];
  const args = data.toString('utf8').split('\0');
  // Remove the final record delimiter, preserving a genuinely empty last argument.
  if (args.at(-1) === '') args.pop();
  return args;
}
function passwdHomes(text: string): Map<number, string> {
  const homes = new Map<number, string>();
  const duplicates = new Set<number>();
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    const uid = Number(fields[2]);
    const home = fields[5];
    if (fields.length !== 7 || !/^[0-9]+$/u.test(fields[2] ?? '') || !validUid(uid) || !home || !posix.isAbsolute(home)) continue;
    if (homes.has(uid)) duplicates.add(uid); else homes.set(uid, home);
  }
  for (const uid of duplicates) homes.delete(uid);
  return homes;
}
function readRegistryDefaultUid(distribution: string, timeoutMs: number, signal: AbortSignal): Promise<number | undefined> {
  return new Promise(resolve => {
    execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024, signal,
    }, (error, stdout) => { resolve(error ? undefined : parseWslDefaultUidRegistryOutput(stdout, distribution)); });
  });
}
function validUid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}
function validPid(value: number, zero = false): boolean { return Number.isSafeInteger(value) && value >= (zero ? 0 : 1); }
function boundedOption(value: number | undefined, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(Math.floor(value), maximum)) : maximum;
}
function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : 'unknown error');
}
