import { expect, test, type Page } from '@playwright/test';

import { createStaticDemoApi } from '../../src/api/static-demo';
import type { SessionHostView, SessionView } from '../../src/api/client';

/**
 * Forty sessions at once.
 *
 * The demo project always serves the same four quiet sessions, so nothing about a *full* console had ever
 * been rendered: not a sidebar long enough to scroll on its own, not a table with dozens of rows, and not
 * the counts the metric strip promises once they have to add up. Runs on the live-API server, which is the
 * only place arbitrary session data can be served.
 *
 * The counts are checked against *another surface* rather than against arithmetic here: 可写入 against the
 * badges the table paints, Codex Goal against the conversation cells, 发现进程 against the rows and the
 * account bar. A number that agrees with the code that produced it but not with what is on screen is the
 * defect this is looking for.
 */

const HOSTS: readonly { readonly label: string; readonly category: SessionHostView['category']; readonly processId: number }[] = [
  { label: 'Tabby', category: 'terminal', processId: 5_001 },
  { label: 'Visual Studio Code', category: 'editor', processId: 5_002 },
  { label: 'Microsoft Edge', category: 'browser', processId: 5_003 },
  { label: 'Windows Terminal', category: 'terminal', processId: 5_004 },
];

const COUNT = 40;

async function serveFullConsole(page: Page): Promise<readonly SessionView[]> {
  const demo = createStaticDemoApi();
  const base = await demo.sessions();
  const template = base.find((session) => session.tool === 'codex')!;
  const sessions: SessionView[] = Array.from({ length: COUNT }, (_, index) => {
    const host = HOSTS[index % HOSTS.length]!;
    return {
      ...template,
      id: `scale:${index}`,
      rootPid: 100 + index,
      conversationId: `conv-${index}`,
      quietForMs: 30_000 + index * 1_000,
      // A quarter of them are goals, and every fifth cannot be written to, so both counts are non-trivial.
      goal: index % 4 === 0 ? { status: 'active', updatedAtMs: 1 } : null,
      transport: index % 5 === 0 ? 'monitor-only' : 'classic-console',
      host: template.host === null ? null : ({ ...template.host, ...host, windowTitle: `${host.label} — session ${index}` } as SessionHostView),
    };
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    switch (path) {
      case '/api/health': return respond(await demo.health());
      case '/api/config': return respond(await demo.config());
      case '/api/sessions': return respond(sessions);
      case '/api/startup': return respond(await demo.startup());
      case '/api/claude-hook': return respond(await demo.claudeHook());
      case '/api/codex/profiles': return respond(await demo.codexProfiles());
      case '/api/environment': return respond(await demo.environment());
      case '/api/events': return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': demo\n\n' });
      default: return route.fulfill({ status: 204, body: '' });
    }
  });

  return sessions;
}

