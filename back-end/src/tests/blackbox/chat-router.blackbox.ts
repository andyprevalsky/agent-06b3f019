#!/usr/bin/env tsx
/**
 * Black-box tests for chat router stream-derived UI metadata.
 */

import { getWebSearchStreamTitleFromPartialRouterJson } from '../../providers/chat/routerLlm';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import {
  createClosedRouterActionDetector,
  type ClosedRouterAction,
} from '../../providers/chat/routerJsonStream';
import { getPool, poolForModel } from '../../providers/rose/pools';

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
    'Ultra chat uses Lite for both synchronous phases',
    () => {
      const requestedModel = 'rose-labs/rose-1-ultra';
      const selected = selectChatPhaseModels(requestedModel);

      assertEqual(selected.requested, requestedModel, 'persisted requested model');
      assertEqual(selected.router, 'rose-labs/rose-1-lite', 'router model');
      assertEqual(selected.routerProviderRoute, 'shared-openai-priority', 'router provider route');
      assertEqual(selected.generator, 'rose-labs/rose-1-lite', 'generator model');
      assertEqual(
        selected.generatorProviderRoute,
        'openrouter-waterfall',
        'generator provider route'
      );
      const generatorPool = poolForModel(selected.generator);
      assertEqual(generatorPool, 'rose-1-lite', 'generator pool');
      if (!generatorPool) throw new Error('generator model did not resolve to a Rose pool');
      assertEqual(
        getPool(generatorPool).waterfall[0],
        'google/gemini-3.5-flash',
        'generator primary model'
      );
    },
  ],
  [
    'Lite chat keeps Lite for both routing and generation',
    () => {
      const requestedModel = 'rose-labs/rose-1-lite';
      const selected = selectChatPhaseModels(requestedModel);

      assertEqual(selected.router, requestedModel, 'router model');
      assertEqual(selected.generator, requestedModel, 'generator model');
    },
  ],
  [
    'dedicated chat router resolves through the Rose Lite GPT provider model',
    () => {
      const selected = selectChatPhaseModels('rose-labs/rose-1-ultra');
      const poolName = poolForModel(selected.router);

      assertEqual(poolName, 'rose-1-lite', 'router pool');
      if (!poolName) throw new Error('router model did not resolve to a Rose pool');
      assertEqual(getPool(poolName).gptAuthModel, 'gpt-5.6-terra', 'router GPT model');
    },
  ],
  [
    'closed-action detector waits for a complete valid action and fires once',
    () => {
      const detections: ClosedRouterAction[] = [];
      const detect = createClosedRouterActionDetector((action) => {
        detections.push(action);
      });

      detect('{"reasoning":"answer","action":"direct_ans');
      detect('{"reasoning":"answer","action":"not_valid"');
      assertEqual(detections.length, 0, 'incomplete and invalid actions');

      detect('{"reasoning":"search","action":"web_search"');
      detect('{"reasoning":"answer","action":"direct_answer"}');
      assertEqual(JSON.stringify(detections), JSON.stringify(['web_search']), 'one typed action');
    },
  ],
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
