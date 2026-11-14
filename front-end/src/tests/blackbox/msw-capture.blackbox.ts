import { describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';

import { capturedRequests, clearCaptures, installCapture } from './msw/capture';

function listener() {
  const subject = setupServer();
  let receive!: (event: { request: Request }) => Promise<void>;
  const on = subject.events.on.bind(subject.events);
  vi.spyOn(subject.events, 'on').mockImplementation((name, callback, options) => {
    receive = callback as typeof receive;
    return on(name, callback, options);
  });
  installCapture(subject);
  return (request: Request) => receive({ request });
}

describe('MSW capture intervals', () => {
  it('excludes a pre-clear request whose body completes later and preserves post-clear data', async () => {
    const receive = listener();
    let finishBody!: (body: string) => void;
    const body = new Promise<string>((resolve) => {
      finishBody = resolve;
    });
    const before = new Request('http://localhost:3001/api/before-clear', { method: 'POST' });
    const cloned = before.clone();
    vi.spyOn(cloned, 'text').mockReturnValue(body);
    vi.spyOn(before, 'clone').mockReturnValue(cloned);
    const pending = receive(before);

    clearCaptures();
    const after = new Request('http://localhost:3001/api/after-clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-capture-fixture': 'after' },
      body: JSON.stringify({ fixture: 'current-interval' }),
    });
    await receive(after);
    finishBody(JSON.stringify({ fixture: 'prior-interval' }));
    await pending;

    expect(
      capturedRequests.map(({ method, url }) => ({ method, path: new URL(url).pathname })),
    ).toEqual([{ method: 'POST', path: '/api/after-clear' }]);
    expect(capturedRequests[0].body).toEqual({ fixture: 'current-interval' });
    expect(capturedRequests[0].headers['x-capture-fixture']).toBe('after');
  });

  it('keeps ordinary in-interval captures and does not filter API routes', async () => {
    const receive = listener();
    clearCaptures();
    await receive(new Request('http://localhost:3001/api/ordinary-get'));
    await receive(
      new Request('http://localhost:3001/api/ordinary-post', {
        method: 'POST',
        body: 'plain fixture body',
      }),
    );
    expect(capturedRequests.map(({ method }) => method)).toEqual(['GET', 'POST']);
    expect(capturedRequests.map(({ body }) => body)).toEqual([null, 'plain fixture body']);
  });
});
