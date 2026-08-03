#!/usr/bin/env tsx
/**
 * Black-box coverage for the E2B sandbox-create reliability boundary.
 *
 * The E2B create API has no idempotency key. A transport error can therefore mean that the
 * sandbox was provisioned but its response was lost. These tests replace only the external SDK
 * methods and exercise the production retry/adoption path unchanged.
 */
import { Sandbox } from 'e2b';
import {
  createSandboxWithRetry,
  isTransientSandboxCreateError,
} from '../../providers/e2bSandboxCreate';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function testFinalAttemptAdoptsProvisionedSandbox(): Promise<void> {
  const originalCreate = Sandbox.create;
  const originalList = Sandbox.list;
  const originalConnect = Sandbox.connect;
  const createdRequestIds: string[] = [];
  const queriedRequestIds: string[] = [];
  let createCalls = 0;
  let listCalls = 0;
  let connectCalls = 0;

  const adoptedSandbox = { sandboxId: 'sandbox-from-terminal-attempt' } as Awaited<
    ReturnType<typeof Sandbox.connect>
  >;

  Sandbox.create = (async (_templateId, options) => {
    createCalls += 1;
    const createRequestId = options?.metadata?.createRequestId;
    assert(typeof createRequestId === 'string', 'create attempt must carry an idempotency tag');
    createdRequestIds.push(createRequestId);
    throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
  }) as typeof Sandbox.create;

  Sandbox.list = ((options) => {
    listCalls += 1;
    const createRequestId = options?.query?.metadata?.createRequestId;
    assert(typeof createRequestId === 'string', 'orphan lookup must use the create tag');
    queriedRequestIds.push(createRequestId);
    return {
      nextItems: async () => (listCalls === 3 ? [{ sandboxId: adoptedSandbox.sandboxId }] : []),
    };
  }) as typeof Sandbox.list;

  Sandbox.connect = (async (sandboxId) => {
    connectCalls += 1;
    assert(sandboxId === adoptedSandbox.sandboxId, `connected to unexpected sandbox ${sandboxId}`);
    return adoptedSandbox;
  }) as typeof Sandbox.connect;

  try {
    const result = await createSandboxWithRetry(
      'test-template',
      { apiKey: 'test-e2b-key' },
      'blackbox'
    );

    assert(result === adoptedSandbox, 'terminal-attempt sandbox must be returned to the caller');
    assert(createCalls === 3, `expected 3 create attempts, got ${createCalls}`);
    assert(
      listCalls === 3,
      `expected lookups before attempts 2 and 3 plus one terminal lookup, got ${listCalls}`
    );
    assert(connectCalls === 1, `expected exactly one orphan adoption, got ${connectCalls}`);
    const requestIds = new Set([...createdRequestIds, ...queriedRequestIds]);
    assert(requestIds.size === 1, 'all attempts and lookups must share one createRequestId');
  } finally {
    Sandbox.create = originalCreate;
    Sandbox.list = originalList;
    Sandbox.connect = originalConnect;
  }
}

function testDnsNotFoundIsTransient(): void {
  const error = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.e2b.dev'), { code: 'ENOTFOUND' }),
  });
  assert(
    isTransientSandboxCreateError(error),
    'temporary DNS ENOTFOUND failures must retry instead of failing the code agent'
  );
}

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    {
      name: 'terminal ambiguous create adopts the provisioned sandbox',
      run: testFinalAttemptAdoptsProvisionedSandbox,
    },
    { name: 'ENOTFOUND is a transient create failure', run: testDnsNotFoundIsTransient },
  ];
  let failed = 0;

  for (const test of tests) {
    try {
      await test.run();
      console.log(`  PASS  ${test.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL  ${test.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }

  console.log(`\n${tests.length - failed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exit(1);
}

void main();
