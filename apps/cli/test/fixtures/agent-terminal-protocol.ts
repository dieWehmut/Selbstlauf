// A real TUI protocol peer: startup must wait for the emulator's cursor-position reply.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let pending = '';
let queried = false;
process.stdout.write('\u001b[6n\u001b[?2004h');
process.stdin.on('data', (data: string) => {
  pending += data;
  if (!queried) {
    const answer = /\u001b\[\d+;\d+R/u.exec(pending);
    if (answer === null) return;
    pending = pending.slice(answer.index + answer[0].length);
    queried = true;
    process.stdout.write('QUERY_REPLIED\r\n');
  }
  while (pending.length > 0) {
    if (pending.startsWith('\u001b[200~')) {
      const end = pending.indexOf('\u001b[201~');
      if (end < 0) return;
      process.stdout.write(`PASTE ${JSON.stringify(pending.slice(6, end))}\r\n`);
      pending = pending.slice(end + 6);
    } else if (pending[0] === '\r') {
      process.stdout.write('SUBMITTED\r\n');
      pending = pending.slice(1);
    } else if (pending[0] === '\u0003') {
      process.stdout.write('INTERRUPTED\r\n');
      pending = pending.slice(1);
    } else {
      pending = pending.slice(1);
    }
  }
});
