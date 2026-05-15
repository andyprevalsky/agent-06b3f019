#!/usr/bin/env tsx
/**
 * Black-box tests for chat router stream-derived UI metadata.
 */

import { getWebSearchStreamTitleFromPartialRouterJson } from '../../providers/chat/routerLlm';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

const tests: Array<[string, () => Promise<void> | void]> = [
  [
    'web_search stream title stays null until query is complete',
    () => {
      const partial =
        '{"reasoning":"needs live data","action":"web_search","query":"best cities to live';

      assertEqual(getWebSearchStreamTitleFromPartialRouterJson(partial), null, 'partial query');
    },
  ],
  [
    'web_search stream title includes the completed query',
    () => {
      const complete =
        '{"reasoning":"needs live data","action":"web_search","query":"best cities to live in your 20s","goal":"","mode":"plan"}';

      assertEqual(
        getWebSearchStreamTitleFromPartialRouterJson(complete),
        '🔍 Searching the web for best cities to live in your 20s',
        'complete query title'
      );
    },
  ],
  [
    'non-web-search router actions do not produce web-search tool titles',
    () => {
      const direct =
        '{"reasoning":"answer directly","action":"direct_answer","query":"","goal":"","mode":"plan"}';

      assertEqual(getWebSearchStreamTitleFromPartialRouterJson(direct), null, 'direct answer');
    },
  ],
];

async function main(): Promise<void> {
  const results: TestResult[] = [];
  for (const [name, fn] of tests) {
    results.push(await runTest(name, fn));
  }

  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`${status} ${result.name} (${result.duration}ms)\n`);
    if (result.error) process.stderr.write(`${result.error}\n`);
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} tests passed\n`);
  if (failed.length > 0) process.exit(1);
}

void main();
