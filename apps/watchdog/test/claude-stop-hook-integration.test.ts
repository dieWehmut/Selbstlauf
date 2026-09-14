import assert from 'node:assert/strict';
import { spawn, type SpawnOptions } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { ClaudeLeaseStore } from '../src/claude/lease-store.js';
import { CLAUDE_HOOK_OWNER } from '../src/claude/hook-installation.js';

const cliPath = resolve(fileURLToPath(import.meta.url), '../../src/claude/stop-hook-cli.js');

test('CLI consumes one exact temporary Claude lease without opening user settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-stop-hook-integration-'));
  const sessionA = inside(root, 'session-a');
  const sessionB = inside(root, 'session-b');
  const transcriptA = inside(sessionA, 'transcript.jsonl');
  const transcriptB = inside(sessionB, 'transcript.jsonl');
  const leasePath = inside(root, 'state', 'claude-leases.json');
  const guardPath = inside(root, 'path-guard.cjs');
  await mkdir(sessionA, { recursive: true });
  await mkdir(sessionB, { recursive: true });
  await writeFile(transcriptA, '{"role":"assistant","text":"done-a"}\n', 'utf8');
  await writeFile(transcriptB, '{"role":"assistant","text":"done-b"}\n', 'utf8');
  await writeFile(guardPath, pathGuardSource, 'utf8');

  const store = new ClaudeLeaseStore(leasePath);
  const activity = await stat(transcriptA);
  await store.arm({
    sessionId: 'session-a',
    cwd: sessionA,
    prompt: '继续',
    rootPid: 41_001,
    processStartedAtMs: 10,
    activity: { size: activity.size, mtimeMs: activity.mtimeMs },
    transcriptPath: transcriptA,
    ttlMs: 10_000,
  });

  const matching = hookInput('session-a', sessionA, transcriptA);
  const otherSession = hookInput('session-b', sessionB, transcriptB);
  const externalProfile = resolve(root, '..', 'real-userprofile-sentinel');
  const externalSettings = resolve(root, '..', 'real-settings-sentinel.json');
  const childOptions: SpawnOptions = {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      HOOK_TEST_ROOT: root,
      USERPROFILE: externalProfile,
      WATCHDOG_CLAUDE_SETTINGS_PATH: externalSettings,
    },
  };

  const first = await invokeCli(guardPath, leasePath, matching, childOptions, root);
  assert.deepEqual(first, {
    decision: 'block',
    reason: '继续',
    systemMessage: 'Continuation watchdog submitted a follow-up.',
  });

  const secondSession = await invokeCli(guardPath, leasePath, otherSession, childOptions, root);
  assert.deepEqual(secondSession, {});

  const repeatedMatching = await invokeCli(guardPath, leasePath, matching, childOptions, root);
  assert.deepEqual(repeatedMatching, {});
  assert.equal(await pathExists(inside(root, 'guard-ready')), true);
});

function hookInput(sessionId: string, cwd: string, transcriptPath: string): Record<string, unknown> {
  return {
    hook_event_name: 'Stop',
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    stop_hook_active: false,
  };
}

async function invokeCli(
  guardPath: string,
  leasePath: string,
  input: Record<string, unknown>,
  options: SpawnOptions,
  root: string,
): Promise<unknown> {
  await rm(inside(root, 'guard-ready'), { force: true });
  const child = spawn(process.execPath, [
    '--require', guardPath,
    cliPath,
    '--lease-file', leasePath,
    '--owner', CLAUDE_HOOK_OWNER,
  ], options);
  await waitForPath(inside(root, 'guard-ready'));
  assert(child.stdin !== null);
  assert(child.stdout !== null);
  assert(child.stderr !== null);
  child.stdin.end(`${JSON.stringify(input)}\n`);
  const [stdout, stderr, result] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    onceClose(child),
  ]);
  assert.equal(result.code, 0, stderr);
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

function onceClose(child: ReturnType<typeof spawn>): Promise<{ readonly code: number | null }> {
  return new Promise((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveClose({ code }));
  });
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as string | Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`path guard did not become ready: ${path}`);
}

function inside(root: string, ...parts: string[]): string {
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...parts);
  const relativePath = relative(rootPath, candidate);
  if (relativePath !== '' && (relativePath.startsWith('..') || isAbsolute(relativePath))) {
    throw new Error(`test target escaped temporary root: ${candidate}`);
  }
  return candidate;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const pathGuardSource = `
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.env.HOOK_TEST_ROOT || '');
const ready = path.join(root, 'guard-ready');
let active = false;

function asPath(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.href === 'string') {
    return require('node:url').fileURLToPath(value);
  }
  return null;
}

function assertInside(value) {
  if (!active) return;
  const candidate = asPath(value);
  if (candidate === null) return;
  const resolved = path.resolve(candidate);
  const relativePath = path.relative(root, resolved);
  if (relativePath !== '' && (relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath))) {
    throw new Error('filesystem target outside temporary root: ' + resolved);
  }
}

for (const name of ['access', 'mkdir', 'open', 'readFile', 'rename', 'rm', 'stat', 'writeFile']) {
  const original = fs.promises[name];
  fs.promises[name] = function (...args) {
    assertInside(args[0]);
    return Reflect.apply(original, this, args);
  };
}

active = true;
fs.writeFileSync(ready, 'ready\\n', 'utf8');
`;
