import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/api/client';

/**
 * What the client sends when writing a line into a session.
 *
 * The browser suite cannot check this: it runs with `VITE_STATIC_DEMO=true`, where the app uses a bundled
 * demo API whose `inject` is `async () => undefined`, so no request is ever made. That was measured, not
 * assumed — a request-shape test written in that suite failed with "no request was made", and the cause was
 * the harness rather than the composer.
 *
 * So the request is asserted here, at the client, where the body and headers are decided. `fetch` is stubbed
 * so nothing leaves the process. The service's handling of that request is covered by the CLI suite, and the
 * packaged app was verified separately with a real request aborted before delivery.
 */

const realFetch = globalThis.fetch;

function stubFetch(response: { ok?: boolean; status?: number; json?: unknown } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json ?? {},
    } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('inject', () => {
  it('sends the typed line as a JSON body on the session route', async () => {
    const calls = stubFetch();
    await createApi().inject('codex:17448', '继续，并按上面的计划做完');

    expect(calls).toHaveLength(1);
    const call = calls[0];
    // The id is URL-encoded, because a session id contains a colon.
    expect(call.url).toBe('/api/sessions/codex%3A17448/inject');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe(JSON.stringify({ prompt: '继续，并按上面的计划做完' }));
    expect((call.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('sends no body at all when no prompt is given, so the configured prompt is used', async () => {
    // This is the one-click path. Sending a body here would silently stop using the user's configured
    // continuation prompt, which is a behaviour change nobody asked for.
    const calls = stubFetch();
    await createApi().inject('codex:17448');

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.body).toBeUndefined();
    expect(calls[0].init?.method).toBe('POST');
  });

  it('passes the prompt through unchanged, including non-ASCII and punctuation', async () => {
    const calls = stubFetch();
    const line = '继续，并按上面的计划做完 — 不要改动 public API';
    await createApi().inject('dsh:1', line);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ prompt: line });
  });

  it('reports a failure rather than appearing to succeed', async () => {
    // The composer keeps the draft when this throws, which is why the rejection has to propagate.
    stubFetch({ ok: false, status: 409 });
    await expect(createApi().inject('codex:1', '继续')).rejects.toThrow(/409/u);
  });
});