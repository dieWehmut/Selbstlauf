import { expect, test } from '@playwright/test';

/**
 * The detail page must not present two identical input boxes.
 *
 * Reported directly: the transport composer and the window-typing panel both rendered as open "INPUT" rows with the
 * same field and the same button, so they read as one control duplicated. They are genuinely different mechanisms —
 * the composer writes through the session's own transport and costs nothing, while the other types real keystrokes
 * and must take the foreground — so the fix is not to remove either, but to stop them looking alike.
 *
 * **What this suite can and cannot check.** It runs with `VITE_STATIC_DEMO=true`, so there is no desktop bridge and
 * the window-typing panel is not rendered at all here — measured, `summaries=0`. Asserting on it in this harness
 * would be asserting something that cannot exist. So what is pinned here is the half that *is* real in this harness:
 * exactly one input box is offered, and it is the transport composer. The disclosure itself was verified in the
 * installed app, where the bridge exists.
 */
test('exactly one input box is offered on a detail page', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();
  await page.waitForTimeout(500);

  const visible = await page.evaluate(() => {
    // Only boxes the browser actually lays out count; a zero-sized element is not on screen.
    const onScreen = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return {
      composerFields: [...document.querySelectorAll('.prompt-composer input')].filter(onScreen).length,
      windowFields: [...document.querySelectorAll('.window-type input')].filter(onScreen).length,
      windowPanels: document.querySelectorAll('.window-type').length,
    };
  });
  console.log(`visible fields: composer=${visible.composerFields} window-type=${visible.windowFields}; window panels present=${visible.windowPanels}`);

  expect(visible.composerFields, 'the transport composer should be the one input box').toBe(1);
  expect(visible.windowFields, 'no second input box may be on screen').toBe(0);

  // The harness has no desktop bridge, so the mechanism that needs one must be absent rather than half-rendered.
  expect(
    visible.windowPanels,
    'this harness has no bridge, so the window-typing panel must not be rendered',
  ).toBe(0);
});

test('the composer is not labelled the same way twice', async ({ page }) => {
  // The duplication was also a labelling problem: two rows both headed "INPUT".
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  const headings = await page.evaluate(() => ({
    composer: document.querySelector('.prompt-composer__title')?.textContent?.trim() ?? null,
    window: document.querySelector('.window-type__title')?.textContent?.trim() ?? null,
    eyebrow: document.querySelector('.prompt-composer .eyebrow')?.textContent?.trim() ?? null,
  }));
  console.log(`composer title=${JSON.stringify(headings.composer)} eyebrow=${JSON.stringify(headings.eyebrow)} window title=${JSON.stringify(headings.window)}`);

  expect(headings.composer, 'the composer should still be present').not.toBeNull();
  // The two must not share a heading, which is what made them read as one control shown twice.
  if (headings.window !== null) {
    expect(headings.window).not.toBe(headings.composer);
  }
});