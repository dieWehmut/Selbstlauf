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

/** Serve the demo API over real HTTP, with the first session replaced when one is given. */
async function serve(page: Page, extreme: SessionView | null): Promise<void> {
  const demo = createStaticDemoApi();
  const sessions = await demo.sessions();
  const body = extreme === null ? sessions : [extreme, ...sessions.slice(1)];

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
  await serve(page, extremeSession((await demo.sessions())[0]!));
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
  await page.locator('.sidebar-row__open').first().click();
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