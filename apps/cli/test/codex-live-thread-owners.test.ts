import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildCodexThreadOwnersProbe, parseCodexThreadOwnersProbe, readCodexThreadOwners,
  type CodexThreadOwner, type CodexThreadOwnerOptions,
} from '../src/codex/live-thread-owners.js';

const THREAD = '01a1c977-e596-7c43-8848-6308b65eeb43';
const OTHER_THREAD = '01a1ca99-868f-7531-8348-dcc6a3053a4e';
const HAS_LINUX_LOCKS = process.platform === 'linux' && spawnSync('python3', ['--version']).status === 0;
const LOCK_SCRIPT = `import fcntl, os, sys
handles = [open(path, 'a') for path in [sys.argv[1]] + sys.argv[3:]]
kind = fcntl.LOCK_SH if sys.argv[2] == 'shared' else fcntl.LOCK_EX
print('waiting', file=sys.stderr, flush=True)
for handle in handles:
    fcntl.flock(handle, kind)
print(os.getpid(), flush=True)
for line in sys.stdin:
    if line.strip() == 'unlock':
        for handle in handles:
            fcntl.flock(handle, fcntl.LOCK_UN)
        print('unlocked', flush=True)
    elif line.strip() == 'relock':
        for handle in handles:
            fcntl.flock(handle, kind)
        print('locked', flush=True)
`;

async function fixture(t: TestContext): Promise<{ home: string; directory: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), 'selbstlauf-thread-locks-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.codex', 'thread-writer-locks');
  await mkdir(directory, { recursive: true });
  return { home, directory, path: join(directory, `${THREAD}.lock`) };
}

function startLockProcess(t: TestContext, path: string, mode = 'exclusive', extraPaths: string[] = []): ChildProcessWithoutNullStreams {
  const child = spawn('python3', ['-c', LOCK_SCRIPT, path, mode, ...extraPaths], { stdio: 'pipe' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  return child;
}

async function lockProcess(t: TestContext, path: string, mode = 'exclusive', extraPaths: string[] = []): Promise<ChildProcessWithoutNullStreams> {
  const child = startLockProcess(t, path, mode, extraPaths);
  await once(child.stdout, 'data');
  return child;
}

function probeOwners(home: string, options: CodexThreadOwnerOptions = {}, env = process.env): CodexThreadOwner[] {
  return parseCodexThreadOwnersProbe(execFileSync('/bin/bash', ['-s'], {
    input: buildCodexThreadOwnersProbe(home, options), encoding: 'utf8', env, stdio: 'pipe', timeout: 2000,
  }));
}

async function assertOwners(home: string, options: CodexThreadOwnerOptions, expected: CodexThreadOwner[]): Promise<void> {
  assert.deepEqual(await readCodexThreadOwners(home, options), expected);
  assert.deepEqual(probeOwners(home, options), expected);
}

test('kernel lock acquire, release and owner exit govern both readers while the file remains', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, path } = await fixture(t);
  await writeFile(path, '');
  const options = { codexHomeDirectory: join(home, '.codex') };
  await assertOwners(home, options, []);
  const child = await lockProcess(t, path);
  await assertOwners(home, options, [{ pid: child.pid!, threadId: THREAD }]);
  let reply = once(child.stdout, 'data');
  child.stdin.write('unlock\n');
  await reply;
  await assertOwners(home, options, []);
  assert.equal(child.exitCode, null, 'releasing a lock does not need to end the process');
  reply = once(child.stdout, 'data');
  child.stdin.write('relock\n');
  await reply;
  await assertOwners(home, options, [{ pid: child.pid!, threadId: THREAD }]);
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
  await assertOwners(home, options, []);
  assert.equal((await lstat(path)).isFile(), true);
});

test('shared locks do not claim a thread writer', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, path } = await fixture(t);
  await lockProcess(t, path, 'shared');
  await assertOwners(home, { codexHomeDirectory: join(home, '.codex') }, []);
});

test('one daemon can own multiple current thread writer locks', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, directory, path } = await fixture(t);
  const holder = await lockProcess(t, path, 'exclusive', [join(directory, `${OTHER_THREAD}.lock`)]);
  await assertOwners(home, { codexHomeDirectory: join(home, '.codex') }, [
    { pid: holder.pid!, threadId: THREAD }, { pid: holder.pid!, threadId: OTHER_THREAD },
  ]);
});

