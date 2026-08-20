import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

/** The process fields emitted by windows-processes.ps1 after normalization. */
export interface RawProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly commandLine: string | null;
  readonly executablePath: string | null;
  readonly creationTimeMs: number | null;
  readonly userSid: string | null;
  /** Best-effort working directory extracted by the provider, if available. */
  readonly workingDirectory?: string | null;
}

interface WindowsProcessJsonRecord {
  readonly pid: unknown;
  readonly parentPid: unknown;
  readonly name: unknown;
  readonly commandLine: unknown;
  readonly executablePath: unknown;
  readonly creationDate: unknown;
  readonly userSid: unknown;
  readonly workingDirectory: unknown;
}

export type ProcessCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<string>;

export interface WindowsProcessProviderOptions {
  readonly powershellPath?: string;
  readonly scriptPath?: string;
  readonly includeExecutableNames?: readonly string[];
  readonly runCommand?: ProcessCommandRunner;
}

export interface ProcessProvider {
  listProcesses(): Promise<RawProcessRecord[]>;
}

const execFileAsync = promisify(execFile);

async function runPowerShell(
  executable: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await execFileAsync(executable, [...args], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Windows process provider failed: ${message}`);
  }
}

function defaultScriptPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(moduleDirectory, 'windows-processes.ps1');
  if (existsSync(sibling)) {
    return sibling;
  }

  // tsc emits this module under dist/src/process while the PowerShell asset
  // intentionally stays beside the source so packaging cannot execute an
  // unexpectedly generated script.
  return resolve(moduleDirectory, '../../../src/process/windows-processes.ps1');
}

function asRecord(value: unknown, index: number): WindowsProcessJsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Process record ${index} must be an object`);
  }
  return value as WindowsProcessJsonRecord;
}

function requiredInteger(value: unknown, field: string, index: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Process record ${index} has invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string, index: number): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Process record ${index} has invalid ${field}`);
  }
  return value;
}

function parseDmtfDate(value: string): number | null {
  const dmtf = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/u.exec(value);
  if (dmtf) {
    const [, year, month, day, hour, minute, second, fraction, sign, offset] = dmtf;
    const localMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number((fraction ?? '000000').slice(0, 3)),
    );
    const offsetMs = Number(offset) * 60_000 * (sign === '+' ? 1 : -1);
    const timestamp = localMs - offsetMs;
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function nullableCreationDate(value: unknown, index: number): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Process record ${index} has invalid creationDate`);
  }
  const timestamp = parseDmtfDate(value);
  if (timestamp === null) {
    throw new Error(`Process record ${index} has invalid creationDate`);
  }
  return timestamp;
}

/** Parse the single JSON document emitted by the PowerShell provider. */
export function parseWindowsProcessJson(stdout: string): RawProcessRecord[] {
  const text = stdout.trim();
  if (text.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Windows process provider returned invalid JSON: ${message}`);
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((value, index) => {
    const record = asRecord(value, index);
    const name = nullableString(record.name, 'name', index);
    const workingDirectory = nullableString(record.workingDirectory, 'workingDirectory', index);
    if (name === null) {
      throw new Error(`Process record ${index} has invalid name`);
    }
    return {
      pid: requiredInteger(record.pid, 'pid', index),
      parentPid: requiredInteger(record.parentPid, 'parentPid', index),
      name,
      commandLine: nullableString(record.commandLine, 'commandLine', index),
      executablePath: nullableString(record.executablePath, 'executablePath', index),
      creationTimeMs: nullableCreationDate(record.creationDate, index),
      userSid: nullableString(record.userSid, 'userSid', index),
      ...(workingDirectory === null ? {} : { workingDirectory }),
    } satisfies RawProcessRecord;
  });
}

export class WindowsProcessProvider implements ProcessProvider {
  private readonly powershellPath: string;
  private readonly scriptPath: string;
  private readonly includeExecutableNames: readonly string[];
  private readonly runCommand: ProcessCommandRunner;

  constructor(options: WindowsProcessProviderOptions = {}) {
    this.powershellPath = options.powershellPath ?? 'powershell.exe';
    this.scriptPath = options.scriptPath ?? defaultScriptPath();
    this.includeExecutableNames = options.includeExecutableNames ?? [];
    this.runCommand = options.runCommand ?? runPowerShell;
  }

  async listProcesses(): Promise<RawProcessRecord[]> {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.scriptPath,
    ];
    for (const executableName of this.includeExecutableNames) {
      if (executableName.trim().length > 0) {
        args.push('-IncludeExecutableName', executableName);
      }
    }
    const stdout = await this.runCommand(this.powershellPath, args);
    return parseWindowsProcessJson(stdout);
  }
}
