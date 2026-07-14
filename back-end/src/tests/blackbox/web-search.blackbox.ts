#!/usr/bin/env tsx
/**
 * Black-box contract tests for the provider-facing web search request.
 */

import { executeWebSearch } from '../../providers/chat/chatTools';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  try {
    await fn();
    return { name, passed: true };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.PARRALLEL_API_KEY;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.PARRALLEL_API_KEY = 'parallel-blackbox-key';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Parallel Search Turbo',
            url: 'https://parallel.ai/blog/parallel-search-turbo',
            excerpts: ['Turbo is optimized for latency-sensitive chat.'],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const results: TestResult[] = [];
  try {
    results.push(
      await runTest('web search uses the Parallel V1 Turbo request contract', async () => {
        const result = await executeWebSearch('Parallel Search Turbo latency');

        assert(requests.length === 1, `expected one provider request, got ${requests.length}`);
        const request = requests[0];
        assert(
          request.url === 'https://api.parallel.ai/v1/search',
          `unexpected URL ${request.url}`
        );
        assert(request.init?.method === 'POST', `unexpected method ${request.init?.method}`);

        const headers = new Headers(request.init?.headers);
        assert(headers.get('x-api-key') === 'parallel-blackbox-key', 'missing Parallel API key');
        assert(headers.get('parallel-beta') === null, 'V1 requests must not send the beta header');

        assert(typeof request.init?.body === 'string', 'request body must be JSON');
        const body = JSON.parse(request.init.body) as Record<string, unknown>;
        assert(body.mode === 'turbo', `expected turbo mode, got ${String(body.mode)}`);
        assert(body.objective === 'Parallel Search Turbo latency', 'objective changed');
        assert(
          JSON.stringify(body.search_queries) === JSON.stringify(['Parallel Search Turbo latency']),
          'search query changed'
        );
        assert(body.max_results === undefined, 'V1 max_results must be nested');
        assert(body.excerpts === undefined, 'V1 excerpt settings must be nested');
        assert(
          JSON.stringify(body.advanced_settings) ===
            JSON.stringify({
              max_results: 10,
              excerpt_settings: { max_chars_per_result: 6000 },
            }),
          `unexpected advanced settings ${JSON.stringify(body.advanced_settings)}`
        );

        assert(
          result.sources[0] === 'https://parallel.ai/blog/parallel-search-turbo',
          'source lost'
        );
        assert(result.answer.includes('Turbo is optimized'), 'excerpt lost');
      })
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.PARRALLEL_API_KEY;
    else process.env.PARRALLEL_API_KEY = originalApiKey;
  }

  for (const result of results) {
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}\n`);
    if (result.error) process.stderr.write(`${result.error}\n`);
  }

  const failed = results.filter((result) => !result.passed);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} tests passed\n`);
  if (failed.length > 0) process.exit(1);
}

void main();
