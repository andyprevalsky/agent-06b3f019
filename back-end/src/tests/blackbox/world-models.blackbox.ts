#!/usr/bin/env tsx

import assert from 'node:assert';
import { createSession, listWorldModels, stepSession } from '../../domains/world-models/service';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function withMockedFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>
): () => Promise<void> {
  return async () => {
    const originalFetch = global.fetch;
    const originalBaseUrl = process.env.WMH_BASE_URL;
    process.env.WMH_BASE_URL = 'https://wmh.example.test/';
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return handler(url, init);
    }) as typeof fetch;
    try {
      await fn();
    } finally {
      global.fetch = originalFetch;
      if (originalBaseUrl === undefined) delete process.env.WMH_BASE_URL;
      else process.env.WMH_BASE_URL = originalBaseUrl;
    }
  };
}

async function testListWorldModelsProxiesUpstreamShape(): Promise<void> {
  const calls: string[] = [];
  await withMockedFetch(
    async (url) => {
      calls.push(url);
      return Response.json({ world_models: ['rose-golden'] });
    },
    async () => {
      assert.deepStrictEqual(await listWorldModels(), { world_models: ['rose-golden'] });
      assert.deepStrictEqual(calls, ['https://wmh.example.test/world_models']);
    }
  )();
}

async function testSessionAndStepProxyPreserveWmhJsonContract(): Promise<void> {
  const requests: Array<{ url: string; body?: unknown }> = [];
  await withMockedFetch(
    async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url.endsWith('/world_models/rose-golden/sessions')) {
        assert.deepStrictEqual(body, {
          task: 'call support',
          seed_state: { structured: { phone_call: { status: 'new' } }, scratchpad: '' },
        });
        return Response.json({ session_id: 'session-1' });
      }
      if (url.endsWith('/world_models/rose-golden/sessions/session-1/step')) {
        assert.deepStrictEqual(body, {
          action: {
            kind: 'tool_call',
            name: 'rose.vapi.poll_call',
            arguments: { call_id: 'call-ext-1' },
          },
        });
        return Response.json({ observation: { content: 'predicted call status' } });
      }
      return Response.json({ detail: 'unexpected' }, { status: 404 });
    },
    async () => {
      const session = await createSession('rose-golden', {
        task: 'call support',
        seed_state: { structured: { phone_call: { status: 'new' } }, scratchpad: '' },
      });
      assert.strictEqual(session.session_id, 'session-1');
      const step = await stepSession('rose-golden', 'session-1', {
        action: {
          kind: 'tool_call',
          name: 'rose.vapi.poll_call',
          arguments: { call_id: 'call-ext-1' },
        },
      });
      assert.deepStrictEqual(step, { observation: { content: 'predicted call status' } });
      assert.strictEqual(requests.length, 2);
    }
  )();
}

async function testMissingWmhBaseUrlFailsExplicitly(): Promise<void> {
  const originalBaseUrl = process.env.WMH_BASE_URL;
  const originalAlt = process.env.WORLD_MODEL_HARNESS_URL;
  delete process.env.WMH_BASE_URL;
  delete process.env.WORLD_MODEL_HARNESS_URL;
  try {
    await assert.rejects(() => listWorldModels(), /WMH_BASE_URL is not configured/);
  } finally {
    if (originalBaseUrl !== undefined) process.env.WMH_BASE_URL = originalBaseUrl;
    if (originalAlt !== undefined) process.env.WORLD_MODEL_HARNESS_URL = originalAlt;
  }
}

async function main(): Promise<void> {
  const tests = [
    ['listWorldModels proxies upstream shape', testListWorldModelsProxiesUpstreamShape],
    [
      'session and step proxy preserve WMH JSON contract',
      testSessionAndStepProxyPreserveWmhJsonContract,
    ],
    ['missing WMH base URL fails explicitly', testMissingWmhBaseUrlFailsExplicitly],
  ] as const;
  const results: TestResult[] = [];
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn);
    results.push(result);
    console.log(`${result.passed ? '✅' : '❌'} ${name} (${result.duration}ms)`);
    if (!result.passed) console.log(`   ${result.error}`);
  }
  const failed = results.filter((result) => !result.passed);
  console.log(
    `\nworld-models blackbox: ${results.length - failed.length}/${results.length} passed`
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
