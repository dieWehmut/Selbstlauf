import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';

export interface CodexThreadOwner {
  pid: number;
  threadId: string;
}

export interface CodexThreadOwnerOptions {
  /** The actual CODEX_HOME; defaults to CODEX_HOME or homeDirectory/.codex. */
  codexHomeDirectory?: string;
  /** Linux procfs, including a filesystem fixture when testing. */
  procDirectory?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LOCK_PATTERN = /^\d+:[ \t]+FLOCK[ \t]+ADVISORY[ \t]+WRITE[ \t]+([1-9]\d*)[ \t]+([0-9a-f]+):([0-9a-f]+):(\d+)[ \t]+0[ \t]+EOF$/i;
const MAX_PID = 0x7fffffff;

interface KernelLock { pid: number; key: string }
interface ThreadFile { path: string; threadId: string; key: string }
interface VerifiedOwner extends CodexThreadOwner { file: ThreadFile; descriptor: string; startTime: string }

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID;
}

function validThreadId(id: unknown): id is string {
  return typeof id === 'string' && id.length === 36 && UUID_PATTERN.test(id);
}

function absoluteLinuxPath(path: string): string {
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('Codex thread owner paths must be absolute Linux paths');
  return path;
}

/** Linux dev_t encodes both halves beyond the low 16 bits; inode-only comparisons are unsafe. */
function fileKey(metadata: BigIntStats): string {
  const device = metadata.dev;
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return `${major}:${minor}:${metadata.ino}`;
}

function kernelLocks(text: string, fdInfo = false): KernelLock[] {
  const result: KernelLock[] = [];
  for (const line of text.split('\n')) {
    const source = fdInfo ? /^lock:\s+(.*)$/u.exec(line)?.[1] : line;
    if (source === undefined) continue;
    const match = LOCK_PATTERN.exec(source.trim());
    if (match === null) continue; // In particular, never treat an "->" blocked request as an owner.
    const pid = Number(match[1]);
    if (!validPid(pid)) continue;
    result.push({ pid, key: `${BigInt(`0x${match[2]}`)}:${BigInt(`0x${match[3]}`)}:${BigInt(match[4]!)}` });
  }
  return result;
}

function lockSignature(lock: KernelLock): string { return `${lock.pid}/${lock.key}`; }

async function processStartTime(proc: string, pid: number): Promise<string | null> {
  try {
    const text = await readFile(join(proc, String(pid), 'stat'), 'utf8');
    const nameEnd = text.lastIndexOf(')');
    if (nameEnd < 0 || Number(text.slice(0, text.indexOf(' '))) !== pid) return null;
    const fields = text.slice(nameEnd + 1).trim().split(/\s+/u);
    if (['Z', 'X', 'x'].includes(fields[0] ?? '')) return null;
    const start = fields[19]; // /proc/PID/stat field 22, after the parenthesized comm.
    return start !== undefined && /^\d+$/u.test(start) && BigInt(start) > 0n ? start : null;
  } catch { return null; }
}

async function descriptorOwns(proc: string, pid: number, descriptor: string, key: string): Promise<boolean> {
  try {
    const metadata = await stat(join(proc, String(pid), 'fd', descriptor), { bigint: true });
    if (!metadata.isFile() || fileKey(metadata) !== key) return false;
    const info = await readFile(join(proc, String(pid), 'fdinfo', descriptor), 'utf8');
    return kernelLocks(info, true).some(lock => lock.pid === pid && lock.key === key);
  } catch { return false; }
}

/**
 * Read current Linux writer owners without opening thread contents or consulting history.
 * Missing Codex lock directories mean no owners. Unavailable kernel metadata throws so callers can
 * distinguish an unsupported scan from a successful empty scan and choose their existing fallback.
 */