test('a blocked exclusive waiter is excluded until it actually takes over the lock', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, path } = await fixture(t);
  const options = { codexHomeDirectory: join(home, '.codex') };
  const holder = await lockProcess(t, path);
  const waiter = startLockProcess(t, path);
  const waiting = once(waiter.stdout, 'data');
  const deadline = Date.now() + 2000;
  let blocked = false;
  while (Date.now() < deadline) {
    blocked = (await readFile('/proc/locks', 'utf8')).split('\n').some(line => line.includes('->') && line.split(/\s+/u)[5] === String(waiter.pid));
    if (blocked) break;
    await delay(5);
  }
  assert.equal(blocked, true, 'the regression must observe a real blocked kernel entry');
  await assertOwners(home, options, [{ pid: holder.pid!, threadId: THREAD }]);
  const exited = once(holder, 'exit');
  holder.stdin.end();
  await exited;
  await waiting;
  await assertOwners(home, options, [{ pid: waiter.pid!, threadId: THREAD }]);
});

test('unlinking a held inode and recreating its UUID path cannot revive the old owner', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, path } = await fixture(t);
  const holder = await lockProcess(t, path);
  const oldInode = (await lstat(path, { bigint: true })).ino;
  await unlink(path);
  await writeFile(path, '');
  assert.notEqual((await lstat(path, { bigint: true })).ino, oldInode);
  assert.equal(holder.exitCode, null, 'the deleted inode is still locked by a live process');
  await assertOwners(home, { codexHomeDirectory: join(home, '.codex') }, []);
});

test('unsafe UUID names, symlinks and ambiguous hardlinks cannot supply thread identities', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, directory, path } = await fixture(t);
  for (const name of ['not-a-thread.lock', `${THREAD}\n.lock`, `${THREAD}.lock.extra`]) {
    await lockProcess(t, join(directory, name));
  }
  const outside = join(home, 'outside-lock');
  await lockProcess(t, outside);
  await symlink(outside, path);
  const options = { codexHomeDirectory: join(home, '.codex') };
  await assertOwners(home, options, []);
  await unlink(path);
  const holder = await lockProcess(t, path);
  await assertOwners(home, options, [{ pid: holder.pid!, threadId: THREAD }]);
  await link(path, join(directory, `${OTHER_THREAD}.lock`));
  await assertOwners(home, options, []);
});

test('different locked inodes with the same canonical UUID are ambiguous', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, directory, path } = await fixture(t);
  await lockProcess(t, path);
  await lockProcess(t, join(directory, `${THREAD.toUpperCase()}.lock`));
  await assertOwners(home, { codexHomeDirectory: join(home, '.codex') }, []);
});

async function kernelFixture(t: TestContext): Promise<{ home: string; options: CodexThreadOwnerOptions; row: string; pid: number; proc: string }> {
  const { home, path } = await fixture(t);
  const holder = await lockProcess(t, path);
  const pid = holder.pid!;
  const inode = String((await lstat(path, { bigint: true })).ino);
  const row = (await readFile('/proc/locks', 'utf8')).split('\n').find(line => {
    const fields = line.trim().split(/\s+/u);
    return fields[4] === String(pid) && fields[5]?.split(':')[2] === inode && fields[1] === 'FLOCK';
  });
  assert(row, 'fixture must begin with a current real kernel lock');
  const proc = join(home, 'proc');
  await mkdir(join(proc, String(pid), 'fd'), { recursive: true });
  await mkdir(join(proc, String(pid), 'fdinfo'));
  await symlink(path, join(proc, String(pid), 'fd', '7'));
  await writeFile(join(proc, String(pid), 'stat'), await readFile(`/proc/${pid}/stat`));
  await writeFile(join(proc, 'locks'), row);
  await writeFile(join(proc, String(pid), 'fdinfo', '7'), `lock: ${row}\n`);
  const options = { codexHomeDirectory: join(home, '.codex'), procDirectory: proc };
  await assertOwners(home, options, [{ pid, threadId: THREAD }]);
  return { home, options, row, pid, proc };
}

test('kernel row parsing rejects blocked, nonexclusive, ownerless and partial-range entries', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, options, row, pid, proc } = await kernelFixture(t);
  for (const invalid of [
    row.replace(/^\d+:/u, '1: ->'), row.replace('WRITE', 'READ'), row.replace('FLOCK', 'POSIX'),
    row.replace('FLOCK', 'OFDLCK').replace(/WRITE\s+\d+/u, 'WRITE -1'),
    row.replace(/WRITE\s+\d+/u, 'WRITE 0'), row.replace(/WRITE\s+\d+/u, 'WRITE 2147483648'),
    row.replace(/WRITE\s+\d+/u, 'WRITE 123junk'), row.replace(/0 EOF$/u, '0 100'),
    row.replace(/0 EOF$/u, '1 EOF'),
  ]) {
    await writeFile(join(proc, 'locks'), invalid);
    await writeFile(join(proc, String(pid), 'fdinfo', '7'), `lock: ${invalid}\n`);
    await assertOwners(home, options, []);
  }
});

