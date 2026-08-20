import { createInterface } from 'node:readline';

interface RequestMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  let message: RequestMessage;
  try {
    message = JSON.parse(line) as RequestMessage;
  } catch {
    return;
  }
  if (typeof message.id !== 'number' || typeof message.method !== 'string') return;

  switch (message.method) {
    case 'initialize':
      respond(message.id, { protocolVersion: 1 });
      break;
    case 'thread/list':
      notify('fixture/ignored', { value: true });
      respond(message.id, { data: [{ id: 'thread-fixture' }] });
      break;
    case 'thread/resume':
      respond(message.id, { thread: { id: message.params?.threadId } });
      break;
    case 'turn/start':
      respond(message.id, { turn: { id: 'turn-fixture' } });
      setImmediate(() => notify('turn/completed', { turn: { id: 'turn-fixture' } }));
      break;
    default:
      process.stdout.write(`${JSON.stringify({ id: message.id, error: { message: 'unknown method' } })}\n`);
  }
});

function respond(id: number, result: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method: string, params: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
