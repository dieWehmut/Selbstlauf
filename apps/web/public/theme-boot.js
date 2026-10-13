/**
 * Paint the saved theme before the bundle runs.
 *
 * The saved preference and palette live in localStorage and are read by `src/App.tsx`, so nothing
 * knows about them until the bundle has loaded and React has rendered. Until then the stylesheet's
 * own `:root` literals paint — the *dark* ones — so a user whose saved theme is light, or who saved
 * a light custom palette, got a **black first frame on every launch**. Measured against the built
 * app with the bundle blocked and a light palette saved: html and body `rgb(0, 0, 0)`,
 * `color-scheme: dark`, `--bg #000000`, and `data-theme` unset. The desktop shell reveals its window
 * on first paint, so that frame is what the user sees.
 *
 * This is a file rather than an inline `<script>` because the service that serves this bundle sends
 * `script-src 'self'` (see `apps/cli/src/server/http-server.ts`): an inline block would be blocked
 * there, in the packaged app and the desktop shell. It is deliberately neither a module nor deferred —
 * it has to have run before the first paint.
 *
 * Keep the rules in step with `resolveTheme()` and the `useState` initialiser that reads
 * `watchdog-theme` in `src/App.tsx` — including its sanitising: anything that is not
 * `light`/`dark`/`system` resolves to `dark`, *not* to the system preference, and a boot script that
 * disagreed would paint one theme and be corrected to another. Keep it total, too: a corrupt
 * preference is the app's problem to repair, not a reason not to start.
 */
(() => {
  try {
    const preference = localStorage.getItem('watchdog-theme');
    const chosen = preference === 'light' || preference === 'dark' || preference === 'system' ? preference : 'dark';
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    const theme = chosen === 'system' ? (prefersLight ? 'light' : 'dark') : chosen;
    document.documentElement.dataset.theme = theme;

    const stored = JSON.parse(localStorage.getItem('watchdog-palette') ?? '{}');
    const palettes = stored !== null && typeof stored === 'object' ? stored : {};
    const saved = palettes[theme] !== null && typeof palettes[theme] === 'object' ? palettes[theme] : {};
    // Only the three colours the page needs before anything is painted: the background it shows, the
    // text on it, and the accent for an empty shell. Everything else is derived after the bundle runs.
    const boot = { '--bg': saved.background, '--text': saved.foreground, '--accent': saved.accent };
    const readable = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
    for (const name of Object.keys(boot)) {
      if (readable(boot[name])) document.documentElement.style.setProperty(name, boot[name]);
    }

    // The browser tints its own chrome with `theme-color`, which shipped as a static dark literal.
    // A saved background has to reach it before the bundle as well, or a light-theme user's tab strip
    // stays dark until the app has run. The app keeps it in step afterwards.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta !== null && readable(boot['--bg'])) meta.setAttribute('content', boot['--bg']);

    // The saved density too: the compact rules change the settings sections and the process table, so
    // a user who chose them should not watch comfortable spacing correct itself on the first frame.
    const storedPersonalization = JSON.parse(localStorage.getItem('watchdog-personalization') ?? '{}');
    const personalization = storedPersonalization !== null && typeof storedPersonalization === 'object' ? storedPersonalization : {};
    document.documentElement.dataset.density = personalization.density === 'compact' ? 'compact' : 'comfortable';
  } catch {
    // A corrupt or unreadable preference must not stop the app from loading.
  }
})();