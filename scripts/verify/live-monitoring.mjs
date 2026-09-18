// Prove that the watchdog actually monitors the agents running on this machine.
//
// The expectations are computed independently from the operating system — the
// DeepSeek Harness session index and the same-user process table — and then
// compared against what the running service reports on its local API. A service
// that answers /api/health but lists nothing fails this check.
//
// Usage: node scripts/verify/live-monitoring.mjs [--dry-run] [--timeout-ms N]
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { startWatchdogProcess } = await import(
  new URL('../../apps/cli/dist/src/index.js', import.meta.url).href
);
const { scanDshSessions, isLiveDshSession, dshSessionActivityMs } = await import(
  new URL('../../apps/cli/dist/src/association/dsh.js', import.meta.url).href
);
const { groupProcesses } = await import(
  new URL('../../apps/cli/dist/src/process/discovery.js', import.meta.url).href
);
const { WindowsProcessProvider } = await import(
  new URL('../../apps/cli/dist/src/process/process-provider.js', import.meta.url).href
);
const { defaultConfig } = await import(
  new URL('../../apps/cli/dist/src/domain/config.js', import.meta.url).href
);

const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh');
const failures = [];
const notes = [];

function check(condition, message) {
  if (condition) {
    notes.push(`ok    ${message}`);
  } else {
    failures.push(message);
    notes.push(`FAIL  ${message}`);
  }
}

async function fetchJson(origin, path) {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return await response.json();
}

async function waitForSession(origin, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let list = [];
  while (Date.now() < deadline) {
    const body = await fetchJson(origin, '/api/sessions');
    list = Array.isArray(body.sessions) ? body.sessions : [];
    if (list.some(predicate)) return list;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return list;
}

// --- independent expectations -------------------------------------------------
const records = await new WindowsProcessProvider({ includeProcessIds: [process.pid] })
  .listProcesses();
const groups = groupProcesses(records, { currentProcessId: process.pid, sameUserOnly: true });
const codexRoots = groups.filter((group) => group.tool === 'codex').map((group) => group.rootPid);
const dshHosts = groups.filter((group) => group.tool === 'dsh');
const oldestHostStart = dshHosts.reduce((oldest, host) => {
  if (host.creationTimeMs === null) return oldest;
  return oldest === null ? host.creationTimeMs : Math.min(oldest, host.creationTimeMs);
}, null);
const dshSessions = (await scanDshSessions({ homeDirectory: dshHome })).filter((session) =>
  isLiveDshSession(session, {
    nowMs: Date.now(),
    windowMs: defaultConfig.tools.dsh.sessionWindowMs,
    hostStartedAtMs: oldestHostStart,
  }));

console.log(`machine agents: ${codexRoots.length} codex root process(es), ` +
  `${dshHosts.length} DeepSeek Harness host(s), ${dshSessions.length} live harness session(s)`);
for (const session of dshSessions) {
  console.log(`  harness ${session.sessionId} cwd=${session.cwd} ` +
    `runningStep=${session.turnOpen} ` +
    `ageSec=${Math.round((Date.now() - (dshSessionActivityMs(session) ?? Date.now())) / 1_000)}`);
}

if (codexRoots.length === 0 && dshSessions.length === 0) {
  console.log('no local agent is running; nothing to verify');
  process.exit(0);
}

// --- run the service ----------------------------------------------------------
const scratch = await mkdtemp(join(tmpdir(), 'selbstlauf-live-verify-'));
// The service refuses to own a state directory outside its own boundary.
const stateDirectory = join(scratch, 'ai-cli-bypass', 'continuation');
process.env.WATCHDOG_DRY_RUN = '1';
let handle = null;
try {
  handle = await startWatchdogProcess({
    stateDirectory,
    host: '127.0.0.1',
    port: 0,
    claudeSettingsPath: join(scratch, '.claude', 'settings.json'),
  });
  const origin = handle.server.url().replace(/\/$/u, '');
  console.log(`watchdog listening at ${origin} (state ${stateDirectory})`);

  const health = await fetchJson(origin, '/api/health');
  check(health.watchdogRunning === true, 'the watchdog reports itself running');
  check(health.dryRun === true, 'the verification run stays in dry-run mode');

  const wanted = [
    ...codexRoots.map((pid) => (session) => session.tool === 'codex' && session.rootPid === pid),
    ...dshSessions.map((session) => (entry) => entry.id === `dsh:${session.sessionId}`),
  ];
  let sessions = [];
  const deadline = Date.now() + Number(readOption('--timeout-ms') ?? 120_000);
  for (const predicate of wanted) {
    sessions = await waitForSession(origin, predicate, Math.max(5_000, deadline - Date.now()));
  }
  sessions = (await fetchJson(origin, '/api/sessions')).sessions ?? [];

  for (const pid of codexRoots) {
    const row = sessions.find((session) => session.tool === 'codex' && session.rootPid === pid);
    check(Boolean(row), `codex PID ${pid} is discovered as a watched session`);
    if (row) check(row.alive === true, `codex PID ${pid} is reported alive`);
  }

  for (const session of dshSessions) {
    const row = sessions.find((entry) => entry.id === `dsh:${session.sessionId}`);
    check(Boolean(row), `harness session ${session.sessionId} is discovered as its own row`);
    if (!row) continue;
    check(row.tool === 'dsh', `harness session ${session.sessionId} is reported as the dsh tool`);
    check(row.alive === true, `harness session ${session.sessionId} is reported alive`);
    check(
      row.sessionCwd === session.cwd,
      `harness session ${session.sessionId} reports workspace ${session.cwd}`,
    );
    check(
      row.runningTurn === session.turnOpen,
      `harness session ${session.sessionId} reports runningStep=${session.turnOpen}`,
    );
    check(
      row.transport === 'monitor-only' || row.transport === 'dsh-web',
      `harness session ${session.sessionId} reports a harness transport`,
    );
  }

  // Every watched session must say where it runs, and a harness row must name
  // the browser interface rather than the console that launched it.
  const live = sessions.filter((session) => session.alive);
  const withoutHost = live.filter((session) => !session.host);
  check(
    withoutHost.length === 0,
    `every live session names where it runs (missing: ${withoutHost.map((s) => s.id).join(', ') || 'none'})`,
  );
  for (const session of live.filter((entry) => entry.host)) {
    check(
      typeof session.host.label === 'string' && session.host.label.length > 0 &&
      typeof session.host.category === 'string',
      `${session.id} runs in ${session.host.label} [${session.host.category}]`,
    );
  }
  for (const row of live.filter((entry) => entry.tool === 'dsh' && entry.host)) {
    check(
      row.host.category === 'browser',
      `${row.id} is located in a browser interface (${row.host.label})`,
    );
  }

  const { events } = await fetchJson(origin, '/api/audit?limit=500');
  const harnessEvents = events.filter((event) => event.tool === 'dsh');
  check(
    harnessEvents.length === 0 || dshSessions.length > 0,
    'harness events only exist while a harness session is live',
  );
  check(
    !events.some((event) => event.type === 'injection'),
    'the dry run wrote nothing into any process',
  );
  check(
    events.some((event) => event.type === 'decision' || event.type === 'activity'),
    'the watchdog recorded at least one activity or decision event',
  );

  console.log('\n' + notes.join('\n'));
  if (failures.length > 0) {
    console.error(`\nlive monitoring verification failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nlive monitoring verification passed');
  }
} finally {
  await handle?.stop();
  await rm(scratch, { recursive: true, force: true });
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}