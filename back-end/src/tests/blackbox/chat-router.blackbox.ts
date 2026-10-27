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
    'Local chat keeps both synchronous phases on the local pool',
    () => {
      const selected = selectChatPhaseModels('rose-labs/rose-local');
      assertEqual(selected.router, 'rose-labs/rose-local', 'router model');
      assertEqual(selected.generator, 'rose-labs/rose-local', 'generator model');
    },
  ],
  [
    'Ultra chat uses rose-fast via direct-cerebras hedge for both synchronous phases',
    () => {
      const requestedModel = 'rose-labs/rose-1-ultra';
      const selected = selectChatPhaseModels(requestedModel);

      assertEqual(selected.requested, requestedModel, 'persisted requested model');
      assertEqual(selected.router, 'rose-labs/rose-1-flash', 'router model');
      assertEqual(selected.routerProviderRoute, 'direct-cerebras', 'router provider route');
      assertEqual(selected.generator, 'rose-labs/rose-1-flash', 'generator model');
      assertEqual(selected.generatorProviderRoute, 'direct-cerebras', 'generator provider route');
      const generatorPool = poolForModel(selected.generator);
      assertEqual(generatorPool, 'rose-1-flash', 'generator pool');
      if (!generatorPool) throw new Error('generator model did not resolve to a Rose pool');
      assertEqual(getPool(generatorPool).cerebrasModel, 'qwen-3.8-27b', 'rose-fast Cerebras hop');
    },
  ],
  [
    'Flash chat keeps Flash for both routing and generation',
    () => {
      const requestedModel = 'rose-labs/rose-1-flash';
      const selected = selectChatPhaseModels(requestedModel);

      assertEqual(selected.router, requestedModel, 'router model');
      assertEqual(selected.generator, requestedModel, 'generator model');
      assertEqual(selected.routerProviderRoute, 'direct-cerebras', 'router hedge route');
      assertEqual(selected.generatorProviderRoute, 'direct-cerebras', 'generator hedge route');
    },
  ],
  [
    'dedicated chat router resolves through the rose-fast pool Cerebras model',
    () => {
      const selected = selectChatPhaseModels('rose-labs/rose-1-ultra');
      const poolName = poolForModel(selected.router);

      assertEqual(poolName, 'rose-1-flash', 'router pool');
      if (!poolName) throw new Error('router model did not resolve to a Rose pool');
      assertEqual(getPool(poolName).cerebrasModel, 'qwen-3.8-27b', 'router Cerebras model');
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
        '{"reasoning":"needs live data","action":"web_search","queries":["best cities to live';

      assertEqual(getWebSearchStreamTitleFromPartialRouterJson(partial), null, 'partial query');
    },
  ],
  [
    'web_search stream title includes the completed query',
    () => {
      const firstOfMany =
        '{"reasoning":"needs live data","action":"web_search","queries":["best cities to live in your 20s","cost of living';
      const legacy =
        '{"reasoning":"needs live data","action":"web_search","query":"best cities to live in your 20s","goal":"","mode":"plan"}';

      for (const [json, label] of [
        [firstOfMany, 'first complete query of several'],
        [legacy, 'legacy cached single query'],
      ]) {
        assertEqual(
          getWebSearchStreamTitleFromPartialRouterJson(json),
          '🔍 Searching the web for best cities to live in your 20s',
          label
        );
      }
    },
  ],
  [
    'non-web-search router actions do not produce web-search tool titles',
    () => {
      const direct =
        '{"reasoning":"answer directly","action":"direct_answer","queries":[],"goal":"","mode":"plan"}';

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
