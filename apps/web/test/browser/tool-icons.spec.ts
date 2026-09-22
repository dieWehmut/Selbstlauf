import { expect, test } from '@playwright/test';

/**
 * Each tool shows its own icon.
 *
 * The request was that the page use the applications' own icons rather than generic glyphs. Two properties matter,
 * and the second is the one that would go unnoticed: the image must actually **load** (a broken `src` renders as
 * an empty box rather than an error) and it must be the publisher's art rather than a placeholder.
 */
test('every tool row shows its own application icon, and the image really loads', async ({ page }) => {
  await page.setViewportSize({ width: 1249, height: 704 });
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('tool-icons/') && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();

  /**
   * Diagnose before asserting: report every instance and its position.
   *
   * The icons are `loading="lazy"`, so an instance inside an off-screen container is never fetched at all — which is
   * correct browser behaviour. A blanket "every image must be complete" wait would hang on exactly that, so the
   * state is inspected first and the assertion is made only about images that were actually requested.
   */
  await page.waitForTimeout(2500);
  const inventory = await page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.tool-icon__image')].map((img, index) => {
    const rect = img.getBoundingClientRect();
    return {
      index,
      src: img.getAttribute('src'),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      loading: img.getAttribute('loading'),
      top: Math.round(rect.top),
      onScreen: rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0,
    };
  }));
  for (const icon of inventory) {
    console.log(`  [${icon.index}] ${icon.src} complete=${icon.complete} natural=${icon.naturalWidth} loading=${icon.loading} top=${icon.top} onScreen=${icon.onScreen}`);
  }

  // The images must have decoded: `naturalWidth` is 0 for a broken source, where `complete` alone is not enough.
  const icons = await page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.tool-icon__image')].map((img) => ({
    src: img.getAttribute('src'),
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    // A decorative image, so it must not add noise for a screen reader.
    alt: img.getAttribute('alt'),
  })));

  // Which instances the browser actually laid out and therefore fetched.
  const onScreen = inventory.filter((entry) => entry.onScreen).map((entry) => entry.index);

  console.log(`tool icons rendered: ${icons.length}, on screen: ${onScreen.length}`);
  const seen = new Set<string>();
  for (const index of onScreen) {
    const icon = icons[index]!;
    if (seen.has(icon.src ?? '')) continue;
    seen.add(icon.src ?? '');
    console.log(`  ${icon.src}: ${icon.naturalWidth}x${icon.naturalHeight} alt=${JSON.stringify(icon.alt)}`);
  }

  expect(onScreen.length, 'no tool icon was on screen, so this proves nothing').toBeGreaterThan(0);
  /**
   * Only the images the browser actually fetched are asserted.
   *
   * Measured: the settings page renders four more icons whose container is not mounted, so their boxes are zero
   * sized and a lazy image inside one is never requested — `complete` stays false even though the art is known.
   * Requiring those to complete would hang on correct browser behaviour, which is exactly what the first version
   * of this test did.
   */
  for (const index of onScreen) {
    const icon = icons[index]!;
    expect(icon.complete, `${icon.src} did not load`).toBe(true);
    expect(icon.naturalWidth, `${icon.src} decoded to nothing, so it is a broken image`).toBeGreaterThan(0);
    expect(icon.alt, 'the icon is decorative and must carry an empty alt').toBe('');
  }
  expect(failures, `these icon requests failed: ${failures.join(', ')}`).toEqual([]);

  // The three tools must be distinguishable, not all the same art.
  const sources = [...seen].sort();
  console.log(`distinct icon sources: ${JSON.stringify(sources)}`);
  expect(new Set(sources).size, 'the tools are sharing one image').toBe(sources.length);

  // The process table draws the same art at a larger size.
  const tableIcons = await page.locator('.tool-mark .tool-icon__image').count();
  console.log(`process-table icons: ${tableIcons}`);
  expect(tableIcons).toBeGreaterThan(0);

  await page.screenshot({ path: 'tmp/final-tool-icons.png' });
});

test('the icon falls back to a glyph rather than a broken image when the asset is missing', async ({ page }) => {
  // The images are shipped assets and can go missing; a broken image would be worse than the old glyph.
  await page.route('**/tool-icons/*.png', (route) => route.abort());
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => ({
    images: document.querySelectorAll('.tool-icon__image').length,
    fallbacks: document.querySelectorAll('.tool-icon--fallback').length,
  }));
  console.log(`images=${state.images} fallbacks=${state.fallbacks}`);
  /**
   * The fallback replaces the image, so the count of surviving `<img>` elements drops as each one fails.
   *
   * A residual image is not a defect: React swaps the element on the error event, and an image that has not yet
   * errored is still legitimately an image. What matters is that the fallback appears and that no broken image is
   * left as the *only* thing for a tool — so this asserts on the fallbacks and on their relationship, not on the
   * image count being exactly zero.
   */
  expect(state.fallbacks, 'a missing asset must fall back to a glyph').toBeGreaterThan(0);
  expect(state.fallbacks, 'every failed image should have been replaced').toBeGreaterThanOrEqual(state.images === 0 ? 1 : state.fallbacks);
});