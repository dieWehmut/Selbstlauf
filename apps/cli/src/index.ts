import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuditStore } from './store/audit-store.js';
import { ConfigStore } from './store/config-store.js';
import { WatchdogHttpServer, type SessionController } from './server/http-server.js';
import { RemoteGateway } from './server/remote-gateway.js';
import { WatchdogController } from './runtime/watchdog-controller.js';
import { WatchdogInstallation } from './lifecycle/installation.js';
import { ClaudeLeaseStore } from './claude/lease-store.js';
import { CodexConfigProfiles } from './codex/profile-store.js';
import { EnvironmentCheck } from './environment/environment-check.js';
import { ToolUpgrader } from './environment/upgrade.js';
import { ManagedAgentSessions } from './agents/managed-sessions.js';
import type { AgentPtyBackend } from './agents/types.js';
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
  readonly codexConfigPath?: string;
  readonly ptyBackend?: AgentPtyBackend;
  readonly agentWorkingDirectory?: string;
  /** Enables the authenticated mobile facade. Omit to keep every API loopback-only. */
  readonly remote?: {
    readonly host?: string;
    readonly port?: number;
    readonly name?: string;
    readonly statePath?: string;
  };
}

export interface WatchdogProcess {
  readonly server: WatchdogHttpServer;
  readonly remoteGateway?: RemoteGateway;
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
  const codexProfiles = new CodexConfigProfiles({
    configPath: options.codexConfigPath ?? defaultCodexConfigPath(),
  });
  // One shared check so the panel reuses its scan across browsers and polls.
  const environment = new EnvironmentCheck();
  // The upgrader refreshes that same check, so the panel reflects the install
  // that just finished instead of the version it replaced.
  const upgrader = new ToolUpgrader({ check: environment });

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
  const agents = new ManagedAgentSessions({
    backend: options.ptyBackend,
    defaultCwd: options.agentWorkingDirectory,
    onSessionsChanged: () => server?.publish('agents', { action: 'changed' }),
  });
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
    agents,
    status: () => controller?.status() ?? { lastPollAtMs: null },
    host: options.host ?? '127.0.0.1',
    port: options.port ?? readPort(process.env.WATCHDOG_PORT),
    staticDirectory: options.staticDirectory ?? process.env.WATCHDOG_STATIC_DIR ?? defaultStaticDirectory(),
    codexProfiles,
    environment,
    upgrader,
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
    claudeHookStatus: () => claudeHook.status(),
    installClaudeHook: async () => {
      await claudeLeaseStore.clearAll();
      return claudeHook.install();
    },
    uninstallClaudeHook: async () => {
      await claudeLeaseStore.clearAll();
      return claudeHook.uninstall();
    },
    disableClaudeHook: async () => {
      await claudeLeaseStore.clearAll();
      return claudeHook.status();
    },
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
  let remoteGateway: RemoteGateway | undefined;
  try {
    if (options.remote !== undefined) {
      remoteGateway = new RemoteGateway({
        localBaseUrl: server.url(),
        statePath: options.remote.statePath ?? join(stateDirectory, 'remote-devices.json'),
        host: options.remote.host,
        port: options.remote.port,
        name: options.remote.name,
      });
      await remoteGateway.start();
    }
  } catch (error) {
    await agents.stop();
    await server.stop();
    throw error;
  }
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
        ...(remoteGateway === undefined ? {} : { remotePort: new URL(remoteGateway.url()).port }),
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    await remoteGateway?.stop();
    await controller?.stop();
    await agents.stop();
    await server.stop();
    throw error;
  }

  // Publish the PID record before the first potentially slow WMI/SQLite poll.
  if (controller !== null) await controller.start();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await remoteGateway?.stop();
    await controller?.stop();
    await agents.stop();
    await server.stop();
    const { rm } = await import('node:fs/promises');
    await rm(pidFile, { force: true });
  };
  uninstallProcess = async () => {
    if (stopped) return;
    stopped = true;
    await remoteGateway?.stop();
    await agents.stop();
    await server.stop();
    const { rm } = await import('node:fs/promises');
    await rm(pidFile, { force: true });
  };
  return {
    server,
    pidFile,
    claudeHook,
    ...(remoteGateway === undefined ? {} : { remoteGateway }),
    stop,
  };
}

function defaultStateDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.trim().length > 0) {
    return join(localAppData, 'ai-cli-bypass', 'continuation');
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ai-cli-bypass', 'continuation');
}

function defaultCodexConfigPath(): string {
  const codexHome = readText(process.env.CODEX_HOME) ?? join(homedir(), '.codex');
  return join(codexHome, 'config.toml');
}

function readText(value: string | undefined): string | null {
  return value === undefined || value.trim().length === 0 ? null : value;
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

export interface ParsedWatchdogArguments {
  readonly help: boolean;
  readonly options: WatchdogProcessOptions;
}

export function parseWatchdogArguments(argv: readonly string[]): ParsedWatchdogArguments {
  let remote = false;
  let remoteHost: string | undefined;
  let remotePort: number | undefined;
  let remoteName: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--remote') {
      remote = true;
    } else if (argument === '--remote-bind') {
      remote = true;
      remoteHost = requiredArgument(argv, ++index, argument);
    } else if (argument === '--remote-port') {
      remote = true;
      remotePort = parseCliPort(requiredArgument(argv, ++index, argument), argument);
    } else if (argument === '--remote-name') {
      remote = true;
      remoteName = requiredArgument(argv, ++index, argument);
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  return {
    help,
    options: remote ? {
      remote: {
        ...(remoteHost === undefined ? {} : { host: remoteHost }),
        ...(remotePort === undefined ? {} : { port: remotePort }),
        ...(remoteName === undefined ? {} : { name: remoteName }),
      },
    } : {},
  };
}

async function runCli(): Promise<void> {
  const parsed = parseWatchdogArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(watchdogUsage());
    return;
  }
  const processHandle = await startWatchdogProcess(parsed.options);
  const shutdown = () => void processHandle.stop().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`watchdog listening at ${processHandle.server.url()}\n`);
  if (processHandle.remoteGateway !== undefined) {
    const pairing = processHandle.remoteGateway.pairingCode();
    process.stdout.write([
      `remote control listening at ${processHandle.remoteGateway.url()}`,
      `pairing code: ${pairing.code}`,
      `pairing code expires at: ${new Date(pairing.expiresAtMs).toISOString()}`,
      '',
    ].join('\n'));
  }
}

function requiredArgument(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function parseCliPort(value: string, option: string): number {
  if (!/^\d{1,5}$/u.test(value)) throw new TypeError(`${option} requires a port between 0 and 65535`);
  const port = Number(value);
  if (port > 65_535) throw new TypeError(`${option} requires a port between 0 and 65535`);
  return port;
}

function watchdogUsage(): string {
  return [
    'Usage: watchdog [--remote] [--remote-bind HOST] [--remote-port PORT] [--remote-name NAME]',
    '',
    'Remote control is disabled by default and otherwise binds to 127.0.0.1:48921.',
    'Use --remote-bind 0.0.0.0 only on a trusted network and pair with the printed code.',
    '',
  ].join('\n');
}

function defaultStaticDirectory(): string | undefined {
  const moduleDirectory = resolve(fileURLToPath(import.meta.url), '..');
  return [
    // Repository layout: apps/cli/dist/src -> apps/web/dist
    resolve(moduleDirectory, '../../../web/dist'),
    // Packaged desktop layout: resources/service-dist/src -> resources/web-dist
    resolve(moduleDirectory, '../../web-dist'),
  ].find((candidate) => existsSync(candidate));
}

function defaultRepositoryRoot(): string {
  const moduleDirectory = resolve(fileURLToPath(import.meta.url), '..');
  // A repository checkout keeps this module in apps/cli/dist/src, four levels
  // below the root. A packaged install ships it as resources/service-dist/src,
  // where the root that also holds web-dist and scripts/continuation is only
  // two levels up, so the recorded root always matches the scripts that read it.
  const repositoryRoot = resolve(moduleDirectory, '../../../..');
  return existsSync(join(repositoryRoot, 'apps', 'cli', 'dist', 'src', 'index.js'))
    ? repositoryRoot
    : resolve(moduleDirectory, '../..');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { defaultStateDirectory };
