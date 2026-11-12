import { expect, test, type Page } from '@playwright/test';

import { createStaticDemoApi } from '../../src/api/static-demo';
import type { SessionHostView, SessionView } from '../../src/api/client';

/**
 * What a session with absurd values does to the shell.
 *
 * Runs on the live-API server (see playwright.config.ts), which is the only place arbitrary session
 * data can be served: the demo project uses the in-memory API and always has the same four quiet
 * sessions, so nothing about a very long path, id, title or prompt had ever been rendered.
 *
 * The stylesheet leans heavily on clipping and ellipsis — the sidebar hides its horizontal overflow,
 * row labels and conversation lines truncate, and the window title and prompt chip have maximum
 * widths. This measures whether the shell holds when a value is far outside anything the design saw:
 * measured before the fixes below, one long host label made its cell [286 < 520] and the workspace's
 * own `overflow-x: hidden` cut the text off mid-word with no ellipsis, and one long workspace path
 * made the process table 2125px wide, 1186px of it scrolling.
 *
 * The table is already wide with the demo's own values, so it is compared against a **baseline** pass
 * of the same build: a table that is wide by design is not something a change can be blamed for, and
 * only the increase caused by absurd content is.
 */

/** Long enough to be absurd, short enough that a failure message is readable. */
const LONG = {
  id: `codex:${'9'.repeat(120)}`,
  conversation: 'c'.repeat(200),
  cwd: `D:\\${'a-very-long-directory-name\\'.repeat(12)}`,
  title: '一个很长的窗口标题 A window title that goes on and on '.repeat(6),
  label: 'A host label that is absurdly long '.repeat(3),
  prompt: '/goal resume '.repeat(20),
};

/** How much wider than the baseline the table may become: one capped cell's worth of slack. */
const MAXIMUM_GROWTH = 200;

/** Serve supplied sessions over the real HTTP client, retaining demo settings and service metadata. */
async function serve(page: Page, sessions: readonly SessionView[] | null): Promise<void> {
  const demo = createStaticDemoApi();
  const body = sessions ?? await demo.sessions();

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    switch (path) {
      case '/api/health': return respond(await demo.health());
      case '/api/config': return respond(await demo.config());
      case '/api/sessions': return respond(body);
      case '/api/startup': return respond(await demo.startup());
      case '/api/claude-hook': return respond(await demo.claudeHook());
      case '/api/codex/profiles': return respond(await demo.codexProfiles());
      case '/api/environment': return respond(await demo.environment());
      case '/api/events': return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': demo\n\n' });
      default: return route.fulfill({ status: 204, body: '' });
    }
  });
}

function extremeSession(first: SessionView): SessionView {
  const host = first.host;
  return {
    ...first,
    id: LONG.id,
    conversationId: LONG.conversation,
    sessionCwd: LONG.cwd,
    pendingPrompt: LONG.prompt,
    ...(host === null || host === undefined
      ? {}
      : { host: { ...host, windowTitle: LONG.title, label: LONG.label } as SessionHostView }),
  };
}

/** Elements whose content is wider than their box while nothing clips it — the ones that push. */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('*')]
    .filter((element) => {
      const style = getComputedStyle(element);
      return element.scrollWidth > element.clientWidth + 1 && style.overflowX === 'visible';
    })
    .map((element) => {
      const style = getComputedStyle(element);
      const text = (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40);
      return `${element.tagName.toLowerCase()}.${element.className.toString().replace(/\s+/gu, '.').slice(0, 32)}`
        + ` [${element.clientWidth}<${element.scrollWidth}] ws=${style.whiteSpace} "${text}"`;
    })
    .slice(0, 12));
}

