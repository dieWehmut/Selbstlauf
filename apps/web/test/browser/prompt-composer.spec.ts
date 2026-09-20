import { expect, test } from '@playwright/test';

/**
 * The field for writing a line into a session, in a real browser.
 *
 * The unit tests run in jsdom, which cannot exercise real paste behaviour: `<input type="text">` applies
 * the HTML value-sanitization algorithm, and only a browser shows what that does to a pasted multi-line
 * block. That is where the defect was found — a pasted `line one\nline two` arrives with the breaks
 * deleted, so the text is corrupted before any validation could object.
 */
test('the composer explains where the text goes and enforces its rules', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  const composer = page.locator('.prompt-composer');
  await expect(composer).toBeVisible();
  const field = composer.getByLabel('要发送到该会话的文字');
  const send = composer.getByRole('button', { name: /发送到 PID \d+/u });

  // Empty: nothing to send, and the button says so by being disabled.
  await expect(send).toBeDisabled();

  // Whitespace alone is refused in words rather than by a silent no-op.
  await field.fill('   ');
  await expect(send).toBeDisabled();
  await expect(composer.getByRole('alert')).toContainText('请输入');

  // A real line enables it.
  await field.fill('继续，并按上面的计划做完');
  await expect(send).toBeEnabled();
  await expect(composer.locator('.prompt-composer__hint')).toContainText('立即续写');

  // The field is single-line, so Enter submits the form rather than inserting a break.
  await expect(field).toHaveAttribute('type', 'text');
  await expect(field).toHaveAttribute('maxlength', '4096');

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('a pasted multi-line block keeps its words', async ({ page, context }) => {
  // The browser strips CR/LF from a single-line field. Without the paste handler the words run together;
  // this asserts they are separated instead, which is the difference between readable text and corruption.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await page.setViewportSize({ width: 1249, height: 704 });
  await page.goto('/');
  await page.locator('.sidebar-row__open').first().click();
  await expect(page.getByRole('heading', { name: '进程详情' })).toBeVisible();

  const field = page.locator('.prompt-composer').getByLabel('要发送到该会话的文字');
  await field.click();
  // Paste through a synthetic event, since driving the OS clipboard is not reliable in this harness.
  await field.evaluate((el) => {
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'line one\nline two\nline three' },
    });
    el.dispatchEvent(paste);
  });

  const value = await field.inputValue();
  console.log(`after pasting three lines the field holds: ${JSON.stringify(value)}`);
  expect(value, 'the pasted words must not run together').toContain('line one line two line three');
  expect(value).not.toContain('\n');
});