test('equal inode numbers need matching devices and a current descriptor lock and live PID', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, options, row, pid, proc } = await kernelFixture(t);
  const wrongDevice = row.replace(/\s[0-9a-f]+:([0-9a-f]+):/iu, ' ffffffff:$1:');
  await writeFile(join(proc, 'locks'), wrongDevice);
  await assertOwners(home, options, []);
  await writeFile(join(proc, 'locks'), row);
  await writeFile(join(proc, String(pid), 'fdinfo', '7'), `lock: ${wrongDevice}\n`);
  await assertOwners(home, options, []);
  await writeFile(join(proc, String(pid), 'fdinfo', '7'), `lock: ${row}\n`);
  const processStat = await readFile(join(proc, String(pid), 'stat'), 'utf8');
  const nameEnd = processStat.lastIndexOf(')');
  await writeFile(join(proc, String(pid), 'stat'), `${processStat.slice(0, nameEnd + 1)} Z${processStat.slice(nameEnd + 3)}`);
  await assertOwners(home, options, []);
  await rm(join(proc, String(pid)), { recursive: true });
  await assertOwners(home, options, []);
});

test('a known live writer with unreadable required process metadata fails instead of reporting no owners', { skip: !HAS_LINUX_LOCKS }, async t => {
  for (const field of ['stat', 'fd', 'fdinfo/7']) {
    await t.test(field, async child => {
      const { home, options, pid, proc } = await kernelFixture(child);
      const path = join(proc, String(pid), field);
      await rm(path, { recursive: true });
      // Real filesystem errors work under both privileged and ordinary test users.
      if (field === 'fd') await writeFile(path, 'not a descriptor directory');
      else await mkdir(path);
      await assert.rejects(readCodexThreadOwners(home, options), /EISDIR|ENOTDIR/u);
      assert.throws(() => probeOwners(home, options), failure => {
        const error = failure as Error & { status: number; stderr: string };
        return error.status !== 0 && /Is a directory|Not a directory/u.test(error.stderr);
      });
    });
  }
});

test('unreadable valid lock candidates fail while unrelated filenames are ignored', {
  skip: !HAS_LINUX_LOCKS || process.getuid?.() === 0,
}, async t => {
  const { home, options, pid } = await kernelFixture(t);
  const directory = join(home, '.codex', 'thread-writer-locks');
  try {
    // Directory entries remain enumerable; candidate lstat requires the absent search permission.
    await chmod(directory, 0o444);
    await assert.rejects(readCodexThreadOwners(home, options), { code: 'EACCES' });
    assert.throws(() => probeOwners(home, options), failure => {
      const error = failure as Error & { status: number; stderr: string };
      return error.status !== 0 && /Permission denied/u.test(error.stderr);
    });
    await chmod(directory, 0o700);
    await assertOwners(home, options, [{ pid, threadId: THREAD }]);
    await rename(join(directory, `${THREAD}.lock`), join(directory, 'unrelated.lock'));
    await chmod(directory, 0o444);
    await assertOwners(home, options, []);
  } finally { await chmod(directory, 0o700); }
});

test('malformed metadata for a known writer cannot establish process exit', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, options, pid, proc } = await kernelFixture(t);
  const path = join(proc, String(pid), 'stat');
  const original = await readFile(path, 'utf8');
  const nameEnd = original.lastIndexOf(')');
  const prefix = original.slice(0, nameEnd + 1);
  const fields = original.slice(nameEnd + 1).trim().split(/\s+/u);
  for (const malformed of ['', 'truncated data', `${prefix} S 1 2`, original.replace(/^\d+/u, String(pid + 1)),
    `${prefix} ${fields.map((value, index) => index === 19 ? 'invalid-start' : value).join(' ')}`]) {
    await writeFile(path, malformed);
    await assert.rejects(readCodexThreadOwners(home, options), /Invalid process stat/u);
    assert.throws(() => probeOwners(home, options), failure => {
      const error = failure as Error & { status: number; stderr: string };
      return error.status !== 0 && /Invalid process stat/u.test(error.stderr);
    });
  }
  for (const state of ['Z', 'X', 'x']) {
    await writeFile(path, `${prefix} ${state}${original.slice(nameEnd + 3)}`);
    await assertOwners(home, options, []);
  }
  await writeFile(path, original);
  await assertOwners(home, options, [{ pid, threadId: THREAD }]);
});

