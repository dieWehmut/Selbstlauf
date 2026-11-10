import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseWslDefaultUidRegistryOutput, readWslProcFilesystem } from '../src/process/wsl-proc-filesystem.js';
import { groupProcesses } from '../src/process/discovery.js';
import { associateObservedGroups, cursorUserDataDirectory } from '../src/monitoring/association.js';

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'selbstlauf-wsl-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'proc')); await mkdir(join(root, 'etc'));
  await writeFile(join(root, 'etc', 'passwd'), 'root:x:0:0:root:/root:/bin/sh\nhan:x:1000:1000::/home/han:/bin/bash\nother:x:1001:1001::/home/other:/bin/sh\n');
  return root;
}
function procStat(pid: number, start = '1234567890123'): string {
  // stat field 2 can contain spaces and parentheses; starttime is field 22, not a whitespace index on the whole row.
  return `${pid} (worker (sub) name) S 1 ${Array(17).fill('0').join(' ')} ${start} 0 0\n`;
}
async function processFixture(root: string, pid: number, uid = 1000, home = '/home/han'): Promise<void> {
  const folder = join(root, 'proc', String(pid)); await mkdir(folder);
  await writeFile(join(folder, 'stat'), procStat(pid));
  await writeFile(join(folder, 'comm'), 'MainThread\n');
  await writeFile(join(folder, 'status'), `Name:\tMainThread\nPPid:\t7\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  await writeFile(join(folder, 'cmdline'), 'node\0/home/han/.local/bin/codex\0--flag\0argument with spaces\0');
  await writeFile(join(folder, 'environ'), `HOME=${home}\0PWD=/unverified/project\0WSL_INTEROP=/run/WSL/123_interop\0PRIVATE_TOKEN=must-never-return\0`);
}

test('WSL filesystem reads stable process records without retaining private environment or guessing cwd', async t => {
  const root = await fixture(t); await processFixture(root, 42);
  await mkdir(join(root, 'proc', '42', 'cwd'));
  await mkdir(join(root, 'run', 'WSL'), { recursive: true }); await writeFile(join(root, 'run', 'WSL', '123_interop'), '');
  const result = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, defaultUid: 1000 });
  assert.equal(result.error, undefined); assert.equal(result.homeDirectory, '/home/han'); assert.equal(result.records.length, 1);
  const record = result.records[0]!;
  assert.equal(record.pid, 42); assert.equal(record.parentPid, 7); assert.equal(record.name, 'MainThread');
  assert.equal(record.commandLine, 'node /home/han/.local/bin/codex --flag argument with spaces');
  assert.equal(record.workingDirectory, undefined); assert.equal(record.creationTimeMs, null); assert.equal(record.userSid, null);
  assert.equal(record.interopSocket, '/run/WSL/123_interop'); assert.equal(typeof record.interopCreatedSec, 'number');
  assert.equal(JSON.stringify(result).includes('must-never-return'), false); assert.equal(JSON.stringify(record).includes('/unverified/project'), false);
});

test('only a successful cwd readlink supplies the working directory, including UNC EISDIR failures', async t => {
  const root = await fixture(t); await processFixture(root, 42);
  const known = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, readlink: async () => '/workspace with spaces' });
  assert.equal(known.records[0]!.workingDirectory, '/workspace with spaces');
  const unavailable = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, readlink: async () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); } });
  assert.equal(unavailable.records[0]!.workingDirectory, undefined); assert.equal(unavailable.error, undefined);
});

test('raw proc arguments preserve spaced Gemini and Cursor entry paths through discovery and association', async t => {
  const root = await fixture(t); await processFixture(root, 42);
  for (const [tool, entry] of [
    ['gemini', '/home/fixture/My Tools/node_modules/@google/gemini-cli/dist/index.js'],
    ['cursor', '/home/fixture/My Tools/.local/share/cursor-agent/versions/current/cursor-agent'],
  ] as const) {
    const arguments_ = ['node', entry, '--resume', 'old-id', '--cwd', '/workspace with spaces', ''];
    await writeFile(join(root, 'proc', '42', 'cmdline'), `${arguments_.join('\0')}\0`);
    const scan = await readWslProcFilesystem('Ubuntu', { rootDirectory: root });
    assert.deepEqual(scan.records[0]!.arguments, arguments_);
    const groups = groupProcesses(scan.records, { distribution: 'Ubuntu' });
    assert.equal(groups.length, 1); assert.equal(groups[0]!.tool, tool); assert.equal(groups[0]!.workingDirectory, '/workspace with spaces');
    assert.deepEqual(groups[0]!.arguments, arguments_);
    const observed = { tool, id: 'old-id', cwds: ['/workspace with spaces'], lastActivityAtMs: 1, source: tool === 'gemini' ? 'gemini-json' as const : 'cursor-jsonl' as const, path: '/fixture/unread-history' };
    assert.equal(associateObservedGroups(groups, [observed], 100_000)[0]!.session?.id, 'old-id', 'only the actual resume argument can select an old recording');
  }
});

test('proc prompt values cannot supply resume, cwd or Cursor profile identity', async t => {
  const root = await fixture(t); await processFixture(root, 42);
  const entry = '/home/fixture/node_modules/@google/gemini-cli/dist/index.js';
  for (const prompt of ['please --resume old-id --cwd /historical/project', '--cwd=/historical/project', '--resume=old-id']) {
    const arguments_ = ['node', entry, '--prompt', prompt];
    await writeFile(join(root, 'proc', '42', 'cmdline'), `${arguments_.join('\0')}\0`);
    const scan = await readWslProcFilesystem('Ubuntu', { rootDirectory: root });
    const groups = groupProcesses(scan.records, { distribution: 'Ubuntu' });
    assert.equal(groups.length, 1); assert.equal(groups[0]!.workingDirectory, undefined, prompt);
    assert.equal(associateObservedGroups(groups, [{ tool: 'gemini', id: 'old-id', cwds: ['/historical/project'], lastActivityAtMs: 1, source: 'gemini-json', path: '/fixture/history' }], 100_000)[0]!.session, null, prompt);
  }
  const profileArgs = ['cursor', '--user-data-dir', '/profile with spaces'];
  assert.equal(cursorUserDataDirectory(profileArgs.join(' '), profileArgs), '/profile with spaces');
  const promptArgs = ['cursor', '-p', '--user-data-dir=/wrong-profile'];
  assert.equal(cursorUserDataDirectory(promptArgs.join(' '), promptArgs), undefined);
});

test('PID reuse and exit between stat reads cannot produce mixed process records', async t => {
  const root = await fixture(t); for (const pid of [42, 43, 44]) await processFixture(root, pid);
  const seen = new Map<string, number>();
  const result = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, readFile: async path => {
    if (basename(path) === 'stat') {
      const count = (seen.get(path) ?? 0) + 1; seen.set(path, count);
      if (path === join(root, 'proc', '42', 'stat') && count === 2) return Buffer.from(procStat(42, '9999999999999'));
      if (path === join(root, 'proc', '43', 'stat') && count === 2) throw Object.assign(new Error('exited'), { code: 'ENOENT' });
    }
    return readFile(path);
  } });
  assert.deepEqual(result.records.map(record => record.pid), [44]); assert.equal(result.error, undefined);
});

test('home comes from a trustworthy UID and passwd instead of Windows names or unverified HOME', async t => {
  const root = await fixture(t); await processFixture(root, 42);
  assert.equal((await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root })).homeDirectory, '/home/han');
  await processFixture(root, 43, 1001, '/home/other');
  const ambiguous = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root });
  assert.equal(ambiguous.records.length, 2); assert.equal(ambiguous.homeDirectory, undefined);
  assert.equal((await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, defaultUid: 1001 })).homeDirectory, '/home/other');
  await writeFile(join(root, 'proc', '43', 'environ'), 'HOME=/unverified/home\0');
  assert.equal((await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root })).homeDirectory, undefined, 'an unverified second nonroot UID cannot establish a unique default user');
  await writeFile(join(root, 'etc', 'passwd'), 'han:x:1000:1000::/home/han:/bin/sh\nduplicate:x:1000:1000::/wrong-home:/bin/sh\n');
  assert.equal((await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, defaultUid: 1000 })).homeDirectory, undefined);
  await rm(join(root, 'etc', 'passwd'));
  assert.equal((await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root })).records.length, 2);
});

test('a conflicting HOME in the sole nonroot UID group cannot establish a distribution home', async t => {
  const root = await fixture(t); await processFixture(root, 42); await processFixture(root, 43, 1000, '/wrong/home');
  const result = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root });
  assert.equal(result.records.length, 2); assert.equal(result.homeDirectory, undefined);
  assert.equal((await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, defaultUid: 1000 })).homeDirectory, '/home/han');
});

test('registry DefaultUid belongs only to the exact named distribution and conflicting registrations are rejected', () => {
  const registry = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{one}',
    '    DistributionName    REG_SZ    Ubuntu-22.04', '    DefaultUid    REG_DWORD    0x3e8',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{two}',
    '    DefaultUid    REG_DWORD    0x3e9', '    DistributionName    REG_SZ    Ubuntu',
  ].join('\r\n');
  assert.equal(parseWslDefaultUidRegistryOutput(registry, 'Ubuntu-22.04'), 1000);
  assert.equal(parseWslDefaultUidRegistryOutput(registry, 'Ubuntu'), 1001);
  assert.equal(parseWslDefaultUidRegistryOutput(registry, 'Missing'), undefined);
  assert.equal(parseWslDefaultUidRegistryOutput(`${registry}\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{three}\n    DistributionName    REG_SZ    Ubuntu-22.04\n    DefaultUid    REG_DWORD    0x3ea`, 'Ubuntu-22.04'), undefined);
});

test('process and byte limits return explicit warnings with only bounded completed records', async t => {
  const root = await fixture(t); for (const pid of [42, 43, 44]) await processFixture(root, pid);
  const limited = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, maxProcesses: 1 });
  assert.equal(limited.records.length, 1); assert.match(limited.error ?? '', /process limit/iu);
  const bytes = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, maxScanBytes: 8 });
  assert.deepEqual(bytes.records, []); assert.match(bytes.error ?? '', /byte budget/iu);
  await writeFile(join(root, 'proc', '42', 'cmdline'), 'x'.repeat(256 * 1024 + 1));
  const oversized = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root });
  assert.deepEqual(oversized.records.map(record => record.pid), [43, 44]); assert.match(oversized.error ?? '', /file.*limit/iu);
});

test('filesystem discovery uses at most eight concurrent process readers', async t => {
  const root = await fixture(t); for (let pid = 42; pid < 62; pid++) await processFixture(root, pid);
  let active = 0; let maximum = 0;
  const result = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, readFile: async path => {
    active++; maximum = Math.max(maximum, active);
    try { await delay(2); return await readFile(path); } finally { active--; }
  } });
  assert.equal(result.records.length, 20); assert(maximum <= 8); assert(maximum > 1);
});

test('a hung filesystem read meets the deadline and receives cancellation without hiding completed records', async t => {
  const root = await fixture(t); for (const pid of [42, 43]) await processFixture(root, pid);
  const signals: AbortSignal[] = []; const started = Date.now();
  const result = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root, timeoutMs: 30, readFile: async (path, _maximumBytes, signal) => {
    if (path.includes(`${join('proc', '43')}`)) { signals.push(signal); return new Promise<Buffer>(() => {}); }
    return readFile(path);
  } });
  assert.deepEqual(result.records.map(record => record.pid), [42]); assert.match(result.error ?? '', /timed out.*30ms/iu);
  assert.ok(Date.now() - started < 1000); assert(signals.every(signal => signal.aborted));
});

test('invalid names and unavailable proc roots report failure without inventing records', async t => {
  const root = await fixture(t);
  for (const distribution of ['', '../Ubuntu', 'Ubuntu\\other']) {
    const invalid = await readWslProcFilesystem(distribution, { rootDirectory: root });
    assert.deepEqual(invalid.records, []); assert.match(invalid.error ?? '', /distribution/iu);
  }
  await rm(join(root, 'proc'), { recursive: true });
  const missing = await readWslProcFilesystem('Ubuntu-22.04', { rootDirectory: root });
  assert.deepEqual(missing.records, []); assert.match(missing.error ?? '', /proc.*ENOENT/iu);
});
