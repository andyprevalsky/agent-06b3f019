import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

describe('blackbox harness smoke', () => {
  beforeEach(() => {
    clearCaptures();
    clearFetchCaptures();
  });

  it('MSW intercepts fetch and capture records the request', async () => {
    server.use(http.get('https://example.test/ping', () => HttpResponse.json({ ok: true })));

    const res = await fetch('https://example.test/ping');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe('https://example.test/ping');
    expect(capturedRequests[0].method).toBe('GET');
  });

  it('clearCaptures empties the buffer', async () => {
    server.use(http.get('https://example.test/x', () => HttpResponse.json({})));
    await fetch('https://example.test/x');
    expect(capturedRequests.length).toBeGreaterThan(0);
    clearCaptures();
    expect(capturedRequests).toHaveLength(0);
  });

  it('onUnhandledRequest:error fails on a missing handler', async () => {
    await expect(fetch('https://unhandled.test/nope')).rejects.toThrow();
  });

  it('fetch-capture wrapper records outbound calls in main-process-style tests', async () => {
    const restore = installFetchCapture({
      '/api/widgets': () =>
        new Response(JSON.stringify({ widgets: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const res = await fetch('https://backend.test/api/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(fetchCaptures).toHaveLength(1);
    expect(fetchCaptures[0].url).toContain('/api/widgets');
    expect(fetchCaptures[0].method).toBe('POST');
    expect(fetchCaptures[0].body).toBe(JSON.stringify({ name: 'test' }));

    restore();
  });
});