export async function readCodexThreadOwners(
  homeDirectory: string,
  options: CodexThreadOwnerOptions = {},
): Promise<CodexThreadOwner[]> {
  const home = absoluteLinuxPath(homeDirectory);
  const codexHome = absoluteLinuxPath(options.codexHomeDirectory ?? (process.env.CODEX_HOME || join(home, '.codex')));
  const proc = absoluteLinuxPath(options.procDirectory ?? '/proc');
  const directory = join(codexHome, 'thread-writer-locks');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = new Map<string, ThreadFile[]>();
  const threadCounts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
    const threadId = entry.name.slice(0, -5);
    if (!validThreadId(threadId)) continue;
    const path = join(directory, entry.name);
    try {
      const metadata = await lstat(path, { bigint: true });
      if (!metadata.isFile()) continue;
      const key = fileKey(metadata);
      const canonicalId = threadId.toLowerCase();
      threadCounts.set(canonicalId, (threadCounts.get(canonicalId) ?? 0) + 1);
      const candidates = files.get(key) ?? [];
      candidates.push({ path, threadId: canonicalId, key });
      files.set(key, candidates);
    } catch { /* A removed lock file is not an owner. */ }
  }
  const before = kernelLocks(await readFile(join(proc, 'locks'), 'utf8'));
  const byPid = new Map<number, ThreadFile[]>();
  for (const lock of before) {
    const candidates = files.get(lock.key);
    // Multiple UUID names for one inode cannot establish which thread actually owns the lock.
    if (candidates?.length !== 1 || threadCounts.get(candidates[0]!.threadId) !== 1) continue;
    const matched = byPid.get(lock.pid) ?? [];
    if (!matched.some(file => file.key === lock.key)) matched.push(candidates[0]!);
    byPid.set(lock.pid, matched);
  }
  const verified: VerifiedOwner[] = [];
  for (const [pid, candidates] of byPid) {
    const startTime = await processStartTime(proc, pid);
    if (startTime === null) continue;
    let descriptors: string[];
    try { descriptors = await readdir(join(proc, String(pid), 'fd')); }
    catch { continue; }
    const remaining = new Map(candidates.map(file => [file.key, file]));
    for (const descriptor of descriptors) {
      if (!/^\d+$/u.test(descriptor)) continue;
      try {
        const metadata = await stat(join(proc, String(pid), 'fd', descriptor), { bigint: true });
        const file = remaining.get(fileKey(metadata));
        if (file === undefined || !await descriptorOwns(proc, pid, descriptor, file.key)) continue;
        verified.push({ pid, threadId: file.threadId, file, descriptor, startTime });
        remaining.delete(file.key);
        if (remaining.size === 0) break;
      } catch { /* Descriptors may close while scanning. */ }
    }
  }
  const after = new Set(kernelLocks(await readFile(join(proc, 'locks'), 'utf8')).map(lockSignature));
  const owners: CodexThreadOwner[] = [];
  for (const owner of verified) {
    if (!after.has(lockSignature({ pid: owner.pid, key: owner.file.key }))) continue;
    if (await processStartTime(proc, owner.pid) !== owner.startTime) continue;
    try {
      const metadata = await lstat(owner.file.path, { bigint: true });
      if (!metadata.isFile() || fileKey(metadata) !== owner.file.key) continue;
      if (!await descriptorOwns(proc, owner.pid, owner.descriptor, owner.file.key)) continue;
      owners.push({ pid: owner.pid, threadId: owner.threadId });
    } catch { /* Exit, rename, unlink, or inode replacement invalidates this observation. */ }
  }
  return owners.sort((a, b) => a.pid - b.pid || a.threadId.localeCompare(b.threadId));
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

