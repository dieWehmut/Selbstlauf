import { open } from 'node:fs/promises';

export type SessionOutputSource = 'claude-jsonl' | 'codex-rollout' | 'dsh-projection' | 'gemini-json' | 'gemini-jsonl' | 'cursor-jsonl' | 'cursor-composer' | 'cursor-agent-host' | 'antigravity-projection';
export interface SessionOutputEntry {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly timestampMs: number | null;
}
export interface SessionOutput {
  readonly sessionId: string;
  readonly state: 'ready' | 'unavailable';
  readonly source: SessionOutputSource | null;
  readonly entries: readonly SessionOutputEntry[];
  readonly truncated: boolean;
  readonly reason?: string;
}

const TAIL_BYTES = 512 * 1024;
const PROJECTION_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 120;
const MAX_TEXT = 128 * 1024;

export function unavailableSessionOutput(sessionId: string, reason: string, source: SessionOutputSource | null = null): SessionOutput {
  return { sessionId, state: 'unavailable', source, entries: [], truncated: false, reason };
}

/** Paths come only from the controller's unique process/session association, never from the HTTP request. */
export async function readSessionOutput(sessionId: string, source: SessionOutputSource, path: string): Promise<SessionOutput> {
  try {
    const handle = await open(path, 'r');
    let text: string;
    let start = 0;
    try {
      const details = await handle.stat();
      if (!details.isFile()) return unavailableSessionOutput(sessionId, 'transcript-unreadable', source);
      if (source === 'dsh-projection' && details.size > PROJECTION_BYTES) {
        return unavailableSessionOutput(sessionId, 'projection-too-large', source);
      }
      start = source === 'dsh-projection' ? 0 : Math.max(0, details.size - TAIL_BYTES);
      const buffer = Buffer.alloc(details.size - start);
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, start + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      text = buffer.subarray(0, read).toString('utf8');
    } finally { await handle.close(); }

    const entries: SessionOutputEntry[] = [];
    if (source === 'dsh-projection') {
      const projection = record(JSON.parse(text));
      const rows = record(record(projection?.record)?.rows);
      const outline = record(record(rows?.turnOutline)?.val);
      if (outline === null || !Array.isArray(outline.turns)) {
        return unavailableSessionOutput(sessionId, 'projection-format-unsupported', source);
      }
      for (const value of outline.turns.slice(-MAX_ENTRIES)) {
        const turn = record(value);
        if (turn === null) continue;
        const key = `${String(turn.turn)}:${String(turn.seq)}`;
        add(entries, `${key}:user`, 'user', turn.prompt, null);
        add(entries, `${key}:assistant`, 'assistant', turn.response, null);
      }
      add(entries, 'draft', 'assistant', outline.draft, null);
      return limited(sessionId, source, entries, outline.turns.length > MAX_ENTRIES);
    }

    let position = start;
    const lines = text.split('\n');
    if (start > 0) position += Buffer.byteLength(lines.shift() ?? '') + 1;
    for (const line of lines) {
      const key = String(position);
      position += Buffer.byteLength(line) + 1;
      let item;
      try { item = record(JSON.parse(line)); } catch { continue; } // The process may be writing the final line.
      if (item === null) continue;
      const timestamp = time(item.timestamp);
      if (source === 'claude-jsonl' && (item.type === 'user' || item.type === 'assistant')) {
        const message = record(item.message);
        const toolResult = Array.isArray(message?.content) && message.content.some((part) => record(part)?.type === 'tool_result');
        add(entries, key, toolResult ? 'tool' : item.type, content(message?.content), timestamp);
      } else if (source === 'codex-rollout' && item.type === 'response_item') {
        const payload = record(item.payload);
        if (payload?.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
          add(entries, key, payload.role, content(payload.content), timestamp);
        } else if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
          add(entries, key, 'tool', content(payload.output), timestamp);
        }
      }
    }
    return limited(sessionId, source, entries, start > 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unavailableSessionOutput(sessionId, error instanceof SyntaxError ? 'transcript-invalid' : code === 'ENOENT' ? 'transcript-missing' : 'transcript-unreadable', source);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function content(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || depth > 2) return '';
  return value.map((part) => {
    const item = record(part);
    if (item === null) return '';
    if (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') return typeof item.text === 'string' ? item.text : '';
    if (item.type === 'tool_result') return content(item.content, depth + 1);
    return '';
  }).filter(Boolean).join('\n');
}
function add(entries: SessionOutputEntry[], id: string, role: SessionOutputEntry['role'], text: unknown, timestampMs: number | null): void {
  if (typeof text === 'string' && text.trim().length > 0) entries.push({ id, role, text, timestampMs });
}
function limited(sessionId: string, source: SessionOutputSource, entries: SessionOutputEntry[], truncated: boolean): SessionOutput {
  const result: SessionOutputEntry[] = [];
  let remaining = MAX_TEXT;
  for (const entry of entries.slice(-MAX_ENTRIES).reverse()) {
    if (remaining <= 0) { truncated = true; break; }
    let text = entry.text.slice(-remaining);
    if (text.length < entry.text.length && /^[\uDC00-\uDFFF]/u.test(text)) text = text.slice(1);
    if (text.length < entry.text.length) truncated = true;
    result.push({ ...entry, text });
    remaining -= text.length;
  }
  return { sessionId, state: 'ready', source, entries: result.reverse(), truncated: truncated || entries.length > MAX_ENTRIES };
}
