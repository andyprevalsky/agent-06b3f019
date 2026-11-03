import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from '@temporalio/client';
import { checkWorkerNativePollers } from '../../providers/workerDeploymentPollers';
const identities = Array.from({ length: 8 }, (_, i) => `${i + 1}@machine-${i}`);
function client(values = [identities, identities], age = 0, namespace = 'local-fixture') {
  const calls: unknown[] = [];
  return {
    calls,
    native: {
      options: { namespace },
      withDeadline: async (_deadline: number, operation: () => unknown) => operation(),
      workflowService: {
        describeTaskQueue: async (request: { taskQueueType: number }) => {
          calls.push(request);
          return {
            pollers: values[request.taskQueueType - 1].map((identity) => ({
              identity,
              lastAccessTime: { seconds: Math.floor((Date.now() - age) / 1000) },
            })),
          };
        },
      },
    } as unknown as Client,
  };
}
test('both bounded native queue types require all eight fresh exact identities', async () => {
  const c = client();
  const result = await checkWorkerNativePollers(
    c.native,
    'qualified-queue',
    identities,
    'local-fixture'
  );
  assert.equal(result.ready, true);
  assert.equal(c.calls.length, 2);
  assert.deepEqual(
    c.calls.map((v) => (v as { taskQueueType: number }).taskQueueType),
    [1, 2]
  );
});
test('partial or expired expected pollers return explicit not-ready without fabricating success', async () => {
  for (const c of [client([identities.slice(1), identities]), client(undefined, 121000)])
    assert.equal(
      (await checkWorkerNativePollers(c.native, 'q', identities, 'local-fixture')).ready,
      false
    );
});
test('extra identity and namespace mismatch fail closed rather than entering readiness wait', async () => {
  await assert.rejects(
    checkWorkerNativePollers(
      client([[...identities, 'foreign'], identities]).native,
      'q',
      identities,
      'local-fixture'
    ),
    /Unexpected/
  );
  const c = client();
  await assert.rejects(checkWorkerNativePollers(c.native, 'q', identities, 'foreign'), /namespace/);
  assert.equal(c.calls.length, 0);
});

test('transport errors and future timestamps fail closed instead of readiness false', async (t) => {
  const c = client();
  t.mock.method(c.native.workflowService, 'describeTaskQueue', async () => {
    throw new Error('fixture transport failed');
  });
  await assert.rejects(
    checkWorkerNativePollers(c.native, 'q', identities, 'local-fixture'),
    /transport failed/
  );
  await assert.rejects(
    checkWorkerNativePollers(client(undefined, -10000).native, 'q', identities, 'local-fixture'),
    /timestamp/
  );
});

test('two-second positive clock skew remains fresh, over-five-second skew fails closed', async () => {
  assert.equal(
    (
      await checkWorkerNativePollers(
        client(undefined, -2000).native,
        'q',
        identities,
        'local-fixture'
      )
    ).ready,
    true
  );
  await assert.rejects(
    checkWorkerNativePollers(client(undefined, -6000).native, 'q', identities, 'local-fixture'),
    /timestamp/
  );
});
