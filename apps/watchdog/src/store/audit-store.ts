import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '../domain/types.js';

const SECRET_PATTERNS: readonly RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /(?:sk|rk)-[a-z0-9_-]{8,}/gi,
  /(?:gh[pousr]|xox[baprs])-?[a-z0-9_-]{8,}/gi,
  /(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
];
const WINDOWS_ABSOLUTE_PATH = /(?:[a-z]:\\|\\\\)[^\s"']+/gi;
const UNIX_ABSOLUTE_PATH = /(?<![\w])\/(?:[^\s"']+\/)+[^\s"']*/g;

/** JSONL audit persistence with bounded, field-level redaction. */
export class AuditStore {
  public readonly path: string;
  private readonly maxEntries: number;
  private readonly events: AuditEvent[] = [];
  private loaded = false;

  public constructor(path: string, options: { readonly maxEntries?: number } = {}) {
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new TypeError('audit path must be a non-empty string');
    }
    this.path = path;
    this.maxEntries = options.maxEntries ?? 2_000;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
  }

  public async append(event: Omit<AuditEvent, 'id'> & { readonly id?: string }): Promise<AuditEvent> {
    await this.ensureLoaded();
    const redacted = redactAuditEvent({ ...event, id: event.id ?? randomUUID() });
    this.events.push(redacted);
    while (this.events.length > this.maxEntries) this.events.shift();
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(redacted)}\n`, { encoding: 'utf8', mode: 0o600 });
    return redacted;
  }

  public async list(limit = this.maxEntries): Promise<readonly AuditEvent[]> {
    await this.ensureLoaded();
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('limit must be a positive integer');
    return Object.freeze(this.events.slice(-limit));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const lines = (await readFile(this.path, 'utf8')).split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-this.maxEntries)) {
        try {
          const parsed = JSON.parse(line) as AuditEvent;
          if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
            this.events.push(redactAuditEvent(parsed));
          }
        } catch {
          // Ignore one damaged line; subsequent audit entries remain usable.
        }
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

export function redactAuditEvent(event: AuditEvent): AuditEvent {
  return {
    ...event,
    prompt: event.prompt === undefined ? undefined : redactString(event.prompt, true),
    details: event.details === undefined ? undefined : redactRecord(event.details),
  };
}

function redactRecord(value: Readonly<Record<string, boolean | number | string | null>>): Readonly<Record<string, boolean | number | string | null>> {
  const output: Record<string, boolean | number | string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = typeof entry === 'string' ? redactString(entry, false) : entry;
  }
  return output;
}

function redactString(value: string, preservePrompt: boolean): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]');
  if (!preservePrompt) {
    result = result.replace(WINDOWS_ABSOLUTE_PATH, '[redacted-path]');
    result = result.replace(UNIX_ABSOLUTE_PATH, '[redacted-path]');
  }
  return result;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}
