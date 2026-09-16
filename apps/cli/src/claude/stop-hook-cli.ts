import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { CLAUDE_HOOK_OWNER } from './hook-installation.js';
import { ClaudeLeaseStore } from './lease-store.js';
import { decideClaudeStopHook, type ClaudeStopHookDecision } from './stop-hook.js';

const MAX_STDIN_BYTES = 64 * 1024;

export async function runClaudeStopHookCli(
  argv: readonly string[] = process.argv.slice(2),
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  let decision: ClaudeStopHookDecision = {};
  try {
    const leaseFile = parseLeaseFile(argv);
    if (leaseFile !== null) {
      const document = await readJsonDocument(input);
      decision = await decideClaudeStopHook(new ClaudeLeaseStore(leaseFile), document);
    }
  } catch {
    decision = {};
  }
  output.write(`${JSON.stringify(decision)}\n`);
}

function parseLeaseFile(argv: readonly string[]): string | null {
  const ownerIsValid = argv.length === 2 ||
    (argv.length === 4 && argv[2] === '--owner' && argv[3] === CLAUDE_HOOK_OWNER);
  if (!ownerIsValid || argv[0] !== '--lease-file') return null;
  const value = argv[1];
  return value !== undefined && value.trim().length > 0 ? value : null;
}

async function readJsonDocument(input: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    size += bytes.length;
    if (size > MAX_STDIN_BYTES) throw new RangeError('Claude Stop Hook input is too large');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return JSON.parse(text) as unknown;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runClaudeStopHookCli().catch(() => {
    process.stdout.write('{}\n');
  });
}
