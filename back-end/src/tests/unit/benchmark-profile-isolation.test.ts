#!/usr/bin/env tsx
/**
 * Isolated benchmark Kernel profiles must keep advertising new_user_persistent
 * until a session actually binds them. A timed-out first init that only reserved
 * the in-memory slot must not poison the next spawn's session metadata
 * (browser-biometrics-webdecoy agent 2a421e78).
 */
import assert from 'node:assert/strict';
import {
  getOrCreateBenchmarkKernelProfile,
  markBenchmarkKernelProfileBound,
  resetBenchmarkKernelProfilesForTests,
} from '../../providers/browser/benchmarkProfileIsolation';

type FakeKernel = {
  profiles: {
    create: (input: Record<string, never>) => Promise<{ id: string }>;
    delete: (id: string) => Promise<void>;
  };
};

function fakeClient(createImpl: () => Promise<{ id: string }>): FakeKernel {
  return {
    profiles: {
      create: async () => createImpl(),
      delete: async () => undefined,
    },
  };
}

async function retryBeforeBindKeepsNewUserPersistent(): Promise<void> {
  resetBenchmarkKernelProfilesForTests();
  let creates = 0;
  const client = fakeClient(async () => {
    creates += 1;
    return { id: `profile-${creates}` };
  });

  const first = await getOrCreateBenchmarkKernelProfile(client as never, 'agent-a');
  assert.equal(first.profileSource, 'new_user_persistent');
  assert.equal(first.profileId, 'profile-1');

  // Simulate worker ReadTimeout after profile reservation but before a live
  // Kernel session — the in-memory entry exists, but boundToSession is false.
  const retry = await getOrCreateBenchmarkKernelProfile(client as never, 'agent-a');
  assert.equal(retry.profileId, 'profile-1', 'same reserved profile is reused');
  assert.equal(
    retry.profileSource,
    'new_user_persistent',
    'unbound retry must not advertise user_persistent'
  );
  assert.equal(creates, 1, 'must not allocate a second Kernel profile');
}

async function bindThenReuseIsUserPersistent(): Promise<void> {
  resetBenchmarkKernelProfilesForTests();
  const client = fakeClient(async () => ({ id: 'profile-bound' }));

  const created = await getOrCreateBenchmarkKernelProfile(client as never, 'agent-b');
  assert.equal(created.profileSource, 'new_user_persistent');
  markBenchmarkKernelProfileBound('agent-b');

  const rotated = await getOrCreateBenchmarkKernelProfile(client as never, 'agent-b');
  assert.equal(rotated.profileId, 'profile-bound');
  assert.equal(rotated.profileSource, 'user_persistent');
}

async function createFailureClearsReservation(): Promise<void> {
  resetBenchmarkKernelProfilesForTests();
  let creates = 0;
  const client = fakeClient(async () => {
    creates += 1;
    if (creates === 1) throw new Error('kernel profiles.create failed');
    return { id: 'profile-after-fail' };
  });

  await assert.rejects(
    () => getOrCreateBenchmarkKernelProfile(client as never, 'agent-c'),
    /kernel profiles\.create failed/
  );

  const recovered = await getOrCreateBenchmarkKernelProfile(client as never, 'agent-c');
  assert.equal(recovered.profileId, 'profile-after-fail');
  assert.equal(recovered.profileSource, 'new_user_persistent');
  assert.equal(creates, 2);
}

async function run(): Promise<void> {
  await retryBeforeBindKeepsNewUserPersistent();
  await bindThenReuseIsUserPersistent();
  await createFailureClearsReservation();
  process.stdout.write('PASS benchmark Kernel profile isolation labeling\n');
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
