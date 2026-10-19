import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

process.stdout.write(`READY ${JSON.stringify({ tty: process.stdin.isTTY && process.stdout.isTTY, cwd: process.cwd(), args: process.argv.slice(2) })}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'quit') process.exit(7);
  if (line === 'size') process.stdout.write(`SIZE ${process.stdout.columns} ${process.stdout.rows}\n`);
  else if (line === 'child') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(`CHILD ${child.pid}\n`);
  } else process.stdout.write(`REPLY ${line}\n`);
});
