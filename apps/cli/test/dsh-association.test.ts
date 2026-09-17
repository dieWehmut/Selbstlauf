import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';

import {
  dshProjectKey,
  dshSessionActivity,
  dshSessionActivityMs,
  hasDshSessionActivity,
  isLiveDshSession,
  scanDshSessions,
} from '../src/association/dsh.js';

const NOW = 1_789_656_000_000;
const SESSION_ID = 'session-3acd60b1-9056-4191-9070-8cd3563436a7';

test('dshProjectKey reproduces the harness project directory key', () => {
  assert.equal(dshProjectKey('D:\\project\\ai-cli-bypass'), '--D-project-ai-cli-bypass--');
  assert.equal(dshProjectKey('D:\\project\\Orchester'), '--D-project-Orchester--');
  assert.equal(dshProjectKey('C:/Users/30119'), '--C-Users-30119--');
  // Unsafe code units escape as ~XXXX and the run of separators collapses.
  assert.equal(dshProjectKey('D:\\a b'), '--D-a~0020b--');
  assert.equal(dshProjectKey('\\server\\share'), '--server-share--');
});

test('scanDshSessions reads the projection cache and the transcript metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'watchdog-dsh-'));
  try {
    const directory = join(home, 'sessions', '--D-project-ai-cli-bypass--', SESSION_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.v3.jsonl.zstd'), Buffer.alloc(4_096, 7));

    const projectionDirectory = join(home, 'storages', 'session_projcache', 'sessions');
    await mkdir(projectionDirectory, { recursive: true });
    await writeFile(join(projectionDirectory, `${SESSION_ID}.json`), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 3, createdAt: NOW - 60_000, cwd: 'D:\\project\\ai-cli-bypass' },
        rows: {
          sessionListMetadata: { ver: 1, seq: 472, val: { blank: false, lastPromptAt: NOW - 90_000 } },
          turnBoundary: {
            ver: 2,
            seq: 472,
            val: {
              openTurnStartSeq: 13,
              lastStepStartSeq: 470,
              lastStepBoundary: { kind: 'start', seq: 470 },
              lastTurn: 3,
            },
          },
        },
      },
    }));

    const sessions = await scanDshSessions({ homeDirectory: home });

    assert.equal(sessions.length, 1);
    const [session] = sessions;
    assert.ok(session);
    assert.equal(session.sessionId, SESSION_ID);
    assert.equal(session.cwd, 'D:\\project\\ai-cli-bypass');
    assert.equal(session.projectKey, '--D-project-ai-cli-bypass--');
    assert.equal(session.createdAtMs, NOW - 60_000);
    assert.equal(session.lastPromptAtMs, NOW - 90_000);
    assert.equal(session.sequence, 472);
    assert.equal(session.turnOpen, true);
    assert.equal(session.turnCount, 3);
    assert.equal(session.blank, false);
    assert.equal(session.transcriptSize, 4_096);
    assert.ok(session.projectionPath?.endsWith(`${SESSION_ID}.json`));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('scanDshSessions keeps a projection-only session visible', async () => {
  const home = await mkdtemp(join(tmpdir(), 'watchdog-dsh-'));
  try {
    const projectionDirectory = join(home, 'storages', 'session_projcache', 'sessions');
    await mkdir(projectionDirectory, { recursive: true });
    await writeFile(join(projectionDirectory, `${SESSION_ID}.json`), JSON.stringify({
      record: {
        identity: { cwd: 'D:\\project\\sandkasten', createdAt: NOW - 1_000 },
        rows: {
          sessionListMetadata: { seq: 12, val: { blank: false } },
          turnBoundary: { seq: 12, val: { lastStepBoundary: { kind: 'end' }, lastTurn: 1 } },
        },
      },
    }));

    const sessions = await scanDshSessions({ homeDirectory: home });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.cwd, 'D:\\project\\sandkasten');
    assert.equal(sessions[0]?.turnOpen, false);
    assert.equal(sessions[0]?.projectKey, '--D-project-sandkasten--');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('scanDshSessions fails soft on a malformed projection and an empty home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'watchdog-dsh-'));
  try {
    const projectionDirectory = join(home, 'storages', 'session_projcache', 'sessions');
    await mkdir(projectionDirectory, { recursive: true });
    await writeFile(join(projectionDirectory, `${SESSION_ID}.json`), '{ not json');

    assert.deepEqual(await scanDshSessions({ homeDirectory: home }), []);
    assert.deepEqual(
      await scanDshSessions({ homeDirectory: join(home, 'missing') }),
      [],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('scanDshSessions reads a plain transcript header when no projection exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'watchdog-dsh-'));
  try {
    const directory = join(home, 'sessions', '--D-project-ai-cli-bypass--', SESSION_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'session.v3.jsonl'),
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: SESSION_ID,
        createdAt: NOW - 5_000,
        cwd: 'D:\\project\\ai-cli-bypass',
      })}\n${JSON.stringify({ type: 'message' })}\n`,
    );

    const sessions = await scanDshSessions({ homeDirectory: home });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.cwd, 'D:\\project\\ai-cli-bypass');
    assert.equal(sessions[0]?.createdAtMs, NOW - 5_000);
    assert.equal(sessions[0]?.blank, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('hasDshSessionActivity reports sequence, size and mtime movement', () => {
  const base = { sequence: 10, transcriptSize: 100, transcriptMtimeMs: NOW };

  assert.equal(hasDshSessionActivity(base, { ...base }), false);
  assert.equal(hasDshSessionActivity(base, { ...base, sequence: 11 }), true);
  assert.equal(hasDshSessionActivity(base, { ...base, transcriptSize: 140 }), true);
  assert.equal(hasDshSessionActivity(base, { ...base, transcriptMtimeMs: NOW + 1 }), true);
});

test('isLiveDshSession excludes blank, unknown-directory and stale sessions', () => {
  const live = {
    sessionId: SESSION_ID,
    projectKey: '--D-project-ai-cli-bypass--',
    transcriptPath: 'C:\\x',
    transcriptSize: 10,
    transcriptMtimeMs: NOW - 1_000,
    projectionPath: null,
    projectionMtimeMs: NOW - 500,
    cwd: 'D:\\project\\ai-cli-bypass',
    createdAtMs: NOW - 60_000,
    lastPromptAtMs: null,
    sequence: 5,
    turnOpen: false,
    turnCount: 1,
    blank: false,
  };

  assert.equal(isLiveDshSession(live, { nowMs: NOW, windowMs: 3_600_000 }), true);
  assert.equal(isLiveDshSession(live, { nowMs: NOW + 7_200_000, windowMs: 3_600_000 }), false);
  assert.equal(isLiveDshSession({ ...live, blank: true }, { nowMs: NOW, windowMs: 3_600_000 }), false);
  assert.equal(isLiveDshSession({ ...live, cwd: null }, { nowMs: NOW, windowMs: 3_600_000 }), false);
  assert.equal(
    isLiveDshSession(live, { nowMs: NOW, windowMs: 3_600_000, hostStartedAtMs: NOW }),
    false,
  );
  assert.equal(dshSessionActivityMs(live), NOW - 500);
  assert.deepEqual(dshSessionActivity(live), {
    sequence: 5,
    transcriptSize: 10,
    transcriptMtimeMs: NOW - 1_000,
  });
});

test('scanDshSessions inflates a zstd transcript header without reading the body', async () => {
  const home = await mkdtemp(join(tmpdir(), 'watchdog-dsh-'));
  try {
    const directory = join(home, 'sessions', '--D-project-VerifierLab--', SESSION_ID);
    await mkdir(directory, { recursive: true });
    const body = `${JSON.stringify({
      type: 'session',
      version: 3,
      id: SESSION_ID,
      createdAt: NOW - 9_000,
      cwd: 'D:\\project\\VerifierLab',
    })}\n${'x'.repeat(200_000)}\n`;
    await writeFile(
      join(directory, 'session.v3.jsonl.zstd'),
      zstdCompressSync(Buffer.from(body, 'utf8')),
    );

    const sessions = await scanDshSessions({ homeDirectory: home });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.cwd, 'D:\\project\\VerifierLab');
    assert.equal(sessions[0]?.createdAtMs, NOW - 9_000);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('scanDshSessions fails soft on a transcript it cannot inflate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'watchdog-dsh-'));
  try {
    const directory = join(home, 'sessions', '--D-project-VerifierLab--', SESSION_ID);
    await mkdir(directory, { recursive: true });
    // A gzip stream is not a zstd frame; an unrecognized transcript format must
    // yield an unattributed session rather than an exception.
    await writeFile(
      join(directory, 'session.v3.jsonl.zstd'),
      gzipSync(Buffer.from(JSON.stringify({ type: 'session', cwd: 'D:\\project\\VerifierLab' }), 'utf8')),
    );

    const sessions = await scanDshSessions({ homeDirectory: home });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.cwd, null);
    assert.equal(sessions[0]?.transcriptMtimeMs !== null, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});