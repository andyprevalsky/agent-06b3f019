/** Review regressions use real key validation and sealed authority/provider transports. */
import assert from 'node:assert/strict';
import { RoseInvalidRequest, RoseServerError } from '../../providers/rose/errors';
import type { RoseStreamChunk } from '../../providers/rose/types';

type Report = { retryAfterSeconds?: number };
type Context = {
  configure: (
    handler: (region: string, deployment: string) => Response,
    regions?: string[],
    deployments?: string,
    report?: (body: Report) => void
  ) => Array<[string, string]>;
  drain: (key: string) => Promise<RoseStreamChunk[]>;
  keyWithPrimary: (region: string) => string;
  text: (chunks: RoseStreamChunk[]) => unknown;
  primary: string;
  fallback: string;
};
const ok = (): Response =>
  new Response('data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: [DONE]\n\n');

export async function runFoundryReviewCases(c: Context): Promise<void> {
  const failures: unknown[] = [];
  const check = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
  };
  const date = new Date(Date.now() + 900_000).toUTCString();
  const cases: Array<[Record<string, string>, string, number | undefined]> = [
    [{ 'retry-after-ms': '5000', 'retry-after': '900' }, '', 5],
    [{ 'retry-after': '900' }, '', 900],
    [{ 'retry-after': date }, '', 900],
    [{ 'retry-after-ms': '1e100', 'retry-after': '900' }, '', 900],
    [{ 'retry-after-ms': '1e100' }, '', undefined],
    [{ 'retry-after': '1e100' }, '', undefined],
    [{ 'retry-after': '-1' }, '', undefined],
    [{ 'retry-after': '0' }, '', undefined],
    [{ 'retry-after': 'not-a-date' }, '', undefined],
    [{ 'retry-after': new Date(0).toUTCString() }, '', undefined],
    [{}, 'try again in 900 seconds', 900],
    [{}, `try again in ${'9'.repeat(110)} seconds`, undefined],
  ];
  for (const [headers, message, expected] of cases)
    await check(async () => {
      const reports: Report[] = [];
      const attempts = c.configure(
        (region) => {
          if (region !== c.primary) return ok();
          if (!message) return new Response('', { status: 429, headers });
          const error = { code: 'rate_limit_exceeded', message };
          return new Response(
            `data: ${JSON.stringify({ type: 'response.failed', response: { error } })}\n\ndata: [DONE]\n\n`,
            { status: 200, headers }
          );
        },
        [c.primary, c.fallback],
        'gpt-6-sol',
        (body) => reports.push(body)
      );
      const beforeDrain = Date.now();
      const chunks = await c.drain(c.keyWithPrimary(c.primary));
      const afterDrain = Date.now();
      assert.equal(c.text(chunks), 'Hi');
      assert.equal(attempts.length, 2, 'retry advice must preserve fallback');
      assert.equal(reports.length, 1);
      if (headers['retry-after'] === date) {
        const reported = reports[0].retryAfterSeconds ?? 0;
        const deadline = Date.parse(date);
        assert(reported > 300, 'HTTP-date advice must retain a delay above 300 seconds');
        assert(reported >= (deadline - afterDrain) / 1000, JSON.stringify(reports));
        assert(reported <= (deadline - beforeDrain) / 1000, JSON.stringify(reports));
      } else if (expected === undefined) assert.equal(reports[0].retryAfterSeconds, undefined);
      else
        assert(
          Math.abs((reports[0].retryAfterSeconds ?? 0) - expected) < 2,
          JSON.stringify(reports)
        );
    });
  for (const [regions, deployments] of [
    [[c.primary, 'https://bad_host.example.test'], 'gpt-6-sol'],
    [[c.primary], 'gpt-6-sol,gpt-6-sol-invalid!'],
  ] as Array<[string[], string]>)
    await check(async () => {
      const attempts = c.configure(ok, regions, deployments);
      assert.equal(c.text(await c.drain('review-invalid-route')), 'Hi');
      assert.deepEqual(
        attempts,
        [[c.primary, 'gpt-6-sol']],
        'invalid entries never reach provider'
      );
    });
  await check(async () => {
    c.configure(ok, ['https://bad_host.example.test']);
    await assert.rejects(c.drain('review-all-invalid'), RoseInvalidRequest);
  });
  const attempts = c.configure(ok, [c.primary]);
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) =>
    new URL(String(input)).hostname === 'authority.example.test'
      ? new Response('', { status: 500 })
      : fetch(input, init)) as typeof fetch;
  try {
    await assert.rejects(c.drain('review-authority-down'), RoseServerError);
  } finally {
    globalThis.fetch = fetch;
  }
  assert.deepEqual(attempts, [], 'genuine authority outage stays fail closed');
  if (failures.length) throw new AggregateError(failures, 'Foundry review regression failures');
  process.stdout.write(
    'Foundry review: retry hints, invalid routes, configuration and authority failures verified\n'
  );
}
