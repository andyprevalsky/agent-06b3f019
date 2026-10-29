import nodeAssert from 'node:assert/strict';
import { getBrowserUseSessionHealth } from '../../providers/browser/browserUse';

export async function assertBrowserUseMissingHealth() {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.BROWSER_USE_API_KEY;
  process.env.BROWSER_USE_API_KEY = 'fixture-key';
  try {
    for (const status of [404, 401, 429, 500]) {
      globalThis.fetch = (async () => new Response('fixture error', { status })) as typeof fetch;
      if (status === 404) {
        const health = await getBrowserUseSessionHealth('missing-session');
        nodeAssert.equal(health.sessionId, 'missing-session');
        nodeAssert.equal(health.status, 'deleted');
      } else {
        await nodeAssert.rejects(
          getBrowserUseSessionHealth('missing-session'),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            error.status === status
        );
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.BROWSER_USE_API_KEY;
    else process.env.BROWSER_USE_API_KEY = previousKey;
  }
}
