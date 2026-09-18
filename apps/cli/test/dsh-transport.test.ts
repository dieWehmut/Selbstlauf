import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DshHostClient,
  DshWebSession,
  authorityOf,
  readBrowserSessionSecret,
} from '../src/dsh/web-host.js';
import { listLoopbackListenPorts } from '../src/dsh/loopback-ports.js';
import { DshWebTransport } from '../src/transport/dsh-transport.js';
import { defaultConfig } from '../src/domain/config.js';

const HOST_PID = 4321;
const SESSION_ID = 'session-3acd60b1-9056-4191-9070-8cd3563436a7';
const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

const SECRET = base64Url(SECRET_BYTES);

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface FakeHostOptions {
  readonly status?: number;
  readonly indexBody?: string;
  readonly rpc?: (call: RecordedCall) => Response;
}

function fakeHost(options: FakeHostOptions = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = { ...(init?.headers as Record<string, string> | undefined ?? {}) };
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const call: RecordedCall = { url, headers, body };
    calls.push(call);
    if (url.endsWith('/') && init?.method === undefined) {
      return new Response(options.indexBody ?? 'dsh web authentication required; reopen the URL printed by dsh web.\n', {
        status: options.status ?? 401,
      });
    }
    return options.rpc?.(call) ?? Response.json({
      type: 'server-response',
      rpcId: 'x',
      result: { ok: true, value: { accepted: true } },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function writeCredentials(home: string, secret = SECRET): Promise<void> {
  await writeFile(join(home, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-test',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secret}`,
    '',
  ].join('\n'), 'utf8');
}

test('readBrowserSessionSecret reads the harness record and refuses anything else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-cred-'));
  try {
    await writeCredentials(root);
    assert.equal(await readBrowserSessionSecret(root), SECRET);

    // A truncated secret, a missing record, and a missing file all fail closed.
    await writeCredentials(root, 'short');
    assert.equal(await readBrowserSessionSecret(root), null);
    await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrecords: {}\n', 'utf8');
    assert.equal(await readBrowserSessionSecret(root), null);
    assert.equal(await readBrowserSessionSecret(join(root, 'absent')), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshWebSession signs the authority-bound cookie the harness accepts', () => {
  const origin = 'http://127.0.0.1:3080';
  const session = DshWebSession.create(origin, SECRET, 1_700_000_000_000);
  assert.ok(session);
  assert.equal(session.audience, '127.0.0.1:3080');
  assert.equal(authorityOf(origin), '127.0.0.1:3080');

  const cookie = session.headers().cookie;
  const name = `dsh-auth-${base64Url(createHash('sha256').update('127.0.0.1:3080').digest())}`;
  assert.ok(cookie.startsWith(`${name}=v1.`));
  const [version, body, signature] = cookie.slice(name.length + 1).split('.');
  assert.equal(version, 'v1');
  assert.equal(
    signature,
    base64Url(createHmac('sha256', SECRET_BYTES).update(body ?? '').digest()),
  );
  assert.deepEqual(JSON.parse(Buffer.from((body ?? '').replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')), {
    version: 1,
    authority: '127.0.0.1:3080',
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
  });

  assert.equal(DshWebSession.create(origin, 'not-a-secret', 0), null);
});

test('DshHostClient adopts only an origin that answers as the harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-adopt-'));
  try {
    await writeCredentials(root);

    const foreign = fakeHost({ status: 200, indexBody: 'hello' });
    const rejected = new DshHostClient({ homeDirectory: root, fetchImpl: foreign.fetchImpl });
    assert.equal(await rejected.adopt('http://127.0.0.1:3080'), false);
    assert.equal(rejected.origin, null);

    const remote = new DshHostClient({ homeDirectory: root, fetchImpl: fakeHost().fetchImpl });
    assert.equal(await remote.adopt('https://example.com'), false);

    const host = fakeHost();
    const client = new DshHostClient({ homeDirectory: root, fetchImpl: host.fetchImpl, now: () => 1_000 });
    assert.equal(await client.adopt('http://127.0.0.1:3080'), true);
    assert.equal(client.origin, 'http://127.0.0.1:3080');
    assert.equal(host.calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshHostClient refuses to adopt when the credential is unusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-nocred-'));
  try {
    const client = new DshHostClient({ homeDirectory: root, fetchImpl: fakeHost().fetchImpl });
    assert.equal(await client.adopt('http://127.0.0.1:3080'), false);
    assert.equal(client.origin, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('probe locates the harness without reading the credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-probe-'));
  try {
    // No credentials file at all: a probe must still find the origin, because a
    // dry run only needs to know where the interface is.
    const host = fakeHost();
    const client = new DshHostClient({ homeDirectory: root, fetchImpl: host.fetchImpl });
    assert.equal(await client.probe('http://127.0.0.1:3080'), true);
    assert.equal(client.origin, 'http://127.0.0.1:3080');

    // Probing never authenticates: a prompt still needs a real credential.
    const result = await client.prompt(SESSION_ID, '继续');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /no authenticated harness origin/u);

    assert.equal(await new DshHostClient({ homeDirectory: root }).probe('https://example.com'), false);
    assert.equal(await new DshHostClient({
      homeDirectory: root,
      fetchImpl: fakeHost({ status: 200, indexBody: 'hello' }).fetchImpl,
    }).probe('http://127.0.0.1:3080'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshHostClient sends the session/prompt call the harness UI sends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-prompt-'));
  try {
    await writeCredentials(root);
    const host = fakeHost();
    const client = new DshHostClient({ homeDirectory: root, fetchImpl: host.fetchImpl });
    assert.equal(await client.adopt('http://127.0.0.1:3080'), true);

    const result = await client.prompt(SESSION_ID, '继续');
    assert.deepEqual(result, { ok: true });

    const call = host.calls[1];
    assert.ok(call);
    assert.equal(call.url, 'http://127.0.0.1:3080/api/session/prompt');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.ok(call.headers.cookie?.startsWith('dsh-auth-'));
    const body = call.body as {
      type: string;
      method: string;
      payload: { args: { request: Record<string, unknown> } };
    };
    assert.equal(body.type, 'client-request');
    assert.equal(body.method, 'session/prompt');
    assert.deepEqual(body.payload.args.request.mode, 'queue');
    assert.deepEqual(body.payload.args.request.sessionId, SESSION_ID);
    assert.deepEqual(body.payload.args.request.content, [{ type: 'text', text: '继续' }]);
    assert.equal(typeof body.payload.args.request.requestId, 'string');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshHostClient surfaces harness refusals and malformed answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-refuse-'));
  try {
    await writeCredentials(root);

    const refused = fakeHost({
      rpc: () => Response.json({
        type: 'server-response',
        rpcId: 'x',
        result: { ok: false, error: { code: 'session/not-found', message: 'session "x" not found', details: {} } },
      }),
    });
    const refusing = new DshHostClient({ homeDirectory: root, fetchImpl: refused.fetchImpl });
    await refusing.adopt('http://127.0.0.1:3080');
    assert.deepEqual(await refusing.prompt(SESSION_ID, '继续'), {
      ok: false,
      error: 'session "x" not found',
    });

    const garbage = fakeHost({ rpc: () => new Response('not json', { status: 200 }) });
    const broken = new DshHostClient({ homeDirectory: root, fetchImpl: garbage.fetchImpl });
    await broken.adopt('http://127.0.0.1:3080');
    const malformed = await broken.prompt(SESSION_ID, '继续');
    assert.equal(malformed.ok, false);
    assert.match(malformed.error ?? '', /malformed JSON/u);

    const wrongEnvelope = fakeHost({ rpc: () => Response.json({ type: 'server-push' }) });
    const odd = new DshHostClient({ homeDirectory: root, fetchImpl: wrongEnvelope.fetchImpl });
    await odd.adopt('http://127.0.0.1:3080');
    assert.equal((await odd.prompt(SESSION_ID, '继续')).ok, false);

    const unavailable = new DshHostClient({ homeDirectory: root, fetchImpl: fakeHost().fetchImpl });
    assert.deepEqual(await unavailable.prompt(SESSION_ID, '继续'), {
      ok: false,
      error: 'no authenticated harness origin is available',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshHostClient forgets a credential the harness stops accepting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-401-'));
  try {
    await writeCredentials(root);
    let reject = false;
    const host = fakeHost({
      rpc: () => (reject ? new Response('unauthorized', { status: 401 }) : Response.json({
        type: 'server-response',
        rpcId: 'x',
        result: { ok: true, value: { accepted: true } },
      })),
    });
    const client = new DshHostClient({ homeDirectory: root, fetchImpl: host.fetchImpl });
    await client.adopt('http://127.0.0.1:3080');

    reject = true;
    const result = await client.prompt(SESSION_ID, '继续');
    assert.deepEqual(result, { ok: false, error: 'harness rejected the local session credential' });
    assert.equal(client.origin, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshHostClient creates a disposable session for a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-create-'));
  try {
    await writeCredentials(root);
    const host = fakeHost({
      rpc: (call) => Response.json({
        type: 'server-response',
        rpcId: 'x',
        result: call.url.endsWith('/session/create')
          ? { ok: true, value: { sessionId: SESSION_ID } }
          : { ok: true, value: { accepted: true } },
      }),
    });
    const client = new DshHostClient({ homeDirectory: root, fetchImpl: host.fetchImpl });
    await client.adopt('http://127.0.0.1:3080');

    assert.deepEqual(await client.createSession('D:\\tmp\\scratch'), { ok: true, sessionId: SESSION_ID });
    const body = host.calls[1]?.body as { method: string; payload: { args: { request: { cwd: string } } } };
    assert.equal(body.method, 'session/create');
    assert.equal(body.payload.args.request.cwd, 'D:\\tmp\\scratch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshWebTransport admits a continuation only for its own idle host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-dsh-transport-'));
  try {
    await writeCredentials(root);
    const host = fakeHost();
    const client = new DshHostClient({ homeDirectory: root, fetchImpl: host.fetchImpl });
    await client.adopt('http://127.0.0.1:3080');

    let idle = true;
    const transport = new DshWebTransport({
      pid: HOST_PID,
      sessionId: SESSION_ID,
      client,
      isIdle: () => idle,
    });

    assert.deepEqual(await transport.probe(HOST_PID), { ok: true, kind: 'dsh-web', pid: HOST_PID });
    assert.equal((await transport.probe(HOST_PID + 1)).ok, false);
    assert.equal((await transport.probe(-1)).ok, false);

    const activity = await transport.activityFingerprint(HOST_PID);
    assert.deepEqual(activity, { ok: true, kind: 'dsh-web', pid: HOST_PID, fingerprint: 'dsh-web' });

    assert.deepEqual(await transport.write(HOST_PID, '继续'), { ok: true, kind: 'dsh-web', pid: HOST_PID });

    // A running step is never interrupted.
    idle = false;
    const busy = await transport.write(HOST_PID, '继续');
    assert.equal(busy.ok, false);
    assert.match(busy.ok === false ? busy.error.message : '', /unfinished step/u);

    // Multi-line text and a foreign PID fail closed before any request.
    idle = true;
    const calls = host.calls.length;
    assert.equal((await transport.write(HOST_PID, 'two\nlines')).ok, false);
    assert.equal((await transport.write(HOST_PID + 1, '继续')).ok, false);
    assert.equal(host.calls.length, calls);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DshWebTransport refuses to probe before an origin is authenticated', async () => {
  const client = new DshHostClient({ homeDirectory: 'C:\\absent' });
  const transport = new DshWebTransport({
    pid: HOST_PID,
    sessionId: SESSION_ID,
    client,
    isIdle: () => true,
  });
  const probe = await transport.probe(HOST_PID);
  assert.equal(probe.ok, false);
  assert.match(probe.ok === false ? probe.error.message : '', /No authenticated/u);
});

test('listLoopbackListenPorts parses the query result and fails soft', async () => {
  const ports = await listLoopbackListenPorts(HOST_PID, {
    runCommand: async (_executable, args) => {
      assert.ok(args.includes('-Command'));
      assert.match(args[args.length - 1] ?? '', new RegExp(String(HOST_PID), 'u'));
      return '3080\n48920\n3080\nnot-a-port\n';
    },
  });
  assert.deepEqual(ports, [3080, 48920]);

  assert.deepEqual(await listLoopbackListenPorts(0, { runCommand: async () => '1' }), []);
  assert.deepEqual(await listLoopbackListenPorts(HOST_PID, {
    runCommand: async () => { throw new Error('fixture failure'); },
  }), []);
});

test('the harness tool defaults keep API input enabled', () => {
  assert.equal(defaultConfig.tools.dsh.allowApiInput, true);
});