async function measureOverview(page: Page): Promise<{ tableWidth: number; tableOverflow: number; pageOverflow: number; sidebarOverflow: number; sidebarOverflowX: string; rows: number }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const sidebar = document.querySelector('.sidebar-processes__scroll')!;
    const table = document.querySelector('.process-table-wrap')!;
    return {
      tableWidth: table.scrollWidth,
      tableOverflow: table.scrollWidth - table.clientWidth,
      pageOverflow: root.scrollWidth - root.clientWidth,
      sidebarOverflow: sidebar.scrollWidth - sidebar.clientWidth,
      sidebarOverflowX: getComputedStyle(sidebar).overflowX,
      rows: document.querySelectorAll('.sidebar-row').length,
    };
  });
}

test('a session with absurd values does not break the shell', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.setViewportSize({ width: 1249, height: 704 });

  // The same build with the demo's own values, for something to compare against.
  await serve(page, null);
  await page.goto('/');
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();
  const baseline = await measureOverview(page);

  await page.unrouteAll();
  const demo = createStaticDemoApi();
  const sessions = await demo.sessions();
  await serve(page, [extremeSession(sessions[0]!), ...sessions.slice(1)]);
  await page.goto('/');
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();

  const overview = await measureOverview(page);
  const overviewOverflowing = await overflowing(page);
  console.log(`table: baseline ${baseline.tableWidth}px (overflow ${baseline.tableOverflow}) -> extreme ${overview.tableWidth}px (overflow ${overview.tableOverflow})`);
  console.log(`overview: page overflow ${overview.pageOverflow}, sidebar overflow ${overview.sidebarOverflow} (${overview.sidebarOverflowX})`);
  console.log(`overview overflowing: ${overviewOverflowing.join(' | ') || '(none)'}`);

  expect(overview.rows, 'the extreme session did not render, so this proves nothing').toBeGreaterThan(1);
  expect(
    overview.tableWidth - baseline.tableWidth,
    'absurd values widened the table much further than one capped cell',
  ).toBeLessThanOrEqual(MAXIMUM_GROWTH);
  expect(overview.pageOverflow, 'the page itself scrolls sideways').toBeLessThanOrEqual(1);
  expect(overview.sidebarOverflowX, 'the sidebar no longer clips horizontally').toBe('hidden');
  expect(overview.sidebarOverflow, 'the sidebar list scrolls sideways').toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('extreme-overview.png'), fullPage: true });

  // The detail page, where the host label and the workspace path appear.
  await page.locator(`[data-session-id="${LONG.id}"] .sidebar-row__open`).click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  const detail = await page.evaluate(() => {
    const root = document.documentElement;
    return { pageOverflow: root.scrollWidth - root.clientWidth };
  });
  const detailOverflowing = await overflowing(page);
  console.log(`detail: page overflow ${detail.pageOverflow}`);
  console.log(`detail overflowing: ${detailOverflowing.join(' | ') || '(none)'}`);
  expect(detail.pageOverflow, 'the detail page scrolls the whole window sideways').toBeLessThanOrEqual(1);

  /**
   * Nothing may be wider than its own box while nothing clips it.
   *
   * That combination is the silent failure: the element overflows its cell, and the first ancestor
   * that clips cuts the text off mid-word with no ellipsis, so the user cannot tell anything is
   * missing. Measured before the fix, on the 运行位置 row: the host cell was [286 < 520].
   */
  expect(detailOverflowing, 'content is wider than its box with nothing clipping it').toEqual([]);

  // The truncation has to be visible *and* reversible: an ellipsis plus the full value in a title.
  const badge = await page.locator('.process-detail__grid .host-badge').first().evaluate((element) => ({
    title: element.getAttribute('title'),
    textOverflow: getComputedStyle(element).textOverflow,
    overflowX: getComputedStyle(element).overflowX,
  }));
  console.log(`host badge: title ${badge.title === null ? '(none)' : `${badge.title.length} chars`}, overflowX ${badge.overflowX}, text-overflow ${badge.textOverflow}`);
  expect(badge.overflowX, 'the long host label is not clipped by its own pill').toBe('hidden');
  expect(badge.textOverflow, 'the clipped host label has no ellipsis').toBe('ellipsis');
  expect(badge.title, 'the full host label is unreachable once clipped').toBe(LONG.label);
  await page.screenshot({ path: testInfo.outputPath('extreme-detail.png'), fullPage: true });

  /**
   * The narrow layout replaces the table with cards, and a card clips its own overflow
   * (`.session-card { overflow: hidden }`) — so the PID line, which carries the workspace path, is the
   * same silent-clip shape in a second place.
   */
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto('/');
  await expect(page.locator('.session-card').first()).toBeVisible();

  const narrow = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cards: document.querySelectorAll('.session-card').length,
  }));
  const narrowOverflowing = await overflowing(page);
  console.log(`narrow: ${narrow.cards} cards, page overflow ${narrow.pageOverflow}`);
  console.log(`narrow overflowing: ${narrowOverflowing.join(' | ') || '(none)'}`);
  expect(narrow.cards, 'the card layout did not render, so this proves nothing').toBeGreaterThan(0);
  expect(narrow.pageOverflow, 'the card layout scrolls the window sideways').toBeLessThanOrEqual(1);
  expect(narrowOverflowing, 'a card holds content wider than its box with nothing clipping it').toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('extreme-narrow.png'), fullPage: true });

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('real thread IDs keep shared-daemon project rows compact and remain readable in details', async ({ page }, testInfo) => {
  const demo = createStaticDemoApi();
  const template = (await demo.sessions()).find((session) => session.tool === 'codex')!;
  const sessions: SessionView[] = Array.from({ length: 8 }, (_, index) => {
    const conversationId = `01a1c977-e596-7c43-8848-6308b65eeb4${index}`;
    return {
      ...template,
      id: `wsl:Ubuntu-22.04:codex:3801:thread:${conversationId}`,
      rootPid: 3801,
      conversationId,
      sessionCwd: `/home/han/project/${index % 2 === 0 ? 'Selbstlauf' : 'Orchester'}`,
      platform: 'linux',
      distribution: 'Ubuntu-22.04',
      goal: index % 2 === 0 ? null : { status: 'active', updatedAtMs: 1 },
    };
  });
  await serve(page, sessions);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  for (const width of [1280, 1680]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page).toHaveTitle(/Selbstlauf/u);
    await expect(page.getByRole('heading', { name: '进程监控' })).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const rows = page.locator('.process-table tbody tr');
    await expect(rows).toHaveCount(sessions.length);
    const layout = await rows.evaluateAll((elements) => elements.map((row) => ({
      height: row.getBoundingClientRect().height,
      conversationWidth: row.querySelector('td:nth-child(4)')!.getBoundingClientRect().width,
      idHeight: row.querySelector('.conversation-id')!.getBoundingClientRect().height,
    })));
    console.log(`thread rows at ${width}px: max height ${Math.max(...layout.map((row) => row.height))}px, conversation column ${layout[0]!.conversationWidth}px, ID ${layout[0]!.idHeight}px`);
    expect(Math.max(...layout.map((row) => row.height)), `long thread IDs stretched rows at ${width}px`).toBeLessThan(140);
    expect(Math.min(...layout.map((row) => row.conversationWidth)), 'the conversation column is squeezed to a few characters').toBeGreaterThanOrEqual(120);
    expect(Math.max(...layout.map((row) => row.idHeight)), 'thread IDs wrap into many lines').toBeLessThan(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expect(rows.first().getByRole('button', { name: '立即续写 PID 3801' })).toBeEnabled();
    await expect(rows.first().locator('.conversation-id')).toHaveAttribute('title', sessions[0]!.conversationId!);
    await page.screenshot({ path: testInfo.outputPath(`thread-rows-${width}.png`), fullPage: false });
  }

  await page.locator(`[data-session-id="${sessions[0]!.id}"] .sidebar-row__open`).click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
  await expect(page.locator('.process-detail__grid')).toContainText(sessions[0]!.conversationId!);
  await expect(page.locator('.process-detail__grid')).toContainText('/home/han/project/Selbstlauf');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.session-card')).toHaveCount(sessions.length);
  await expect(page.locator('.session-card').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('thread-cards-390.png'), fullPage: false });
  expect(pageErrors).toEqual([]);
});
