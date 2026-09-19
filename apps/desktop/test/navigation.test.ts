import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WINDOW_POLICY,
  TITLE_BAR_OVERLAY,
  applyNavigationPolicy,
  createWindowOptions,
  isServiceUrl,
  shouldOpenExternally,
  type NavigationPolicyTarget,
} from '../src/navigation.js';

const ORIGIN = 'http://127.0.0.1:48920';

test('treats the local service origin as in-window', () => {
  assert.equal(isServiceUrl('http://127.0.0.1:48920/', ORIGIN), true);
  assert.equal(isServiceUrl('http://127.0.0.1:48920/assets/index.js', ORIGIN), true);
  assert.equal(isServiceUrl('/api/health', ORIGIN), true);
  assert.equal(isServiceUrl('http://127.0.0.1:48921/', ORIGIN), false, 'another local port is not the service');
  assert.equal(isServiceUrl('http://localhost:48920/', ORIGIN), false, 'a different host spelling is a different origin');
  assert.equal(isServiceUrl('https://example.com/', ORIGIN), false);
  assert.equal(isServiceUrl('http://127.0.0.1:48920@evil.example/', ORIGIN), false, 'userinfo cannot spoof the origin');
  assert.equal(isServiceUrl('', ORIGIN), false);
  assert.equal(isServiceUrl('http://', ORIGIN), false, 'an unparseable URL never matches');
});

test('only absolute http(s) links are handed to the OS browser', () => {
  assert.equal(shouldOpenExternally('https://github.com/dieWehmut/Selbstlauf'), true);
  assert.equal(shouldOpenExternally('http://example.com'), true);
  assert.equal(shouldOpenExternally('javascript:alert(1)'), false);
  assert.equal(shouldOpenExternally('file:///C:/Windows/System32/drivers/etc/hosts'), false);
  assert.equal(shouldOpenExternally('ms-settings:'), false);
  assert.equal(shouldOpenExternally(''), false);
});

test('rejects a non-absolute service origin', () => {
  assert.throws(() => createWindowOptions({ serviceOrigin: '127.0.0.1:48920' }), /absolute http/u);
  assert.throws(() => createWindowOptions({ serviceOrigin: 'file:///srv/index.html' }), /absolute http/u);
});

test('hardens the renderer and hides the window until it has painted', () => {
  const options = createWindowOptions({ serviceOrigin: ORIGIN });
  assert.equal(options.contextIsolation, true);
  assert.equal(options.nodeIntegration, false);
  assert.equal(options.sandbox, true);
  assert.equal(options.webSecurity, true);
  assert.equal(options.allowRunningInsecureContent, false);
  assert.equal(options.webviewTag, false);
  assert.equal(options.show, false);
  assert.equal(options.title, DEFAULT_WINDOW_POLICY.title);
  assert.equal(options.width, DEFAULT_WINDOW_POLICY.width);
  assert.equal(options.minWidth, DEFAULT_WINDOW_POLICY.minWidth);
  assert.equal(options.backgroundColor, DEFAULT_WINDOW_POLICY.backgroundColor);
});

test('allows caller overrides without dropping the security defaults', () => {
  const options = createWindowOptions({ serviceOrigin: ORIGIN, title: 'Custom', width: 1024 });
  assert.equal(options.title, 'Custom');
  assert.equal(options.width, 1024);
  assert.equal(options.sandbox, true);
  assert.equal(options.contextIsolation, true);
});

test('draws the title bar in the page while the window controls stay native', () => {
  const options = createWindowOptions({ serviceOrigin: ORIGIN });
  // Hidden chrome + an overlay gives the renderer the whole top row while the OS
  // keeps owning (and hit-testing) minimise / maximise-restore / close.
  assert.equal(options.titleBarStyle, 'hidden');
  assert.deepEqual(options.titleBarOverlay, TITLE_BAR_OVERLAY);
  assert.equal(options.titleBarOverlay.height, 40);
  /**
   * Regression: this was `#0b1120` while the page painted its title bar
   * `#1a1e22`, so the OS window buttons sat on a visibly different strip and the
   * top row read as two pieces. Measured on a real window at 1456x908.
   */
  assert.equal(
    options.titleBarOverlay.color,
    '#1a1e22',
    'the overlay must match the built-in dark title bar (--panel-soft)',
  );
  assert.notEqual(options.titleBarOverlay.color, '#0b1120', 'the old mismatched colour must not return');
  assert.equal(options.titleBarOverlay.symbolColor, '#e9eef0');
  // The overlay is frozen so the renderer's reserve cannot drift from the window.
  assert.equal(Object.isFrozen(TITLE_BAR_OVERLAY), true);
  // The OS menu bar stays out of the way; the renderer draws its own row.
  assert.equal(options.autoHideMenuBar, true);
  // Branding is untouched by the custom chrome.
  assert.equal(options.title, DEFAULT_WINDOW_POLICY.title);
});

test('keeps every renderer hardening flag with the custom title bar', () => {
  const options = createWindowOptions({ serviceOrigin: ORIGIN });
  assert.equal(options.contextIsolation, true);
  assert.equal(options.sandbox, true);
  assert.equal(options.nodeIntegration, false);
  assert.equal(options.webSecurity, true);
  assert.equal(options.allowRunningInsecureContent, false);
  assert.equal(options.webviewTag, false);
  // The window still waits for its first paint before it is revealed.
  assert.equal(options.show, false);
});

interface NavigateEvent {
  prevented: number;
  preventDefault(): void;
}

function navigateEvent(): NavigateEvent {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented += 1;
    },
  };
}

test('denies new windows, forwards external links, and blocks webviews', () => {
  const events = new Map<string, (event: NavigateEvent, url: string) => void>();
  const opened: string[] = [];
  let windowOpen: ((details: { url: string }) => { action: 'deny' }) | null = null;
  const webContents = {
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
      windowOpen = handler;
    },
    on: (event: string, listener: (event: NavigateEvent, url: string) => void) => {
      events.set(event, listener);
    },
  };

  applyNavigationPolicy({
    webContents: webContents as unknown as NavigationPolicyTarget,
    serviceOrigin: ORIGIN,
    openExternal: (url) => opened.push(url),
  });

  assert.equal(typeof windowOpen, 'function');
  assert.deepEqual(windowOpen!({ url: 'https://example.com/doc' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/doc']);
  assert.deepEqual(windowOpen!({ url: 'http://127.0.0.1:48920/api/health' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/doc'], 'in-service links stay in the window');

  const navigate = events.get('will-navigate');
  assert.ok(navigate, 'a will-navigate listener is registered');

  const allowed = navigateEvent();
  navigate!(allowed, 'http://127.0.0.1:48920/settings');
  assert.equal(allowed.prevented, 0, 'in-service navigation is allowed');

  const blocked = navigateEvent();
  navigate!(blocked, 'https://evil.example/');
  assert.equal(blocked.prevented, 1);
  assert.deepEqual(opened, ['https://example.com/doc', 'https://evil.example/']);

  const script = navigateEvent();
  navigate!(script, 'javascript:alert(1)');
  assert.equal(script.prevented, 1, 'javascript: URLs never reach the OS browser');
  assert.equal(opened.length, 2);

  const webview = events.get('will-attach-webview');
  assert.ok(webview, 'webview attachment is disabled');
  const attach = navigateEvent();
  webview!(attach, '');
  assert.equal(attach.prevented, 1);
});

