import assert from 'node:assert/strict';

import { PRODUCTION_WEB_ORIGINS } from '../../providers/corsConfig';
import {
  AUTH_CORS_PATHS,
  runAuthCorsPreflights,
  type FetchForCorsProbe,
} from '../../providers/corsSmoke';

async function main(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const successfulFetch: FetchForCorsProbe = async (url, init) => {
    calls.push({ url, init });
    const headers = new Headers(init.headers);
    const origin = headers.get('Origin') ?? '';
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      },
    });
  };

  const results = await runAuthCorsPreflights('https://backend.example', successfulFetch);
  assert.equal(results.length, PRODUCTION_WEB_ORIGINS.length * AUTH_CORS_PATHS.length);
  assert.equal(calls.length, results.length);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(
    new Set(calls.map((call) => call.url)),
    new Set(AUTH_CORS_PATHS.map((path) => `https://backend.example${path}`))
  );
  assert.ok(
    calls.every(
      (call) =>
        call.init.method === 'OPTIONS' &&
        new Headers(call.init.headers).get('Access-Control-Request-Method') === 'POST' &&
        new Headers(call.init.headers).get('Access-Control-Request-Headers') === 'content-type'
    )
  );

  const rejectedResults = await runAuthCorsPreflights(
    'https://backend.example',
    async () => new Response(null, { status: 200 })
  );
  assert.ok(rejectedResults.every((result) => !result.ok));
  assert.ok(rejectedResults.every((result) => result.error?.includes('expected status 204')));

  const timedOutResults = await runAuthCorsPreflights(
    'https://backend.example',
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init.signal);
        init.signal.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    5
  );
  assert.ok(timedOutResults.every((result) => !result.ok));
  assert.ok(timedOutResults.every((result) => result.error?.includes('timed out after 5ms')));

  process.stdout.write('CORS production smoke contracts passed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
