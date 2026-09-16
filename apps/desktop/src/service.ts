import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WatchdogRecord {
  readonly pid: number;
  readonly port: string;
  readonly entryPath: string;
}

export function resolveStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (localAppData === undefined || localAppData.length === 0) {
    throw new Error('LOCALAPPDATA is required to locate the watchdog state directory');
  }
  return join(localAppData, 'ai-cli-bypass', 'continuation');
}

export async function readWatchdogRecord(stateDirectory: string): Promise<WatchdogRecord | null> {
  let text: string;
  try {
    text = await readFile(join(stateDirectory, 'watchdog.pid.json'), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = Number(record.pid);
  const port = String(record.port ?? '');
  if (!Number.isInteger(pid) || pid <= 0 || !/^\d{2,5}$/u.test(port)) return null;
  return {
    pid,
    port,
    entryPath: typeof record.entryPath === 'string' ? record.entryPath : '',
  };
}

export function watchdogOrigin(port: string | number): string {
  return `http://127.0.0.1:${String(port)}`;
}

export async function waitForHealth(
  origin: string,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 250;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${origin}/api/health`);
      if (response.ok) return true;
    } catch {
      // The service is still starting; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}
