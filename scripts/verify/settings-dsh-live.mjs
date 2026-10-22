// Verify the existing Dry Run setting through production UI and real loopback
// HTTP. The Harness, credentials, process list and session files are disposable.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compiled = process.env.DSH_VERIFY_CLI_DIRECTORY ?? join(repository, 'tmp/dsh-testbuild');
const web = process.env.DSH_VERIFY_WEB_DIRECTORY ?? join(repository, 'tmp/dsh-web-build');
const artifacts = join(repository, 'tmp/settings-verification-20261022/webui/04-dsh-dryrun');
const moduleAt = (path) => import(pathToFileURL(join(compiled, 'src', path)).href);
const [{ defaultConfig }, { DshHostClient }, { WatchdogController }, { WatchdogHttpServer }, { ConfigStore }, { AuditStore }, { CodexConfigProfiles }] = await Promise.all([
  moduleAt('domain/config.js'), moduleAt('dsh/web-host.js'), moduleAt('runtime/watchdog-controller.js'),
  moduleAt('server/http-server.js'), moduleAt('store/config-store.js'), moduleAt('store/audit-store.js'), moduleAt('codex/profile-store.js'),
]);
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'selbstlauf-dsh-settings-'));
const sessionId = 'session-3acd60b1-9056-4191-9070-8cd3563436a7';
const secretBytes = Buffer.from('0123456789abcdef0123456789abcdef');
const secret = secretBytes.toString('base64url');
const oldHost = process.env.DSH_WEB_URL;
const notes = [];
const screenshots = [];
const note = (message) => { notes.push(message); process.stdout.write(`ok  ${message}\n`); };
let browser;
let controller;
let service;
let harness;
let context;

