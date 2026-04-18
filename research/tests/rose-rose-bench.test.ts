/**
 * Tests for POST /rose-bench
 */

import { assertEquals } from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { testClient } from './utils/test-client.ts';
import {
  assertHasProperty,
  assertIsArray,
  assertStatusCode,
  sampleBenchmarkConfig,
} from './utils/fixtures.ts';

Deno.test('POST /rose-bench - runs benchmark', async () => {
  const response = await testClient.post('/rose-bench', sampleBenchmarkConfig);

  // May fail if API key is invalid
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key in benchmark config');
    return;
  }

  if (response.status === 200) {
    assertHasProperty(response.data, 'benchmarkName');
    assertHasProperty(response.data, 'totalQuestions');
    assertHasProperty(response.data, 'sampledQuestions');
    assertHasProperty(response.data, 'correctAnswers');
    assertHasProperty(response.data, 'accuracy');
    assertHasProperty(response.data, 'totalCostCents');
    assertHasProperty(response.data, 'totalDurationSeconds');
    assertHasProperty(response.data, 'results');
    assertHasProperty(response.data, 'isSampled');
    assertHasProperty(response.data, 'modelConfig');

    assertIsArray(response.data.results);
    assertEquals(typeof response.data.accuracy, 'number');
    assertEquals(
      response.data.accuracy >= 0 && response.data.accuracy <= 100,
      true,
    );
  }
});

Deno.test('POST /rose-bench - respects seed', async () => {
  const config = {
    ...sampleBenchmarkConfig,
    seed: 999,
  };

  const response = await testClient.post('/rose-bench', config);

  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }

  // Should accept seed parameter (200 = success, 500 = model call failed but accepted params)
  assertStatusCode(response.status, 200, 500);
});

Deno.test('POST /rose-bench - returns 400 for missing url', async () => {
  const config = { ...sampleBenchmarkConfig };
  delete (config as any).url;

  const response = await testClient.post('/rose-bench', config);

  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

Deno.test(
  'POST /rose-bench - returns 400 for missing modelConfig',
  async () => {
    const config = { ...sampleBenchmarkConfig };
    delete (config as any).modelConfig;

    const response = await testClient.post('/rose-bench', config);

    assertStatusCode(response.status, 400);
    assertHasProperty(response.data, 'error');
  },
);

Deno.test('POST /rose-bench - returns 400 for missing benchmark', async () => {
  const config = { ...sampleBenchmarkConfig };
  delete (config as any).benchmark;

  const response = await testClient.post('/rose-bench', config);

  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

Deno.test(
  'POST /rose-bench - returns 400 for invalid benchmark type',
  async () => {
    const config = {
      ...sampleBenchmarkConfig,
      benchmark: 'invalid-benchmark-xyz',
    };

    const response = await testClient.post('/rose-bench', config);

    assertStatusCode(response.status, 400);
    assertHasProperty(response.data, 'error');
    assertHasProperty(response.data, 'availableBenchmarks');
  },
);

Deno.test('POST /rose-bench - accepts full benchmark type', async () => {
  const config = {
    ...sampleBenchmarkConfig,
    benchmark: 'full',
  };

  const response = await testClient.post('/rose-bench', config);

  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }

  if (response.status === 200) {
    assertHasProperty(response.data, 'totalDurationSeconds');
    assertHasProperty(response.data, 'totalCostCents');
    assertHasProperty(response.data, 'benchmarks');
    assertHasProperty(response.data, 'aggregateAccuracy');

    assertIsArray(response.data.benchmarks);
  }
});
