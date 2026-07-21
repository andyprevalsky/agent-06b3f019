#!/usr/bin/env tsx

import assert from 'node:assert';

process.env.AMPLITUDE_API_KEY = 'test-key';
process.env.AMPLITUDE_SECRET_KEY = 'test-secret';
process.env.AMPLITUDE_API_BASE_URL = 'https://amplitude.test';

const originalFetch = globalThis.fetch;
let funnelAttempts = 0;
let quotaAttempts = 0;
let funnelMode: 'concurrent-once' | 'quota' = 'concurrent-once';

globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === '/api/2/events/list') {
    return Response.json({
      data: [
        { value: '[Amplitude] Page Viewed' },
        { value: 'querybox_clicked' },
        { value: 'goal_typed' },
        { value: 'goal_submitted' },
        { value: 'phone_entered' },
        { value: 'otp_code_submitted' },
      ],
    });
  }
  if (url.pathname === '/api/2/funnels') {
    if (funnelMode === 'quota') {
      quotaAttempts += 1;
      return Response.json(
        {
          error: {
            metadata: { details: 'Too Many Requests: Exceeded five-minute chart query budget' },
          },
        },
        { status: 429 }
      );
    }
    funnelAttempts += 1;
    if (funnelAttempts === 1) {
      return Response.json(
        {
          error: {
            metadata: {
              details: 'Too Many Requests: Exceeded concurrent limit with query of cost 84',
            },
          },
        },
        { status: 429 }
      );
    }
    return Response.json({ data: [{ cumulativeRaw: [100, 80, 60, 40, 30, 20] }] });
  }
  throw new Error(`Unexpected Amplitude test URL: ${url}`);
}) as typeof fetch;

async function main(): Promise<void> {
  const { fetchAmplitudeFunnel } = await import('../../domains/admin-health/amplitude');
  const result = await fetchAmplitudeFunnel(
    new Date('2026-07-01T00:00:00.000Z'),
    new Date('2026-07-08T00:00:00.000Z')
  );

  assert.strictEqual(funnelAttempts, 2, 'a transient concurrency 429 must be retried once');
  assert.deepStrictEqual(result.counts, {
    landing_page_viewed: 100,
    querybox_clicked: 80,
    content_typed: 60,
    goal_submitted: 40,
    phone_entered: 30,
    otp_code_submitted: 20,
  });

  funnelMode = 'quota';
  const quotaResult = await fetchAmplitudeFunnel(
    new Date('2026-06-01T00:00:00.000Z'),
    new Date('2026-06-08T00:00:00.000Z')
  );
  assert.strictEqual(quotaAttempts, 1, 'an ordinary quota 429 must not be retried');
  assert.ok(
    Object.values(quotaResult.counts).every((count) => count === null),
    'a non-concurrency 429 must remain unavailable'
  );
  process.stdout.write('admin-health Amplitude retry test passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
