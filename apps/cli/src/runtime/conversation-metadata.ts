import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const cache = new Map<string, { size: number; mtimeMs: number; ino: number; birthtimeMs: number; offset: number; value: { title?: string; runningTurn?: boolean } }>();

/** Read bounded metadata only; never retain or expose the transcript. */
export async function readConversationMetadata(path: string, tool: 'codex' | 'claude'): Promise<{ title?: string; runningTurn?: boolean }> {
  const info = await stat(path);
  const key = `${tool}:${path}`;
  const previous = cache.get(key);
  const sameFile = previous?.ino === info.ino && previous.birthtimeMs === info.birthtimeMs;
  if (sameFile && previous?.size === info.size && previous.mtimeMs === info.mtimeMs) return { ...previous.value };
  // Read history once; subsequent appends start at the last complete JSONL line.
  // Re-read a partial final line on the next poll rather than caching transcript text.
  const incremental = sameFile && previous !== undefined && info.size > previous.size;
  let offset = incremental ? previous.offset : 0;
  const input = createReadStream(path, { encoding: 'utf8', start: offset, end: Math.max(0, info.size - 1) });
  const result: { title?: string; runningTurn?: boolean } = incremental ? { ...previous.value } : {};
  const consume = (line: string) => {
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      if (!entry || typeof entry !== 'object') return;
      if (tool === 'codex' && entry.type === 'event_msg') {
        const type = entry.payload?.type;
        if (type === 'task_started' || type === 'turn_started') result.runningTurn = true;
        if (type === 'task_complete' || type === 'task_completed' || type === 'turn_complete' || type === 'turn_aborted') result.runningTurn = false;
      }
      if (tool === 'claude') {
        const title = entry.type === 'custom-title' ? entry.customTitle : entry.type === 'summary' ? entry.summary : undefined;
        if (typeof title === 'string' && title.trim()) result.title = title.trim().slice(0, 500);
        if (entry.type === 'user' && !entry.isMeta) result.runningTurn = true;
        if (entry.type === 'assistant') {
          const reason = entry.message?.stop_reason;
          if (reason === 'tool_use') result.runningTurn = true;
          if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'max_tokens') result.runningTurn = false;
        }
      }
  };
  try {
    let pending = '';
    for await (const chunk of input) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end + 1);
        offset += Buffer.byteLength(line);
        consume(line);
        pending = pending.slice(end + 1);
      }
    }
    if (pending) consume(pending);
    if (cache.size >= 128) cache.delete(cache.keys().next().value as string);
    cache.set(key, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, birthtimeMs: info.birthtimeMs, offset, value: result });
    return { ...result };
  } catch (error) { cache.delete(key); throw error; } finally { input.destroy(); }
}