async function select(page, name) {
  if (page.viewportSize().width <= 960 && !await page.locator('.sidebar--settings').evaluate((node) => node.classList.contains('is-open'))) {
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  }
  await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name, exact: true }).click();
  await page.locator('.workspace').evaluate((node) => { node.scrollTop = 0; });
}
async function capture(page, name) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const dryRun = page.getByRole('checkbox', { name: 'Dry run', exact: true });
  if (await dryRun.count()) {
    await page.locator('.workspace').evaluate((node) => { node.scrollTop = 0; });
    const top = join(artifacts, `${name}-top.png`);
    await page.screenshot({ path: top, fullPage: true, animations: 'disabled' });
    screenshots.push(top);
    await dryRun.scrollIntoViewIfNeeded();
  }
  const path = join(artifacts, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(path);
}
try {
  note(`runtime ${process.execPath} ${process.version}; conda ${process.env.CONDA_PREFIX}`);
  browser = await chromium.launch();
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    const label = `${theme}-${width}`;
    const root = join(scratch, label);
    const home = join(root, 'dsh');
    const project = join(home, 'sessions', '--fixture-workspace--', sessionId);
    const projections = join(home, 'storages/session_projcache/sessions');
    await mkdir(project, { recursive: true });
    await mkdir(projections, { recursive: true });
    const now = Date.now();
    let clock = now;
    await writeFile(join(project, 'session.v3.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: sessionId, createdAt: now - 2000, cwd: '/fixture/workspace' })}\n`);
    await writeFile(join(projections, `${sessionId}.json`), JSON.stringify({ version: 7, record: {
      identity: { formatVersion: 3, createdAt: now - 2000, cwd: '/fixture/workspace' },
      rows: {
        sessionListMetadata: { ver: 1, seq: 10, val: { blank: false, lastPromptAt: now - 1000 } },
        turnBoundary: { ver: 2, seq: 10, val: { openTurnStartSeq: 1, lastStepBoundary: { kind: 'end', seq: 9 }, lastTurn: 1 } },
      },
    } }));
    const credentialPath = join(home, '.credentials.yaml');
    const credentials = `version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`;
    await writeFile(credentialPath, credentials);
    let fingerprintRequests = 0;
    const promptRequests = [];
    harness = createServer(async (request, response) => {
      if (request.url === '/' && request.method === 'GET') {
        fingerprintRequests += 1;
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
        return;
      }
      const authority = request.headers.host;
      const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
      const signed = request.headers.cookie?.split('; ').find((cookie) => cookie.startsWith(`${name}=`))?.slice(name.length + 1);
      const [version, body, signature] = signed?.split('.') ?? [];
      const expected = body ? createHmac('sha256', secretBytes).update(body).digest('base64url') : null;
      let claims;
      try { claims = body ? JSON.parse(Buffer.from(body, 'base64url').toString()) : null; } catch { claims = null; }
      if (version !== 'v1' || signature !== expected || claims?.authority !== authority || claims?.expiresAt <= Date.now()) {
        response.writeHead(401); response.end('invalid fixture authentication'); return;
      }
      let text = '';
      for await (const chunk of request) text += chunk;
      const envelope = JSON.parse(text);
      if (request.url !== '/api/session/prompt' || envelope.payload?.args?.request?.sessionId !== sessionId) {
        response.writeHead(404); response.end('unknown fixture session'); return;
      }
      promptRequests.push({ authenticated: true, sessionId, content: envelope.payload.args.request.content });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { accepted: true } } }));
    });
    await new Promise((resolve) => harness.listen(0, '127.0.0.1', resolve));
    const harnessOrigin = `http://127.0.0.1:${harness.address().port}`;
    process.env.DSH_WEB_URL = harnessOrigin;
    const configStore = new ConfigStore(join(root, 'config.json'));
    await configStore.save({ ...defaultConfig, dryRun: true, defaultIdleTimeoutMs: 1000, pollIntervalMs: 1000 });
    const auditStore = new AuditStore(join(root, 'audit.jsonl'));
    let liveService;
    controller = new WatchdogController({
      configStore, auditStore, platform: 'win32', currentProcessId: 50, dshHomeDirectory: home,
      provider: { listProcesses: async () => [
        { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: now - 5000, userSid: 'S-1-5-21-test' },
        { pid: 4321, parentPid: 1, name: 'dsh.exe', commandLine: 'dsh.exe web', executablePath: 'C:\\fixture\\dsh.exe', creationTimeMs: now - 4000, userSid: 'S-1-5-21-test', workingDirectory: '/fixture/workspace' },
      ] },
      dshHostClientFactory: () => new DshHostClient({ homeDirectory: home }),
      dshPortLister: async () => [harness.address().port],
      now: () => clock,
      publish: (event, data) => liveService?.publish(event, data),
    });
    const codexConfig = join(root, 'codex.toml');
    await writeFile(codexConfig, 'model = "fixture-model"\n');
    service = new WatchdogHttpServer({ configStore, auditStore, sessions: controller, port: 0, staticDirectory: web,
      codexProfiles: new CodexConfigProfiles({ configPath: codexConfig }), status: () => controller.status(),
      environment: { report: async () => ({ checkedAt: new Date().toISOString(), node: { version: process.version, executable: process.execPath }, npm: { version: 'fixture', executable: 'fixture' }, tools: [], upgrades: [], manualCommands: [] }) },
    });
    liveService = service;
    service.setLifecycle({ startupStatus: async () => ({ installed: false }), claudeHookStatus: async () => ({ installed: false, restartRequired: false, manualReviewRequired: false }) });
    await service.start();
    await controller.start();
    assert.equal((await controller.list())[0].transport, 'monitor-only');
    assert.equal(promptRequests.length, 0);
    context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(service.url());
    await expect(page.getByRole('heading', { name: '进程监控', exact: true })).toBeVisible();
    await page.keyboard.press('Control+,');
    await select(page, '外观');
    await page.getByRole('radio', { name: theme === 'light' ? '浅色' : '深色', exact: true }).click();
    await select(page, '常规');
    await capture(page, `${label}-01-dryrun-probed`);
    // A real missing credential exposes a genuine unavailable transport;
    // preserving the probed origin must never make the UI report writable.
    await rm(credentialPath);
    await page.getByRole('checkbox', { name: 'Dry run', exact: true }).uncheck();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => (await configStore.load()).dryRun).toBe(false);
    await controller.poll();
    assert.equal((await controller.list())[0].transport, 'monitor-only');
    assert.equal((await controller.inject(`dsh:${sessionId}`, 'must not write', false)).ok, false);
    assert.equal(promptRequests.length, 0);
    await page.keyboard.press('Control+1');
    await expect(page.getByRole('button', { name: '立即续写 PID 4321', exact: true })).toBeDisabled();
    const unavailable = page.locator(width <= 960 ? 'article' : '.process-table').getByText('未找到可认证的 Harness 本机接口', { exact: true });
    await expect(unavailable).toBeVisible();
    await capture(page, `${label}-02-credentials-unavailable`);
    await page.keyboard.press('Control+,');
    await select(page, '常规');
    await writeFile(credentialPath, credentials);
    await page.getByRole('checkbox', { name: 'Dry run', exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => (await configStore.load()).dryRun).toBe(true);
    await controller.poll();
    await page.getByRole('checkbox', { name: 'Dry run', exact: true }).uncheck();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => (await configStore.load()).dryRun).toBe(false);
    await controller.poll();
    await expect.poll(async () => (await controller.list())[0].transport).toBe('dsh-web');
    await capture(page, `${label}-03-dryrun-saved-off`);
    await page.keyboard.press('Control+1');
    const inject = page.getByRole('button', { name: '立即续写 PID 4321', exact: true });
    await expect(inject).toBeEnabled();
    await page.locator('.workspace').evaluate((node) => { node.scrollTop = 0; });
    await inject.click();
    await expect.poll(() => promptRequests.length).toBe(1);
    assert.deepEqual(promptRequests[0], { authenticated: true, sessionId, content: [{ type: 'text', text: '继续' }] });
    await capture(page, `${label}-04-authenticated-continuation`);
    clock += 2000;
    await controller.poll();
    assert.equal(promptRequests.length, 2, 'automatic continuation must work after saving Dry Run off');
    assert.deepEqual(promptRequests[1], { authenticated: true, sessionId, content: [{ type: 'text', text: '继续' }] });
    await page.keyboard.press('Control+,');
    await select(page, '常规');
    await page.getByRole('checkbox', { name: 'Dry run', exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => (await configStore.load()).dryRun).toBe(true);
    await controller.poll();
    assert.equal((await controller.list())[0].transport, 'monitor-only');
    assert.equal((await controller.inject(`dsh:${sessionId}`, 'dry run only', true)).dryRun, true);
    assert.equal(promptRequests.length, 2);
    await capture(page, `${label}-05-dryrun-enabled-no-write`);
    await page.reload();
    await page.keyboard.press('Control+,');
    await select(page, '常规');
    await expect(page.getByRole('checkbox', { name: 'Dry run', exact: true })).toBeChecked();
    assert.deepEqual(errors, []);
    note(`${label}: real UI save, missing credential stays monitor-only, retry signs accepted HTTP cookie, one-click and automatic prompts reach own session, Dry Run re-enable writes nothing, reload persists; ${fingerprintRequests} fingerprint requests`);
    await context.close(); context = null;
    await controller.stop(); controller = null;
    await service.stop(); service = null;
    await new Promise((resolve) => harness.close(resolve)); harness = null;
  }
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify({ ok: true, runtime: process.version, node: process.execPath, conda: process.env.CONDA_PREFIX, notes, screenshots }, null, 2)}\n`);
} catch (error) {
  if (context) await context.pages()[0]?.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  await writeFile(join(artifacts, 'failure.txt'), String(error.stack ?? error));
  throw error;
} finally {
  await context?.close(); await browser?.close(); await controller?.stop(); await service?.stop();
  if (harness) await new Promise((resolve) => harness.close(resolve));
  if (oldHost === undefined) delete process.env.DSH_WEB_URL; else process.env.DSH_WEB_URL = oldHost;
  await rm(scratch, { recursive: true, force: true });
}
