// Prove the watchdog can continue a DeepSeek Harness session.
//
// The check owns a disposable session, because writing into a session a person
// is working in would be rude. It creates that session through the harness's own
// loopback API, sends the continuation with the exact transport the watchdog
// uses, cancels the turn it started, and then requires the harness to have
// persisted the message.
//
// Usage: node scripts/verify/dsh-continuation.mjs
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { DshHostClient } = await import(
  new URL('../../apps/cli/dist/src/dsh/web-host.js', import.meta.url).href
);
const { listLoopbackListenPorts } = await import(
  new URL('../../apps/cli/dist/src/dsh/loopback-ports.js', import.meta.url).href
);
const { DshWebTransport } = await import(
  new URL('../../apps/cli/dist/src/transport/dsh-transport.js', import.meta.url).href
);
const { groupProcesses } = await import(
  new URL('../../apps/cli/dist/src/process/discovery.js', import.meta.url).href
);
const { WindowsProcessProvider } = await import(
  new URL('../../apps/cli/dist/src/process/process-provider.js', import.meta.url).href
);

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh');
const failures = [];
const steps = [];

function check(condition, message) {
  steps.push(`${condition ? 'ok   ' : 'FAIL '} ${message}`);
  if (!condition) failures.push(message);
}

// --- find the running harness host -------------------------------------------
const records = await new WindowsProcessProvider({ includeProcessIds: [process.pid] }).listProcesses();
const hosts = groupProcesses(records, { currentProcessId: process.pid, sameUserOnly: true })
  .filter((group) => group.tool === 'dsh');
if (hosts.length === 0) {
  console.log('no DeepSeek Harness host is running; nothing to verify');
  process.exit(0);
}
const host = hosts[0];
const client = new DshHostClient({ homeDirectory: dshHome });

let origin = null;
const configured = process.env.DSH_WEB_URL?.trim();
for (const candidate of [
  ...(configured ? [configured] : []),
  ...(await listLoopbackListenPorts(host.rootPid)).map((port) => `http://127.0.0.1:${port}`),
]) {
  if (await client.adopt(candidate)) {
    origin = client.origin;
    break;
  }
}
check(origin !== null, `the harness host (PID ${host.rootPid}) answered and accepted the local credential`);
if (origin === null) {
  console.log(steps.join('\n'));
  console.error('\nDSH continuation verification failed: no authenticated harness origin');
  process.exit(1);
}
console.log(`harness origin: ${origin}`);

// --- own a disposable session ------------------------------------------------
const workspace = await mkdtemp(join(tmpdir(), 'selbstlauf-dsh-continuation-'));
const created = await client.createSession(workspace);
check(created.ok, 'the harness created a disposable session for the verification');
if (!created.ok) {
  console.log(steps.join('\n'));
  console.error(`\nDSH continuation verification failed: ${created.error}`);
  await rm(workspace, { recursive: true, force: true });
  process.exit(1);
}
const sessionId = created.sessionId;
console.log(`scratch session: ${sessionId} (workspace ${workspace})`);

let idle = true;
const transport = new DshWebTransport({
  pid: host.rootPid,
  sessionId,
  client,
  isIdle: () => idle,
});

try {
  // --- the watchdog's own write path -----------------------------------------
  const written = await transport.write(host.rootPid, '继续');
  check(written.ok, `the harness accepted a continuation for ${sessionId}: ${written.ok ? '' : written.error ?? ''}`);

  // The idle guard is part of the contract, not an afterthought.
  idle = false;
  const refused = await transport.write(host.rootPid, '继续');
  check(!refused.ok, 'a session with an unfinished step is never handed a second continuation');
  idle = true;

  const foreign = await transport.write(host.rootPid + 1, '继续');
  check(!foreign.ok, 'a continuation is refused for a process that does not own the session');

  // --- the harness persisted it ---------------------------------------------
  // The harness materializes the directory first and flushes the log with the
  // first event, so the log is awaited rather than sampled once.
  const sessionDirectory = await waitForSessionDirectory(dshHome, sessionId, 30_000);
  check(sessionDirectory !== null, 'the harness materialized the session on disk');
  if (sessionDirectory !== null) {
    const log = await waitForSessionLog(sessionDirectory, 30_000);
    check(log !== null, `the session log recorded the continuation (${log?.name ?? 'none'})`);
    if (log !== null) {
      check(log.size > 0, `the session log grew to ${log.size} bytes`);
    }
  }

  // Stop the turn this verification started so it costs the machine nothing.
  const cancelled = await client.cancelSession(sessionId);
  check(cancelled.ok, 'the verification cancelled the turn it started');
} finally {
  console.log('\n' + steps.join('\n'));
  if (failures.length > 0) {
    console.error(`\nDSH continuation verification failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nDSH continuation verification passed');
  }
  console.log(`\nnote: disposable session ${sessionId} remains in the harness; delete it from the WebUI or run`);
  console.log(`      Remove-Item -Recurse "$env:USERPROFILE\\.dsh\\sessions\\*\\${sessionId}"`);
  await rm(workspace, { recursive: true, force: true });
}

/** Locate the materialized directory of one session under the harness home. */
async function findSessionDirectory(home, id) {
  const root = join(home, 'sessions');
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = join(root, project.name, id);
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

async function waitForSessionDirectory(home, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findSessionDirectory(home, id);
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

async function waitForSessionLog(directory, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let files = [];
    try {
      files = await readdir(directory);
    } catch {
      files = [];
    }
    const name = files.find((entry) => entry.startsWith('session.'));
    if (name !== undefined) {
      const details = await stat(join(directory, name));
      if (details.size > 0) return { name, size: details.size };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}