test('forty sessions render completely, group by host, and agree with every count', async ({ page }, testInfo) => {
  const served = await serveFullConsole(page);
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  const started = Date.now();
  await expect(page.locator('.sidebar-row__open').first()).toBeVisible();
  const firstRowMs = Date.now() - started;
  await expect(page.locator('.sidebar-row')).toHaveCount(COUNT);
  await expect(page.locator('.process-table tbody tr')).toHaveCount(COUNT);

  const measured = await page.evaluate(() => {
    const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? '';
    const strip = [...document.querySelectorAll('.metric-strip > div')].map((cell) => ({
      label: cell.querySelector('span')?.textContent?.trim() ?? '',
      value: cell.querySelector('strong')?.textContent?.trim() ?? '',
    }));
    const groups = [...document.querySelectorAll('.sidebar-processes__group')].map((group) => ({
      heading: group.querySelector('.sidebar-processes__heading')?.textContent?.trim() ?? '',
      rows: group.querySelectorAll('.sidebar-row').length,
    }));
    const rows = [...document.querySelectorAll('.process-table tbody tr')].map((row) => ({
      writable: row.querySelector('.capability--ready') !== null,
      goal: (row.querySelector('td:nth-child(4) .conversation')?.textContent ?? '').startsWith('Goal'),
    }));
    // The sidebar's own dot comes from the same single owner (`writeEligibility`), so it has to agree.
    const dots = {
      writable: document.querySelectorAll('.sidebar-row .process-dot--writable').length,
      monitor: document.querySelectorAll('.sidebar-row .process-dot--monitor').length,
    };
    const sidebar = document.querySelector('.sidebar-processes__scroll')!;
    const root = document.documentElement;
    return {
      strip,
      groups,
      rows,
      dots,
      account: text('.account-bar__button'),
      sidebarRows: document.querySelectorAll('.sidebar-row').length,
      sidebarScrolls: sidebar.scrollHeight > sidebar.clientHeight,
      sidebarOverflow: sidebar.scrollWidth - sidebar.clientWidth,
      pageOverflow: root.scrollWidth - root.clientWidth,
      tableFits: (() => {
        const wrap = document.querySelector('.process-table-wrap')!;
        return wrap.scrollWidth - wrap.clientWidth;
      })(),
    };
  });

  const value = (label: string) => measured.strip.find((cell) => cell.label === label)?.value ?? '(missing)';
  console.log(`first row after ${firstRowMs}ms; strip: ${measured.strip.map((cell) => `${cell.label}=${cell.value}`).join(' ')}`);
  console.log(`groups: ${measured.groups.map((group) => `${group.heading}(${group.rows})`).join(' ')}`);
  console.log(`table: ${measured.rows.length} rows, ${measured.rows.filter((row) => row.writable).length} writable, ${measured.rows.filter((row) => row.goal).length} goals; table overflow ${measured.tableFits}`);
  await page.screenshot({ path: testInfo.outputPath('scale-overview.png'), fullPage: true });

  // Every session reached both lists, and the two counts on screen agree with them.
  expect(measured.sidebarRows, 'the sidebar did not list every session').toBe(COUNT);
  expect(measured.rows.length, 'the table did not list every session').toBe(COUNT);
  expect(value('发现进程'), 'the metric strip disagrees with the rows').toBe(String(COUNT));
  expect(measured.account, 'the account bar disagrees with the rows').toContain(`${COUNT} 个进程`);

  // The strip's other two counts against what the table actually painted.
  expect(value('可写入'), 'the strip disagrees with the writable badges').toBe(String(measured.rows.filter((row) => row.writable).length));
  expect(value('Codex Goal'), 'the strip disagrees with the goal conversations').toBe(String(measured.rows.filter((row) => row.goal).length));
  expect(measured.rows.filter((row) => row.writable).length, 'the fixture made every session writable').toBeLessThan(COUNT);
  expect(measured.rows.filter((row) => row.goal).length, 'the fixture made every session a goal').toBeLessThan(COUNT);

  // The third surface: the sidebar's dots come from the same write rule as the badges, so the counts match.
  console.log(`sidebar dots: ${measured.dots.writable} writable, ${measured.dots.monitor} monitor`);
  expect(measured.dots.writable, 'the sidebar dots disagree with the writable badges').toBe(measured.rows.filter((row) => row.writable).length);
  expect(measured.dots.writable + measured.dots.monitor, 'a row has no dot, or a tone nothing counted').toBe(COUNT);

  // Grouping: one heading per served host, and every session in the group it belongs to.
  const expectedPerHost = HOSTS.map((host) => ({ heading: host.label, rows: served.filter((session) => session.host?.label === host.label).length }));
  expect(measured.groups.map((group) => group.heading).sort()).toEqual(expectedPerHost.map((host) => host.heading).sort());
  for (const host of expectedPerHost) {
    expect(measured.groups.find((group) => group.heading === host.heading)?.rows, `${host.heading} has the wrong number of rows`).toBe(host.rows);
  }

  // The shell holds: the list scrolls inside itself, the page does not scroll sideways.
  expect(measured.sidebarScrolls, 'forty rows did not overflow the sidebar, so the scroll was not exercised').toBe(true);
  expect(measured.sidebarOverflow, 'the sidebar list scrolls sideways').toBeLessThanOrEqual(1);
  expect(measured.pageOverflow, 'the page scrolls sideways with forty sessions').toBeLessThanOrEqual(1);

  // And the sidebar filter still finds one of forty.
  await page.getByRole('searchbox', { name: '搜索进程' }).fill('conv-17');
  await expect(page.locator('.sidebar-row')).toHaveCount(1);
  await expect(page.locator('.sidebar-row__conversation')).toContainText('conv-17');
});