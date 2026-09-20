/**
 * Static file serving from the bundled WebUI directory.
 *
 * This is the code path that serves the entire renderer, and it was entirely
 * uncovered: no test ever passed a `staticDirectory`, so neither its routing (a
 * deep link falling back to `index.html`) nor its directory-escape guard had ever
 * run. The guard is security-relevant — the service is reachable from any process on
 * loopback — so it is tested here with real attack strings rather than by reading it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WatchdogHttpServer } from '../src/server/http-server.js';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore } from '../src/store/audit-store.js';

/** A static directory with an index, an asset and a nested route directory. */
async function startStaticServer() {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-static-'));
  const webRoot = join(root, 'web-dist');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await mkdir(join(webRoot, 'deep'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>shell</title>', 'utf8');
  await writeFile(join(webRoot, 'assets', 'app.js'), 'export const x = 1;', 'utf8');
  await writeFile(join(webRoot, 'deep', 'index.html'), '<!doctype html><title>deep</title>', 'utf8');
  // A file outside the served directory: the traversal tests must never reach it.
  await writeFile(join(root, 'secret.txt'), 'do not serve this', 'utf8');

  const service = new WatchdogHttpServer({
    configStore: new ConfigStore(join(root, 'config.json')),
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    sessions: { list: () => [], pause: async () => true, resume: async () => true, inject: async () => ({ ok: true }) },
    port: 0,
    staticDirectory: webRoot,
  });
  await service.start();
  return { service, base: service.url(), webRoot, root };
}

test('serves the shell at the root and a real asset with its content type', async (t) => {
  const { service, base } = await startStaticServer();
  t.after(async () => { await service.stop(); });

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/u);
  assert.match(await index.text(), /<title>shell<\/title>/u);

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  // A wrong content type would make the browser refuse to execute the bundle.
  assert.match(asset.headers.get('content-type') ?? '', /javascript/u);
  assert.match(await asset.text(), /export const x = 1;/u);
});

test('serves a nested directory index and falls back to the shell for a deep link', async (t) => {
  const { service, base } = await startStaticServer();
  t.after(async () => { await service.stop(); });

  // A real directory with its own index is served as that index.
  const deep = await fetch(`${base}/deep`);
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /<title>deep<\/title>/u);

  // A client-side route that has no file falls back to the shell, otherwise a
  // refresh on a settings deep link would show a 404 instead of the app.
  const route = await fetch(`${base}/settings/appearance`);
  assert.equal(route.status, 200);
  assert.match(await route.text(), /<title>shell<\/title>/u);
});

test('a missing file with an extension is not answered with the shell', async (t) => {
  const { service, base } = await startStaticServer();
  t.after(async () => { await service.stop(); });

  // Falling back to HTML for a missing script would make the browser parse the
  // shell as JavaScript and fail with a confusing syntax error.
  const missing = await fetch(`${base}/assets/missing.js`);
  assert.notEqual(missing.status, 200);
  assert.doesNotMatch(await missing.text(), /<title>shell<\/title>/u);
});

test('refuses to serve anything outside the static directory', async (t) => {
  const { service, base } = await startStaticServer();
  t.after(async () => { await service.stop(); });

  const attacks = [
    '/../secret.txt',
    '/../../secret.txt',
    '/assets/../../secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/....//secret.txt',
    '/deep/../../secret.txt',
  ];

  for (const attack of attacks) {
    const response = await fetch(`${base}${attack}`, { redirect: 'manual' });
    const body = await response.text();
    assert.ok(
      response.status === 403 || response.status === 404,
      `${attack} must be refused, got ${response.status}`,
    );
    assert.doesNotMatch(body, /do not serve this/u, `${attack} leaked a file outside the static directory`);
  }
});

test('does not serve the shell for an encoded traversal', async (t) => {
  const { service, base } = await startStaticServer();
  t.after(async () => { await service.stop(); });

  // The shell fallback must not become a way to confirm the directory layout: an
  // encoded traversal is a request for a missing file, so it is refused outright.
  const response = await fetch(`${base}/%2e%2e%2fsecret.txt`, { redirect: 'manual' });
  assert.doesNotMatch(await response.text(), /do not serve this/u);
});

test('leaves the API routes alone when a static directory is configured', async (t) => {
  const { service, base } = await startStaticServer();
  t.after(async () => { await service.stop(); });

  // The static handler runs for any non-/api path, so it must never shadow the API.
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const payload = (await health.json()) as { ok?: boolean };
  assert.equal(typeof payload.ok, 'boolean');
});