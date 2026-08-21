import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuditStore } from './store/audit-store.js';
import { ConfigStore } from './store/config-store.js';
import { WatchdogHttpServer, type SessionController } from './server/http-server.js';
import { WatchdogController } from './runtime/watchdog-controller.js';
import { WatchdogInstallation } from './lifecycle/installation.js';
import { ClaudeLeaseStore } from './claude/lease-store.js';
import {
  CLAUDE_HOOK_OWNER,
  ClaudeHookInstallation,
} from './claude/hook-installation.js';

export interface WatchdogProcessOptions {
  readonly stateDirectory?: string;
  readonly host?: string;
  readonly port?: number;
  readonly staticDirectory?: string;
  readonly claudeSettingsPath?: string;
}

export interface WatchdogProcess {
  readonly server: WatchdogHttpServer;
  readonly pidFile: string;
  readonly claudeHook: ClaudeHookInstallation;
  stop(): Promise<void>;
}

/** Starts the local management service. Discovery/transport adapters plug in through SessionController. */
export async function startWatchdogProcess(
  options: WatchdogProcessOptions = {},
  sessions?: SessionController,
): Promise<WatchdogProcess> {
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  await mkdir(stateDirectory, { recursive: true });
  const configStore = new ConfigStore(join(stateDirectory, 'config.json'));
  const auditStore = new AuditStore(join(stateDirectory, 'audit.jsonl'));
  const claudeLeasePath = join(stateDirectory, 'claude-leases.json');
  const claudeLeaseStore = new ClaudeLeaseStore(claudeLeasePath);
  const claudeHook = new ClaudeHookInstallation({
    settingsPath: options.claudeSettingsPath ?? defaultClaudeSettingsPath(),
    stateDirectory,
    hookCommand: buildClaudeHookCommand(claudeLeasePath),
    commandTimeoutMs: async () => (await configStore.load()).tools.claude.stopHook.commandTimeoutMs,
  });
  const installation = new WatchdogInstallation({
    stateDirectory,
    repositoryRoot: defaultRepositoryRoot(),
  });
  const existingConfig = await configStore.load();
  if (process.env.WATCHDOG_DRY_RUN === '1' && !existingConfig.dryRun) {
    await configStore.save({ ...existingConfig, dryRun: true });
  }
  let controller: WatchdogController | null = null;
  let server: WatchdogHttpServer;
  const sessionController = sessions ?? (controller = new WatchdogController({
    configStore,
    auditStore,
    claudeLeaseStore,
    claudeHookInstalled: async () => (await claudeHook.status()).installed,
    publish: (event, data) => server?.publish(event, data),
  }));
  server = new WatchdogHttpServer({
    configStore,
    auditStore,
    sessions: sessionController,
    status: () => controller?.status() ?? { lastPollAtMs: null },
    host: options.host ?? '127.0.0.1',
    port: options.port ?? readPort(process.env.WATCHDOG_PORT),
    staticDirectory: options.staticDirectory ?? process.env.WATCHDOG_STATIC_DIR ?? defaultStaticDirectory(),
  });
  let uninstallProcess: (() => Promise<void>) | null = null;
  server.setLifecycle({
    ...(controller === null ? {} : {
      start: () => controller?.start(),
      stop: () => controller?.stop(),
    }),
    install: async () => { await installation.install(); },
    startupStatus: async () => installation.startupStatus(),
    installStartup: async () => {
      const config = await configStore.load();
      await installation.installStartup({ dryRun: config.dryRun, port: Number(new URL(server.url()).port) });
    },
    uninstallStartup: async () => { await installation.uninstallStartup(); },
    uninstall: async () => {
      await controller?.quiesce();
      try {
        await claudeLeaseStore.clearAll();
        const hookStatus = await claudeHook.uninstall();
        if (hookStatus.manualReviewRequired) {
          throw new TypeError(hookStatus.lastError ?? 'Claude Hook uninstall requires manual review');
        }
        await installation.install();
        await installation.uninstallStartup();
        installation.scheduleUninstall(
          async () => { await uninstallProcess?.(); },
          () => process.exit(0),
        );
      } catch (error) {
        if (controller !== null) void controller.start().catch(() => undefined);
        throw error;
      }
    },
  });
  await server.start();
  const pidFile = join(stateDirectory, 'watchdog.pid.json');
  try {
    await writeFile(
      pidFile,
      `${JSON.stringify({
        pid: process.pid,
        port: new URL(server.url()).port,
        startedAtMs: Date.now(),
        processStartedAtMs: Date.now() - Math.round(process.uptime() * 1_000),
        executablePath: resolve(process.execPath),
        entryPath: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
        entry: 'watchdog',
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    await controller?.stop();
    await server.stop();
    throw error;
  }

  // Publish the PID record before the first potentially slow WMI/SQLite poll.
  if (controller !== null) await controller.start();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await controller?.stop();
    await server.stop();
    const { rm } = await import('node:fs/promises');
    await rm(pidFile, { force: true });
  };
  uninstallProcess = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
    const { rm } = await import('node:fs/promises');
    await rm(pidFile, { force: true });
  };
  return { server, pidFile, claudeHook, stop };
}

function defaultStateDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.trim().length > 0) {
    return join(localAppData, 'ai-cli-bypass', 'continuation');
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ai-cli-bypass', 'continuation');
}

function defaultClaudeSettingsPath(): string {
  const configured = process.env.WATCHDOG_CLAUDE_SETTINGS_PATH;
  if (configured !== undefined && configured.trim().length > 0) return configured;
  return join(homedir(), '.claude', 'settings.json');
}

function buildClaudeHookCommand(leaseFile: string): string {
  const moduleDirectory = resolve(fileURLToPath(import.meta.url), '..');
  const hookCli = resolve(moduleDirectory, 'claude', 'stop-hook-cli.js');
  return [
    quoteCommandArgument(resolve(process.execPath)),
    quoteCommandArgument(hookCli),
    '--lease-file',
    quoteCommandArgument(resolve(leaseFile)),
    '--owner',
    CLAUDE_HOOK_OWNER,
  ].join(' ');
}

function quoteCommandArgument(value: string): string {
  if (value.length === 0 || /[\0\r\n"]/u.test(value)) {
    throw new Error('Claude Hook command path contains unsupported characters');
  }
  return `"${value}"`;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 48_920;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 48_920;
}

async function runCli(): Promise<void> {
  const processHandle = await startWatchdogProcess();
  const shutdown = () => void processHandle.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`watchdog listening at ${processHandle.server.url()}\n`);
}

function defaultStaticDirectory(): string | undefined {
  const moduleDirectory = resolve(fileURLToPath(import.meta.url), '..');
  const candidate = resolve(moduleDirectory, '../../../web/dist');
  return existsSync(candidate) ? candidate : undefined;
}

function defaultRepositoryRoot(): string {
  const moduleDirectory = resolve(fileURLToPath(import.meta.url), '..');
  return resolve(moduleDirectory, '../../../..');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { defaultStateDirectory };
