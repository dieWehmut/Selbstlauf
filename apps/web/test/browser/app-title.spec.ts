import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The name in the taskbar and the browser tab.
 *
 * The desktop shell creates its window with `DEFAULT_WINDOW_POLICY.title` = `Selbstlauf Console`, and Electron then
 * follows `document.title` once the page loads — so the `<title>` in `index.html` is what a person actually reads in
 * the taskbar, the Alt-Tab list and the browser tab. It said **Continuation Watchdog**, which is the product's
 * description (the account popup shows it as the subtitle under `Selbstlauf`), while the tray tooltip, the window
 * policy and the app's own header all name the product.
 *
 * The policy is read from its source rather than restated here: if the deskop window title changes, this fails and
 * points at both files instead of quietly agreeing with a stale copy.
 */
function windowPolicyTitle(): string {
  const source = readFileSync(join(process.cwd(), '..', 'desktop', 'src', 'navigation.ts'), 'utf8');
  const policy = /DEFAULT_WINDOW_POLICY\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/u.exec(source);
  if (policy === null) throw new Error('DEFAULT_WINDOW_POLICY was not found in apps/desktop/src/navigation.ts');
  const title = /title:\s*'([^']+)'/u.exec(policy[1]);
  if (title === null) throw new Error('DEFAULT_WINDOW_POLICY has no title');
  return title[1];
}

test('the page title is the name the desktop window and the tray use', async ({ page }) => {
  const expected = windowPolicyTitle();
  expect(expected, 'the desktop window policy lost its title').toBe('Selbstlauf Console');

  await page.goto('/');
  await expect(page).toHaveTitle(expected);

  // And the product's own header agrees with it, rather than the description standing in for the name.
  await page.getByRole('button', { name: /个进程/u }).click();
  const popup = page.getByRole('region', { name: '账户与状态' });
  await expect(popup.locator('strong').first()).toHaveText('Selbstlauf');
});