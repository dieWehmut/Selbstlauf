import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { RemoteGateway, replaceAtomically, type RemotePairingView } from './remote-gateway.js';

export interface RemoteControlSettings {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly name: string;
}
export interface RemoteControlView extends RemoteControlSettings {
  readonly url?: string;
  readonly pairing?: RemotePairingView;
  readonly devices: ReturnType<RemoteGateway['pairedDevices']>;
  readonly error?: string;
}
const DEFAULTS: RemoteControlSettings = { enabled: false, host: '127.0.0.1', port: 48_921, name: 'Selbstlauf' };

/** Owns the same service's gateway. Explicit settings survive ordinary shutdown. */
export class RemoteControlManager {
  public gateway: RemoteGateway | undefined;
  private settings = DEFAULTS;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private started = false;
  private startupError: string | undefined;
  private deviceStatePath: string;

  public constructor(private readonly options: {
    localBaseUrl: string;
    settingsPath: string;
    deviceStatePath: string;
  }) {
    this.deviceStatePath = resolve(options.deviceStatePath);
  }

  public start(initial?: Partial<Omit<RemoteControlSettings, 'enabled'>>): Promise<void> {
    return this.serial(async () => {
      if (this.closing || this.started || this.gateway !== undefined) return;
      let stored: RemoteControlSettings = DEFAULTS;
      try {
        const document: unknown = JSON.parse(await readFile(this.options.settingsPath, 'utf8'));
        const settings = parseSettings(document);
        const path = (document as { deviceStatePath?: unknown }).deviceStatePath;
        if (path !== undefined && (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/u.test(path))) {
          throw new TypeError('remote device state path must be an absolute file path');
        }
        if (initial === undefined && typeof path === 'string') this.deviceStatePath = path;
        stored = settings;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.startupError = error instanceof Error ? error.message : String(error);
      }
      if (this.closing) return;
      this.settings = stored;
      if (initial !== undefined) {
        const settings = parseSettings({ ...DEFAULTS, ...Object.fromEntries(Object.entries(initial).filter(([, value]) => value !== undefined)), version: 1, enabled: true });
        await this.applySettings(settings);
      } else if (stored.enabled) {
        const gateway = this.makeGateway(stored);
        try {
          await gateway.start();
          if (this.closing) await gateway.stop();
          else this.gateway = gateway;
        } catch (error) { this.startupError = error instanceof Error ? error.message : String(error); }
      }
      this.started = true;
    });
  }

  public view(): RemoteControlView {
    return {
      ...this.settings,
      enabled: this.gateway !== undefined,
      ...(this.gateway === undefined ? {} : { url: this.gateway.url(), pairing: this.gateway.pairingCode() }),
      devices: this.gateway?.pairedDevices() ?? [],
      ...(this.startupError === undefined ? {} : { error: this.startupError }),
    };
  }

  public enable(value: unknown): Promise<RemoteControlView> {
    return this.serial(async () => {
      if (this.closing) throw new RemoteControlError(503, 'remote control service is closing');
      const next = parseSettings({ ...(value as object), version: 1, enabled: true });
      return this.applySettings(next);
    });
  }

  public disable(): Promise<RemoteControlView> {
    return this.serial(async () => {
      if (this.closing) throw new RemoteControlError(503, 'remote control service is closing');
      const previous = this.gateway;
      this.gateway = undefined;
      await previous?.stop();
      try {
        const next = { ...this.settings, enabled: false };
        await this.save(next);
        this.settings = next;
        this.startupError = undefined;
        return this.view();
      } catch (error) {
        await this.restore(previous);
        throw error;
      }
    });
  }

  public refreshPairing(): Promise<RemoteControlView> {
    return this.serial(async () => {
      this.requiredGateway().rotatePairingCode();
      return this.view();
    });
  }

  public revokeDevice(id: string): Promise<RemoteControlView> {
    return this.serial(async () => {
      if (!(await this.requiredGateway().revokeDevice(id))) throw new RemoteControlError(404, 'paired device not found');
      return this.view();
    });
  }

  public async stop(): Promise<void> {
    this.closing = true;
    await this.serial(async () => {
      const gateway = this.gateway;
      this.gateway = undefined;
      await gateway?.stop();
    });
  }

  private requiredGateway(): RemoteGateway {
    if (this.closing) throw new RemoteControlError(503, 'remote control service is closing');
    if (this.gateway === undefined) throw new RemoteControlError(409, 'mobile remote control is not enabled');
    return this.gateway;
  }

  private async applySettings(next: RemoteControlSettings): Promise<RemoteControlView> {
    const previous = this.gateway;
    if (previous !== undefined && sameSettings(next, this.settings)) return this.view();
    this.gateway = undefined;
    await previous?.stop();
    const gateway = this.makeGateway(next);
    try {
      if (this.closing) throw new RemoteControlError(503, 'remote control service is closing');
      await gateway.start();
      if (this.closing) throw new RemoteControlError(503, 'remote control service is closing');
      await this.save(next);
      this.settings = next;
      this.gateway = gateway;
      this.startupError = undefined;
      return this.view();
    } catch (error) {
      await gateway.stop();
      await this.restore(previous);
      if (['EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new RemoteControlError(409, error instanceof Error ? error.message : 'remote listener could not start');
      }
      throw error;
    }
  }

  private async restore(gateway: RemoteGateway | undefined): Promise<void> {
    if (gateway === undefined || this.closing) return;
    try { await gateway.start(); this.gateway = gateway; }
    catch (error) {
      this.startupError = error instanceof Error ? error.message : String(error);
      throw new RemoteControlError(409, `could not restore the previous remote listener: ${this.startupError}`);
    }
  }

  private makeGateway(settings: RemoteControlSettings): RemoteGateway {
    return new RemoteGateway({ ...settings, localBaseUrl: this.options.localBaseUrl, statePath: this.deviceStatePath });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async save(settings: RemoteControlSettings): Promise<void> {
    const temporary = `${this.options.settingsPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, ...settings, deviceStatePath: this.deviceStatePath }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await replaceAtomically(temporary, this.options.settingsPath);
    } finally { await rm(temporary, { force: true }); }
  }
}

function sameSettings(left: RemoteControlSettings, right: RemoteControlSettings): boolean {
  return left.enabled === right.enabled && left.host === right.host && left.port === right.port && left.name === right.name;
}

function parseSettings(value: unknown): RemoteControlSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('remote settings must be an object');
  const settings = value as Record<string, unknown>;
  if (settings.version !== 1 || typeof settings.enabled !== 'boolean' || typeof settings.host !== 'string' ||
      !(isIP(settings.host) || settings.host === 'localhost') ||
      !Number.isInteger(settings.port) || Number(settings.port) < 0 || Number(settings.port) > 65_535 ||
      typeof settings.name !== 'string' || !settings.name.trim() || settings.name.length > 80 || /[\0\r\n]/u.test(settings.name)) {
    throw new TypeError('remote settings require an IP bind address, port 0–65535, and a single-line name');
  }
  return { enabled: settings.enabled, host: settings.host, port: Number(settings.port), name: settings.name.trim() };
}

export class RemoteControlError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}
