import { expect, test } from '@playwright/test';

/**
 * Can anything slide under the native minimise/maximise/close buttons?
 *
 * The renderer reserves a 148px gutter via `padding-right` on `.titlebar`, so nothing *inside* the bar
 * can reach it — a first version of this test checked exactly that and could not fail, which is how it
 * was found to be measuring the wrong thing. The real risk is different: the title bar is `sticky` with
 * a `z-index` above the sidebar, and the sidebar is itself `sticky` at the same top offset. If the
 * sidebar's stacking ever won, its top-right corner — where its own content sits — would appear beneath
 * the OS-drawn buttons.
 *
 * So this measures what is actually painted in the gutter's rectangle at the top of the window, using
 * `elementFromPoint`, rather than measuring elements that cannot get there.
 */
test('the native-button gutter shows only the title bar, at every real window width', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // The desktop window's own minimum is 960, so below that the gutter is not a state a window takes.
  const widths = [960, 1024, 1249, 1440, 1920];
  const findings: string[] = [];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 704 });
    await page.goto('/');
    await page.evaluate(() => { document.documentElement.dataset.shell = 'desktop'; });
    await page.waitForTimeout(300);

    const measured = await page.evaluate(() => {
      const bar = document.querySelector('.titlebar');
      if (!bar) return null;
      const reserve = Number.parseFloat(getComputedStyle(bar).paddingRight);
      const viewport = window.innerWidth;
      const gutterStart = viewport - reserve;
      const barBox = bar.getBoundingClientRect();
      const y = Math.round(barBox.top + barBox.height / 2);

      // Sample the gutter: what is actually on top there?
      const samples = [];
      for (const x of [gutterStart + 10, gutterStart + 50, gutterStart + 100, viewport - 10]) {
        const el = document.elementFromPoint(x, y);
        samples.push({
          x,
          tag: el?.tagName.toLowerCase() ?? 'none',
          cls: el?.className?.toString().slice(0, 40) ?? '',
          insideTitlebar: el === bar || bar.contains(el),
        });
      }
      return { reserve, viewport, gutterStart: Math.round(gutterStart), y, samples };
    });

    expect(measured, `no title bar at ${width}px`).not.toBeNull();
    console.log(`${width}px: reserve=${measured!.reserve}, sampling the gutter at y=${measured!.y}`);
    for (const s of measured!.samples) {
      const owner = s.insideTitlebar ? 'title bar' : `${s.tag}${s.cls ? `.${s.cls.split(' ')[0]}` : ''}`;
      console.log(`  x=${s.x} -> ${owner}`);
      if (!s.insideTitlebar) {
        findings.push(`${width}px: x=${s.x} in the gutter is occupied by ${owner}, not the title bar`);
      }
    }
  }

  // The gutter belongs to the title bar. Anything else there would sit under the OS buttons.
  expect(findings, `the native-button gutter is not clear:\n  ${findings.join('\n  ')}`).toEqual([]);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('scrolling a long page never puts content under the native buttons', async ({ page }) => {
  // The title bar is sticky, so it must stay painted above whatever scrolls. This scrolls the workspace
  // hard and re-checks the gutter, which is where a stacking regression would show.
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.evaluate(() => { document.documentElement.dataset.shell = 'desktop'; });
  await page.keyboard.press('Control+,'); // the settings page is the longest
  await page.waitForTimeout(400);

  const findings: string[] = [];
  for (const scrollTop of [0, 400, 2000, 99999]) {
    await page.evaluate((value) => {
      const scroller = document.querySelector('.workspace') ?? document.scrollingElement;
      if (scroller) scroller.scrollTop = value;
    }, scrollTop);
    await page.waitForTimeout(250);

    const occupied = await page.evaluate(() => {
      const bar = document.querySelector('.titlebar');
      if (!bar) return null;
      const reserve = Number.parseFloat(getComputedStyle(bar).paddingRight);
      const viewport = window.innerWidth;
      const gutterStart = viewport - reserve;
      const box = bar.getBoundingClientRect();
      const y = Math.round(box.top + box.height / 2);
      return [gutterStart + 10, gutterStart + 80, viewport - 10].map((x) => {
        const el = document.elementFromPoint(x, y);
        return { x, insideTitlebar: el === bar || bar.contains(el), tag: el?.tagName.toLowerCase() ?? 'none' };
      });
    });

    for (const s of occupied ?? []) {
      if (!s.insideTitlebar) findings.push(`scrollTop=${scrollTop}: x=${s.x} occupied by ${s.tag}`);
    }
  }

  expect(findings, `content appeared in the gutter while scrolling:\n  ${findings.join('\n  ')}`).toEqual([]);
});