// Keep program text fixed: neither home paths nor environment values are interpolated into Python.
const OWNER_PROBE = `import json, os, re, stat, sys

uuid = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I | re.ASCII)
lock_row = re.compile(r'\\d+:[ \\t]+FLOCK[ \\t]+ADVISORY[ \\t]+WRITE[ \\t]+([1-9]\\d*)[ \\t]+([0-9a-f]+):([0-9a-f]+):(\\d+)[ \\t]+0[ \\t]+EOF', re.I | re.ASCII)

def absolute(path):
    if not path.startswith('/') or '\\0' in path:
        raise ValueError('Codex thread owner paths must be absolute Linux paths')
    return path

home, override, proc = sys.argv[1:4]
home = absolute(home)
codex_home = absolute(override or os.environ.get('CODEX_HOME') or os.path.join(home, '.codex'))
proc = absolute(proc)
directory = os.path.join(codex_home, 'thread-writer-locks')

def key(metadata):
    return (os.major(metadata.st_dev), os.minor(metadata.st_dev), metadata.st_ino)

def locks(text, fd_info=False):
    result = set()
    for line in text.splitlines():
        if fd_info:
            if not line.startswith('lock:'):
                continue
            line = line[5:]
        match = lock_row.fullmatch(line.strip())
        if match:
            pid = int(match[1])
            if 0 < pid <= 2147483647:
                result.add((pid, (int(match[2], 16), int(match[3], 16), int(match[4]))))
    return result

def text(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as handle:
        return handle.read()

def start_time(pid):
    try:
        value = text(os.path.join(proc, str(pid), 'stat'))
        end = value.rfind(')')
        if end < 0 or value.split(' ', 1)[0] != str(pid):
            return None
        fields = value[end + 1:].split()
        if fields[0] in ('Z', 'X', 'x') or not re.fullmatch(r'[0-9]+', fields[19]) or int(fields[19]) <= 0:
            return None
        return fields[19]
    except (OSError, ValueError, IndexError):
        return None

def descriptor_owns(pid, descriptor, inode):
    try:
        metadata = os.stat(os.path.join(proc, str(pid), 'fd', descriptor))
        info = text(os.path.join(proc, str(pid), 'fdinfo', descriptor))
        return stat.S_ISREG(metadata.st_mode) and key(metadata) == inode and (pid, inode) in locks(info, True)
    except OSError:
        return False

try:
    entries = list(os.scandir(directory))
except FileNotFoundError:
    print('[]')
    sys.exit(0)
files = {}
thread_counts = {}
for entry in entries:
    if not entry.name.endswith('.lock') or not uuid.fullmatch(entry.name[:-5]):
        continue
    try:
        metadata = entry.stat(follow_symlinks=False)
        if stat.S_ISREG(metadata.st_mode):
            thread_id = entry.name[:-5].lower()
            thread_counts[thread_id] = thread_counts.get(thread_id, 0) + 1
            files.setdefault(key(metadata), []).append((entry.path, thread_id))
    except OSError:
        pass

before = locks(text(os.path.join(proc, 'locks')))
by_pid = {}
for pid, inode in before:
    candidates = files.get(inode, [])
    if len(candidates) == 1 and thread_counts[candidates[0][1]] == 1:
        by_pid.setdefault(pid, {})[inode] = candidates[0]
verified = []
for pid, candidates in by_pid.items():
    start = start_time(pid)
    if start is None:
        continue
    try:
        descriptors = os.listdir(os.path.join(proc, str(pid), 'fd'))
    except OSError:
        continue
    for descriptor in descriptors:
        if not re.fullmatch(r'[0-9]+', descriptor):
            continue
        try:
            inode = key(os.stat(os.path.join(proc, str(pid), 'fd', descriptor)))
            candidate = candidates.get(inode)
            if candidate and descriptor_owns(pid, descriptor, inode):
                verified.append((pid, inode, candidate, descriptor, start))
                del candidates[inode]
                if not candidates:
                    break
        except OSError:
            pass
after = locks(text(os.path.join(proc, 'locks')))
owners = []
for pid, inode, (path, thread_id), descriptor, start in verified:
    if (pid, inode) not in after or start_time(pid) != start:
        continue
    try:
        metadata = os.stat(path, follow_symlinks=False)
        if stat.S_ISREG(metadata.st_mode) and key(metadata) == inode and descriptor_owns(pid, descriptor, inode):
            owners.append({'pid': pid, 'threadId': thread_id})
    except OSError:
        pass
print(json.dumps(sorted(owners, key=lambda owner: (owner['pid'], owner['threadId']))))`;

/** A read-only bash script accepted directly by runWslProbe; missing python3 fails explicitly. */
export function buildCodexThreadOwnersProbe(
  homeDirectory: string,
  options: CodexThreadOwnerOptions = {},
): string {
  const home = absoluteLinuxPath(homeDirectory);
  const codexHome = options.codexHomeDirectory === undefined ? '' : absoluteLinuxPath(options.codexHomeDirectory);
  const proc = absoluteLinuxPath(options.procDirectory ?? '/proc');
  return `command -v python3 >/dev/null 2>&1 || { printf '%s\\n' 'Codex thread owner probe requires python3' >&2; exit 127; }\npython3 - ${shellQuote(home)} ${shellQuote(codexHome)} ${shellQuote(proc)} <<'SELBSTLAUF_CODEX_THREAD_OWNERS_PY'\n${OWNER_PROBE}\nSELBSTLAUF_CODEX_THREAD_OWNERS_PY\n`;
}

/** Fail on malformed probe output rather than manufacturing owners from shell noise. */
export function parseCodexThreadOwnersProbe(output: string): CodexThreadOwner[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error('Codex thread owner probe must return a JSON array');
  const owners = new Map<string, CodexThreadOwner>();
  for (const row of value) {
    if (row === null || typeof row !== 'object' || !validPid(row.pid) || !validThreadId(row.threadId)) {
      throw new Error('Codex thread owner probe returned an invalid owner');
    }
    const threadId = row.threadId.toLowerCase();
    const previous = owners.get(threadId);
    if (previous !== undefined && previous.pid !== row.pid) throw new Error('Codex thread owner probe returned conflicting owners');
    owners.set(threadId, { pid: row.pid, threadId });
  }
  return [...owners.values()].sort((a, b) => a.pid - b.pid || a.threadId.localeCompare(b.threadId));
}
