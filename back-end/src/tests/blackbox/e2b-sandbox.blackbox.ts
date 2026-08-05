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

async function testAdoptionRetriesTransientConnectWithoutCreatingDuplicate(): Promise<void> {
  const originalCreate = Sandbox.create;
  const originalList = Sandbox.list;
  const originalConnect = Sandbox.connect;
  let createCalls = 0;
  let listCalls = 0;
  let connectCalls = 0;

  const adoptedSandbox = { sandboxId: 'sandbox-with-transient-connect' } as Awaited<
    ReturnType<typeof Sandbox.connect>
  >;

  Sandbox.create = (async () => {
    createCalls += 1;
    if (createCalls > 1) throw new Error('duplicate sandbox create attempted');
    throw Object.assign(new TypeError('fetch failed after provisioning'), { code: 'ECONNRESET' });
  }) as typeof Sandbox.create;

  Sandbox.list = (() => {
    listCalls += 1;
    return { nextItems: async () => [{ sandboxId: adoptedSandbox.sandboxId }] };
  }) as typeof Sandbox.list;

  Sandbox.connect = (async () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      throw Object.assign(new TypeError('fetch failed while connecting'), { code: 'ECONNRESET' });
    }
    return adoptedSandbox;
  }) as typeof Sandbox.connect;

  try {
    const result = await createSandboxWithRetry(
      'test-template',
      { apiKey: 'test-e2b-key' },
      'blackbox-connect'
    );

    assert(result === adoptedSandbox, 'retry must adopt the sandbox after connect recovers');
    assert(createCalls === 1, `expected no duplicate create, got ${createCalls} calls`);
    assert(listCalls === 2, `expected adoption to be retried once, got ${listCalls} lookups`);
    assert(connectCalls === 2, `expected connect to be retried once, got ${connectCalls} calls`);
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

/**
 * Regression: an INCONCLUSIVE orphan lookup must never fall through to a second
 * create. Attempt 1's response is lost (the sandbox exists remotely), then the
 * first `Sandbox.list` fails. Collapsing that failure into "no orphan" made the
 * retry provision a duplicate, leaving the first sandbox untracked and billed.
 */
async function testInconclusiveOrphanLookupDoesNotDuplicateCreate(): Promise<void> {
  const originalCreate = Sandbox.create;
  const originalList = Sandbox.list;
  const originalConnect = Sandbox.connect;
  let createCalls = 0;
  let listCalls = 0;

  const provisioned = { sandboxId: 'sandbox-provisioned-but-response-lost' } as Awaited<
    ReturnType<typeof Sandbox.connect>
  >;

  Sandbox.create = (async () => {
    createCalls += 1;
    // The sandbox IS provisioned remotely; only the response is lost.
    const transport = new Error('socket hang up');
    (transport as NodeJS.ErrnoException).code = 'ECONNRESET';
    throw transport;
  }) as typeof Sandbox.create;

  Sandbox.list = (() => {
    listCalls += 1;
    return {
      nextItems: async () => {
        // First lookup is inconclusive; afterwards the orphan is visible.
        if (listCalls === 1) throw new Error('control plane unavailable');
        return [{ sandboxId: provisioned.sandboxId }];
      },
    };
  }) as typeof Sandbox.list;

  Sandbox.connect = (async () => provisioned) as typeof Sandbox.connect;

  try {
    const sandbox = await createSandboxWithRetry('template', {}, 'test');
    assert(
      sandbox.sandboxId === provisioned.sandboxId,
      'the already-provisioned sandbox must be adopted, not replaced'
    );
    assert(
      createCalls === 1,
      `an inconclusive lookup must not trigger another create (createCalls=${createCalls})`
    );
    assert(listCalls >= 2, 'the failed lookup must be retried rather than treated as absent');
  } finally {
    Sandbox.create = originalCreate;
    Sandbox.list = originalList;
    Sandbox.connect = originalConnect;
  }
}

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    {
      name: 'inconclusive orphan lookup does not duplicate the create',
      run: testInconclusiveOrphanLookupDoesNotDuplicateCreate,
    },
    {
      name: 'terminal ambiguous create adopts the provisioned sandbox',
      run: testFinalAttemptAdoptsProvisionedSandbox,
    },
    {
      name: 'transient orphan connect retries adoption without duplicate create',
      run: testAdoptionRetriesTransientConnectWithoutCreatingDuplicate,
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
