import { expect, it, vi } from 'vitest';
import { createServiceProxy, rewriteLocalOrigin } from '../dev-proxy';

it('proxies HTTP and WebSocket to the local service', () => {
  const proxy = createServiceProxy('http://127.0.0.1:48920');
  expect(proxy.ws).toBe(true); expect(proxy.target).toBe('http://127.0.0.1:48920');
});

it('rewrites the dev page origin, including its actual selected port', () => {
  const setHeader = vi.fn();
  rewriteLocalOrigin({ setHeader }, { headers: { origin: 'http://127.0.0.1:4175', host: '127.0.0.1:4175' } }, 'http://127.0.0.1:48920');
  expect(setHeader).toHaveBeenCalledWith('Origin', 'http://127.0.0.1:48920');
});

it('keeps foreign and other-port origins unchanged so the service can reject them', () => {
  const setHeader = vi.fn();
  for (const origin of ['https://example.com', 'http://127.0.0.1:4174', 'null']) {
    rewriteLocalOrigin({ setHeader }, { headers: { origin, host: '127.0.0.1:4175' } }, 'http://127.0.0.1:48920');
  }
  expect(setHeader).not.toHaveBeenCalled();
});
