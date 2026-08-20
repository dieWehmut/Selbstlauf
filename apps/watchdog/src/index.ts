import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { AuditStore } from './store/audit-store.js';
import { ConfigStore } from './store/config-store.js';
import { WatchdogHttpServer, type SessionController } from './server/http-server.js';
import type { SessionSnapshot } from './domain/types.js';

export interface WatchdogProcessOptions {
  readonly stateDirectory?: string;
  readonly host?: string;
  readonly port?: number;
  readonly staticDirectory?: string;
}

export interface WatchdogProcess {
  readonly server: WatchdogHttpServer;
  readonly pidFile: string;
  stop(): Promise<void>;
}

/** Starts the local management service. Discovery/transport adapters plug in through SessionController. */
export async function startWatchdogProcess(
  options: WatchdogProcessOptions = {},
  sessions: SessionController = emptySessions(),
): Promise<WatchdogProcess> {
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  await mkdir(stateDirectory, { recursive: true });
  const configStore = new ConfigStore(join(stateDirectory, 'config.json'));
  const auditStore = new AuditStore(join(stateDirectory, 'audit.jsonl'));
  const existingConfig = await configStore.load();
  if (process.env.WATCHDOG_DRY_RUN === '1' && !existingConfig.dryRun) {
    await configStore.save({ ...existingConfig, dryRun: true });
  }
  const server = new WatchdogHttpServer({
    configStore,
    auditStore,
    sessions,
    host: options.host ?? '127.0.0.1',
    port: options.port ?? readPort(process.env.WATCHDOG_PORT),
    staticDirectory: options.staticDirectory ?? process.env.WATCHDOG_STATIC_DIR,
  });
  await server.start();
  const pidFile = join(stateDirectory, 'watchdog.pid.json');
  try {
    await writeFile(
      pidFile,
      `${JSON.stringify({ pid: process.pid, port: new URL(server.url()).port, startedAtMs: Date.now(), entry: 'watchdog' }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    await server.stop();
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
    const { rm } = await import('node:fs/promises');
    await rm(pidFile, { force: true });
  };
  return { server, pidFile, stop };
}

function defaultStateDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.trim().length > 0) {
    return join(localAppData, 'ai-cli-bypass', 'continuation');
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ai-cli-bypass', 'continuation');
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 48_920;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 48_920;
}

function emptySessions(): SessionController {
  const list = (): readonly SessionSnapshot[] => [];
  return {
    list,
    pause: async () => false,
    resume: async () => false,
    inject: async (_sessionId, prompt, dryRun) => ({ ok: false, prompt, dryRun, error: 'no session controller configured' }),
  };
}

async function runCli(): Promise<void> {
  const processHandle = await startWatchdogProcess();
  const shutdown = () => void processHandle.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`watchdog listening at ${processHandle.server.url()}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { defaultStateDirectory };
