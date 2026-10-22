// Real service and the exact Pages artifact: language persistence, UI coverage and layout.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { startWatchdogProcess } from '../../apps/cli/dist/src/index.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const liveBuild = resolve(process.argv[2] ?? join(repository, 'apps/web/dist'));
const pagesBuild = resolve(process.argv[3] ?? join(repository, 'apps/web/dist-pages'));
const artifacts = join(repository, 'tmp/settings-verification-20261022/languages');
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-languages-'));
const locales = [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語']];
const sections = ['general', 'appearance', 'notifications', 'shortcuts', 'profile', 'pet', 'startup', 'config', 'import', 'computer-control', 'plugins', 'browser', 'account'];
const notes = [];
const englishHan = [];
let screenshots = 0;
let browser;
let service;
let pagesServer;
const state = join(root, 'ai-cli-bypass/continuation');
const codex = join(root, '.codex/config.toml');
const claude = join(root, '.claude/settings.json');
const sessions = { list: () => [], pause: () => false, resume: () => false, inject: () => ({ ok: false }) };
const note = (message) => { notes.push(message); process.stdout.write(`ok  ${message}\n`); };

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}
async function section(page, id) {
  const drawer = page.locator('.sidebar--settings');
  if (page.viewportSize().width <= 960 && !await drawer.evaluate((node) => node.classList.contains('is-open'))) {
    await page.locator('.mobile-menu').click();
  }
  await page.locator(`[role="tab"][data-section="${id}"]`).click();
  await expect(page.locator(`[role="tab"][data-section="${id}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.locator('.workspace').evaluate((node) => { node.scrollTop = 0; });
  await expect(page.locator('.settings-content h2').first()).toBeVisible();
  await settle(page);
}
async function chooseLocale(page, locale, name) {
  await section(page, 'appearance');
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
}
async function screenshot(page, name) {
  await settle(page);
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
  screenshots += 1;
}
async function scanEnglish(page, surface, id) {
  const found = await page.locator('.settings-content').evaluate((container) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const results = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent.trim();
      if (!parent || parent.closest('input,textarea,pre,code,[data-user-content]') || parent.getClientRects().length === 0) continue;
      if (/\p{Script=Han}/u.test(text) && !['简体中文', '繁體中文', '日本語'].includes(text)) {
        results.push({ text, element: parent.className });
      }
    }
    return results;
  });
  if (found.length) englishHan.push({ surface, section: id, found });
}

try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(dirname(codex), { recursive: true });
  await mkdir(dirname(claude), { recursive: true });
  await writeFile(codex, 'model = "verification-model"\nbase_url = "https://example.com/v1"\n');
  await writeFile(claude, '{}\n');
  note(`runtime ${process.execPath} ${process.version}; conda ${process.env.CONDA_PREFIX}`);
  service = await startWatchdogProcess({ stateDirectory: state, claudeSettingsPath: claude, codexConfigPath: codex,
    staticDirectory: liveBuild, port: 0 }, sessions);
  const configBefore = `${JSON.stringify(await (await fetch(`${service.server.url()}/api/config`)).json(), null, 2)}\n`;
  await writeFile(join(state, 'config.json'), configBefore);
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
  pagesServer = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/Selbstlauf/')) { response.writeHead(404).end(); return; }
      const file = resolve(pagesBuild, pathname.slice('/Selbstlauf/'.length) || 'index.html');
      if (!file.startsWith(pagesBuild + sep)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((yes) => pagesServer.listen(0, '127.0.0.1', yes));
  browser = await chromium.launch();
  for (const [surface, url] of [['webui', service.server.url()], ['pages', `http://127.0.0.1:${pagesServer.address().port}/Selbstlauf/`]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    const apiRequests = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
    await page.goto(url);
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.keyboard.press('Control+,');
    await expect(page.locator('.settings-content')).toBeVisible();
    for (const [locale, name] of locales) {
      await chooseLocale(page, locale, name);
      for (const theme of ['light', 'dark']) {
        await section(page, 'appearance');
        await page.locator('.theme-previews [role="radio"]').nth(theme === 'light' ? 1 : 2).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          for (const id of sections) {
            await section(page, id);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${surface}/${locale}/${theme}/${width}/${id} overflow`);
            if (locale === 'en' && theme === 'light' && width === 1280) await scanEnglish(page, surface, id);
            const label = `${surface}-${locale}-${theme}-${width}-${id}`;
            await screenshot(page, `${label}-top`);
            const scrollable = await page.locator('.workspace').evaluate((node) => { node.scrollTop = node.scrollHeight; return node.scrollTop > 0; });
            if (scrollable) await screenshot(page, `${label}-bottom`);
          }
        }
      }
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('watchdog-locale'))), locale);
      await page.keyboard.press('Control+,');
      await section(page, 'appearance');
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      note(`${surface} ${locale}: all 13 sections, light/dark, 1280/390 and reload persistence`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await chooseLocale(page, 'zh-CN', '简体中文');
    const observer = await context.newPage();
    await observer.goto(url);
    await expect(observer.locator('.app-shell')).toBeVisible();
    await chooseLocale(page, 'en', 'English');
    await expect(observer.locator('html')).toHaveAttribute('lang', 'en');
    await expect(observer.getByRole('heading', { name: 'Process monitor', exact: true })).toBeVisible();
    await screenshot(observer, `${surface}-cross-window-en`);
    await observer.reload();
    await expect(observer.locator('html')).toHaveAttribute('lang', 'en');
    await observer.close();
    note(`${surface} changes synchronize to another real window and survive its reload`);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Object.assign(window, { restoreLocaleStorage: () => { Storage.prototype.setItem = original; } });
      Storage.prototype.setItem = function(key, value) {
        if (key === 'watchdog-locale') throw new DOMException('quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.getByRole('button', { name: '日本語', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Could not save language' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await screenshot(page, `${surface}-storage-refusal-en`);
    await page.evaluate(() => window.restoreLocaleStorage());
    await chooseLocale(page, 'ja', '日本語');
    await screenshot(page, `${surface}-storage-retry-ja`);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    note(`${surface} storage refusal retains English and a retry persists Japanese`);
    assert.deepEqual(errors, [], `${surface} browser runtime errors`);
    if (surface === 'pages') assert.deepEqual(apiRequests, [], 'Pages demo must not request local APIs');
    await context.close();
  }
  assert.equal(await readFile(join(state, 'config.json'), 'utf8'), configBefore, 'language changes must preserve service configuration');
  note('language preferences preserve real continuation configuration; Pages uses zero local API requests');
  await writeFile(join(artifacts, 'english-text-audit.json'), JSON.stringify(englishHan, null, 2));
  assert.deepEqual(englishHan, [], 'untranslated English UI (see english-text-audit.json)');
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify({ ok: true, node: process.execPath, runtime: process.version,
    conda: process.env.CONDA_PREFIX, liveBuild, pagesBuild, notes, sections, locales: locales.map(([locale]) => locale), screenshots }, null, 2)}\n`);
  await rm(join(artifacts, 'failure.txt'), { force: true });
} catch (cause) {
  await writeFile(join(artifacts, 'english-text-audit.json'), JSON.stringify(englishHan, null, 2));
  await writeFile(join(artifacts, 'failure.txt'), String(cause.stack ?? cause));
  throw cause;
} finally {
  await browser?.close();
  await service?.stop();
  if (pagesServer?.listening) await new Promise((yes) => pagesServer.close(yes));
  await rm(root, { recursive: true, force: true });
}
