import assert from 'node:assert/strict';
import {
  deletePlannedKernelProxy,
  planKernelProxyCleanup,
  roseProxyGroup,
  protectBrowserProxies,
  type CleanupProxy,
} from '../../../scripts/kernel-proxy-cleanup-plan';

const proxy = (id: string, overrides: Partial<CleanupProxy> = {}): CleanupProxy => ({
  id,
  name: 'rose-residential-us-ca',
  type: 'residential',
  config: { country: 'us', state: 'ca' },
  status: 'available',
  ...overrides,
});

async function main() {
  const protectedBrowsers = new Set(['database-reference']);
  protectBrowserProxies(protectedBrowsers, [
    {},
    { proxy_id: null },
    { proxy_id: 'active-browser' },
  ]);
  assert.deepEqual([...protectedBrowsers], ['database-reference', 'active-browser']);
  assert.throws(() => protectBrowserProxies(protectedBrowsers, [{ proxy_id: '' }]), /Malformed/);
  const inventory = ['a', 'b', 'c', 'd'].map((id) => proxy(id));
  inventory.push(proxy('bad', { status: 'unavailable' }));
  assert.deepEqual(
    planKernelProxyCleanup(inventory, new Set(['d'])).map((p) => p.id),
    ['bad', 'b', 'c']
  );
  const plan = planKernelProxyCleanup(inventory, new Set(['d']));
  assert.deepEqual(plan[0].keepIds, ['d', 'a']);
  assert.equal(planKernelProxyCleanup([proxy('only')], new Set()).length, 0);
  assert.equal(
    planKernelProxyCleanup([proxy('bad', { status: 'unavailable' })], new Set()).length,
    0
  );
  assert.equal(planKernelProxyCleanup(inventory, new Set(), 1).length, 1);
  assert.throws(() => planKernelProxyCleanup(inventory, new Set(), 101));
  assert.throws(() => planKernelProxyCleanup([proxy('a'), proxy('a')], new Set()));
  for (const overrides of [
    { name: 'user-private-proxy' },
    { type: 'custom' },
    { config: { country: 'us', state: 'tx' } },
    { config: { country: 'us', state: 'ca', asn: '123' } },
    { config: { country: 'us', state: 'ca', password: 'private' } },
  ])
    assert.equal(roseProxyGroup(proxy('x', overrides)), undefined);
  assert.notEqual(
    roseProxyGroup(proxy('a')),
    roseProxyGroup(proxy('b', { bypass_hosts: ['private.example'] }))
  );
  assert.notEqual(roseProxyGroup(proxy('a')), roseProxyGroup(proxy('b', { protocol: 'https' })));
  assert.equal(
    roseProxyGroup(proxy('a', { config: { state: 'ca', country: 'us' } })),
    roseProxyGroup(proxy('b'))
  );
  assert.equal(
    planKernelProxyCleanup(
      [proxy('a'), proxy('b'), proxy('c', { bypass_hosts: ['private.example'] })],
      new Set()
    ).length,
    0
  );

  const candidate = plan[0];
  let deleted = false;
  let protectionReads = 0;
  const dependencies = {
    protectedIds: async () => {
      protectionReads++;
      return new Set<string>();
    },
    retrieve: async (id: string) => {
      if (deleted && id === candidate.id) throw { status: 404 };
      return inventory.find((p) => p.id === id)!;
    },
    delete: async (id: string) => {
      assert.equal(id, candidate.id);
      deleted = true;
    },
  };
  assert.equal(
    await deletePlannedKernelProxy({ ...candidate, keepIds: [] }, dependencies),
    'changed'
  );
  assert.equal(deleted, false);
  assert.equal(
    await deletePlannedKernelProxy(candidate, {
      ...dependencies,
      protectedIds: async () => new Set([candidate.id]),
    }),
    'protected'
  );
  assert.equal(deleted, false);
  assert.equal(
    await deletePlannedKernelProxy(candidate, {
      ...dependencies,
      retrieve: async (id) => proxy(id, { status: 'unavailable' }),
    }),
    'changed'
  );
  assert.equal(deleted, false);
  assert.equal(
    await deletePlannedKernelProxy(candidate, {
      ...dependencies,
      retrieve: async (id) => proxy(id, { name: 'changed-owner' }),
    }),
    'changed'
  );
  assert.equal(deleted, false);
  await assert.rejects(
    deletePlannedKernelProxy(candidate, {
      ...dependencies,
      protectedIds: async () => {
        throw new Error('DB offline');
      },
    }),
    /DB offline/
  );
  assert.equal(deleted, false);
  assert.equal(await deletePlannedKernelProxy(candidate, dependencies), 'deleted');
  assert.equal(protectionReads, 1);
  assert.equal(await deletePlannedKernelProxy(candidate, dependencies), 'already-absent');
  deleted = false;
  await assert.rejects(
    deletePlannedKernelProxy(candidate, { ...dependencies, delete: async () => {} }),
    /Deletion not confirmed/
  );
  await assert.rejects(
    deletePlannedKernelProxy(candidate, {
      ...dependencies,
      retrieve: async () => {
        throw { status: 403 };
      },
    })
  );
  process.stdout.write('Kernel proxy cleanup policy and deletion guards passed\n');
}

void main();
