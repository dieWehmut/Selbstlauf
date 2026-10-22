import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// A real process that records its own IO in Claude's transcript shape for the detail-page integration test.
const path = process.argv[2]!;
const entry = (type: 'user' | 'assistant', text: string) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n';
writeFileSync(path, JSON.stringify({ cwd: process.cwd(), sessionId: 'recorded-agent-fixture' }) + '\n' + entry('assistant', '受控终端已就绪（真实 TTY）。'));
process.stdout.write(`READY ${process.stdin.isTTY}\n`);
createInterface({ input: process.stdin }).on('line', (text) => {
  const reply = `实际回复：${text}`;
  appendFileSync(path, entry('user', text) + entry('assistant', reply));
  process.stdout.write(`${reply}\n`);
});
