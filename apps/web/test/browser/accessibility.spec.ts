import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * A real automated accessibility audit of every page, using axe-core.
 *
 * The rest of the suite checks accessibility by structure — that the rail is a valid tablist, that
 * sidebar rows stay exposed as buttons, that a menu holds only menu items. Those are targeted checks
 * written from bugs already found, so they can only catch bugs of the kind already known. This runs
 * an independent rule set over the whole rendered page instead, which is a different kind of
 * evidence: it does not know what I was worried about.
 *
 * Serious and critical violations fail the test. Moderate and minor ones are reported but tolerated,
 * because a rule like "colour contrast on a decorative divider" is not the same as "a control with no
 * accessible name" and pretending otherwise would make the suite either dishonest or unused.
 */

/**
 * axe-core's browser bundle.
 *
 * Resolved through Node's own resolver rather than a path from `process.cwd()`: Playwright runs the
 * suite with the working directory set to `apps/web`, so a repo-root-relative path finds nothing —
 * which is how this first failed.
 */
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

async function audit(page: Page, label: string): Promise<readonly AxeViolation[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  /**
   * Wait for animations to settle before measuring.
   *
   * This mattered: the rows and the settings panel animate in, and axe samples *computed* colour, so
   * a running fade is read as a blended mid-transition value and reported as a contrast failure. An
   * earlier version of this test called axe immediately after navigating and reported failures in
   * the sidebar that were not real — the same audit on a settled page reported none. Waiting is what
   * makes the measurement describe the interface rather than a frame of its entrance animation.
   */
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  const result = await page.evaluate(async () => {
    // The whole document, not a subtree: the shell, the sidebar and the settings rail are separate
    // landmarks and a rule can be violated by their relationship.
    const outcome = await (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: unknown[] }> } })
      .axe.run(document, {
        // Colour contrast is included deliberately; the palette is theme-dependent so each theme is
        // audited rather than assumed to hold for both.
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
    return outcome.violations as AxeViolation[];
  });
  return result.map((violation) => ({ ...violation, help: `${label}: ${violation.help}` }));
}

const describe = (violations: readonly AxeViolation[]) => violations
  .map((v) => `${v.impact ?? 'unknown'} ${v.id}: ${v.help}\n      at ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  .join('\n    ');

test.describe('accessibility audit', () => {
  test('the process list, detail page and settings rail have no serious violations', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.setViewportSize({ width: 1249, height: 704 });
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeVisible();

    const all: AxeViolation[] = [];

    // 进程 — the dashboard, with the sidebar list rebuilt this cycle.
    all.push(...await audit(page, '进程'));

    // 进程详情 — the new window-preview panel lives here.
    await page.locator('.sidebar-row__open').first().click();
    await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
    all.push(...await audit(page, '进程详情'));

    // 设置 — the settings rail as the left column.
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('heading', { name: 'Watchdog 设置' })).toBeVisible();
    all.push(...await audit(page, '设置'));

    // 事件 — the timeline.
    await page.keyboard.press('Control+2');
    await expect(page.getByRole('heading', { name: '事件记录' })).toBeVisible();
    all.push(...await audit(page, '事件'));

    // 置顶 — the pinned group, which introduces a second heading level and an extra control per row.
    await page.keyboard.press('Control+1');
    const firstRow = page.locator('.sidebar-row').first();
    await firstRow.hover();
    await firstRow.locator('.sidebar-row__pin').click();
    await expect(page.locator('.sidebar-processes__heading', { hasText: '置顶' })).toHaveCount(1);
    all.push(...await audit(page, '进程(已置顶)'));

    // The breadth of the audit is worth asserting: an audit that silently checked nothing would
    // otherwise pass.
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);

    const serious = all.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      serious,
      `serious or critical accessibility violations:\n    ${describe(serious)}`,
    ).toEqual([]);
  });

  test('the light theme has no serious violations either', async ({ page }) => {
    // The palette is theme-dependent, so contrast must be audited per theme rather than assumed to
    // hold for both.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1249, height: 704 });
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeVisible();

    const all = await audit(page, '进程(亮色)');
    const serious = all.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      serious,
      `serious or critical accessibility violations in the light theme:\n    ${describe(serious)}`,
    ).toEqual([]);
  });

  test('the settings drawer on a narrow viewport has no serious violations', async ({ page }) => {
    // A drawer is a different structure — position: fixed, off-canvas, with its own close control —
    // so it is audited separately rather than assumed to inherit the column layout's result.
    await page.setViewportSize({ width: 700, height: 704 });
    await page.goto('/');
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: '打开菜单' }).click();
    await expect(page.locator('.sidebar--settings')).toHaveClass(/is-open/u);

    const all = await audit(page, '设置(抽屉)');
    const serious = all.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      serious,
      `serious or critical violations in the settings drawer:\n    ${describe(serious)}`,
    ).toEqual([]);
  });
});