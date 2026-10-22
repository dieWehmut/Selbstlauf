import type { ProxyOptions } from 'vite';
import type { ClientRequest, IncomingMessage } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Rewrite only requests from this local dev page; foreign origins still reach the service unchanged. */
export function rewriteLocalOrigin(proxyRequest: Pick<ClientRequest, 'setHeader'>, request: Pick<IncomingMessage, 'headers'>, targetOrigin: string): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return;
  try {
    const page = new URL(origin);
    if (page.protocol !== 'http:' || !LOOPBACK.has(page.hostname) || page.origin !== new URL(`http://${host}`).origin) return;
    proxyRequest.setHeader('Origin', targetOrigin);
  } catch { /* Invalid origins are forwarded as-is and refused by the service. */ }
}

export function createServiceProxy(target: string): ProxyOptions {
  const url = new URL(target);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) throw new Error('WATCHDOG_PROXY_TARGET must be a local watchdog HTTP origin');
  return {
    target: url.origin, ws: true,
    configure(proxy) {
      const rewrite = (request: ClientRequest, incoming: IncomingMessage) => rewriteLocalOrigin(request, incoming, url.origin);
      proxy.on('proxyReq', rewrite);
      proxy.on('proxyReqWs', rewrite);
    },
  };
}