test('unrelated inaccessible descriptors cannot invalidate an independently verified writer', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, options, pid, proc } = await kernelFixture(t);
  // The looping descriptor raises ELOOP on stat; it does not identify the writer's inode.
  await symlink('1', join(proc, String(pid), 'fd', '1'));
  await assertOwners(home, options, [{ pid, threadId: THREAD }]);
  await rm(join(proc, String(pid), 'fd', '7'));
  // Without a verified descriptor the known writer cannot be disproved by that unreadable FD.
  await assert.rejects(readCodexThreadOwners(home, options), /ELOOP/u);
  assert.throws(() => probeOwners(home, options), failure => {
    const error = failure as Error & { status: number; stderr: string };
    return error.status !== 0 && /Too many levels of symbolic links/u.test(error.stderr);
  });
});

test('a descriptor or process disappearing during verification remains a successful absence', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home, options, pid, proc } = await kernelFixture(t);
  await rm(join(proc, String(pid), 'fdinfo', '7'));
  await assertOwners(home, options, []);
  await rm(join(proc, String(pid)), { recursive: true });
  await assertOwners(home, options, []);
});

test('both readers honor actual CODEX_HOME and explicit overrides', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home } = await fixture(t);
  const codexHomeDirectory = join(home, 'custom Codex state');
  await mkdir(join(codexHomeDirectory, 'thread-writer-locks'), { recursive: true });
  const holder = await lockProcess(t, join(codexHomeDirectory, 'thread-writer-locks', `${THREAD}.lock`));
  const saved = process.env.CODEX_HOME;
  t.after(() => { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; });
  process.env.CODEX_HOME = codexHomeDirectory;
  await assertOwners(home, {}, [{ pid: holder.pid!, threadId: THREAD }]);
  await assertOwners(home, { codexHomeDirectory: join(home, '.codex') }, []);
});

test('WSL arguments stay literal even with quotes, shell substitutions and newlines', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home } = await fixture(t);
  const marker = join(home, 'must-not-execute');
  const codexHomeDirectory = join(home, `state'\n$(touch "${marker}")\u0060touch "${marker}"\u0060`);
  await mkdir(join(codexHomeDirectory, 'thread-writer-locks'), { recursive: true });
  const holder = await lockProcess(t, join(codexHomeDirectory, 'thread-writer-locks', `${THREAD}.lock`));
  await assertOwners(`${home}/home'\n$(touch "${marker}")`, { codexHomeDirectory }, [{ pid: holder.pid!, threadId: THREAD }]);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
});

test('missing kernel metadata and missing python fail explicitly for caller fallback', { skip: !HAS_LINUX_LOCKS }, async t => {
  const { home } = await fixture(t);
  const options = { codexHomeDirectory: join(home, '.codex'), procDirectory: join(home, 'missing-proc') };
  await assert.rejects(readCodexThreadOwners(home, options), { code: 'ENOENT' });
  assert.throws(() => probeOwners(home, options));
  assert.throws(() => probeOwners(home, {}, { ...process.env, PATH: '' }), error => {
    const failure = error as Error & { status: number; stderr: string };
    return failure.status === 127 && /requires python3/u.test(failure.stderr);
  });
});

test('probe output validation rejects malformed or conflicting owners and strips unrelated fields', () => {
  const record = { pid: 2077, threadId: THREAD.toUpperCase(), privateToken: 'do-not-return' };
  assert.deepEqual(parseCodexThreadOwnersProbe(JSON.stringify([record, record])), [{ pid: 2077, threadId: THREAD }]);
  for (const invalid of ['shell startup noise\n[]', '{}', '[null]', '[1]', ...[
    { pid: '2077', threadId: THREAD }, { pid: 0, threadId: THREAD }, { pid: -1, threadId: THREAD },
    { pid: 1.5, threadId: THREAD }, { pid: 2147483648, threadId: THREAD },
    { pid: 2077, threadId: `${THREAD}\n` }, { pid: 2077, threadId: '../thread' },
  ].map(value => JSON.stringify([value])), JSON.stringify([{ pid: 2077, threadId: THREAD }, { pid: 2159, threadId: THREAD }])]) {
    assert.throws(() => parseCodexThreadOwnersProbe(invalid));
  }
  assert.throws(() => buildCodexThreadOwnersProbe('/home/han\0suffix'));
  assert.throws(() => buildCodexThreadOwnersProbe('/home/han', { codexHomeDirectory: 'relative-state' }));
});
