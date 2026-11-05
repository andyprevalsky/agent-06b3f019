import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { Prisma } from '@prisma/client';
import type Kernel from '@onkernel/sdk';
import { prisma } from '../../providers/database';
import {
  getOrCreateKernelProxy,
  kernelProxyCandidates,
  selectReusableKernelProxy,
} from '../../providers/browser/kernelProxy';

async function main() {
  const [isp] = kernelProxyCandidates({ country: 'US', state: 'CA', city: 'Palo Alto' }, 'isp');
  assert.deepEqual(isp.config, { country: 'US' });
  assert.equal(isp.proxyKey, 'isp:US');
  assert.equal(isp.source, 'kernel_isp_country');
  assert.equal(
    selectReusableKernelProxy(
      [
        {
          id: 'legacy-isp',
          name: 'rose-isp-us-ca-palo_alto',
          type: 'isp',
          config: { country: 'us' },
          status: 'available',
        },
      ],
      isp
    ),
    'legacy-isp',
    'country-only ISP proxies created under legacy city names must be reused'
  );
  assert.equal(
    selectReusableKernelProxy(
      [
        {
          id: 'unrelated',
          name: 'customer-isp-us',
          type: 'isp',
          config: { country: 'us' },
          status: 'available',
        },
      ],
      isp
    ),
    undefined
  );
  const model = prisma.browserProviderProxy;
  const oldFind = model.findUnique;
  const oldCreate = model.create;
  let findCalls = 0;
  let listCalls = 0;
  let createCalls = 0;
  let writes = 0;
  let transactions = 0;
  let lockedReads = 0;
  let lockQueries = 0;
  let lockedWinner: { proxyKey: string; proxyId: string } | null = null;
  let rejectTransaction = false;
  const transaction = mock.method(prisma, '$transaction', (async (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options: { maxWait: number; timeout: number }
  ) => {
    transactions++;
    assert.deepEqual(options, { maxWait: 2_000, timeout: 60_000 });
    if (rejectTransaction) throw new Error('fixture transaction rejected');
    let locked = false;
    return callback({
      $queryRaw: async () => {
        lockQueries++;
        locked = true;
        return [{ acquired: true }];
      },
      browserProviderProxy: {
        findUnique: async () => {
          assert(locked, 'recheck must follow the advisory lock');
          lockedReads++;
          return lockedWinner;
        },
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { provider_proxyKey: { provider: string; proxyKey: string } };
          create: { provider: string; proxyKey: string; proxyId: string; proxyType: string };
          update: { proxyType: string };
        }) => {
          assert(locked, 'cache publication must hold the advisory lock');
          assert.deepEqual(where.provider_proxyKey, { provider: 'kernel', proxyKey: isp.proxyKey });
          assert.equal(create.provider, 'kernel');
          assert.equal(create.proxyKey, isp.proxyKey);
          assert.equal(create.proxyType, 'isp');
          assert.equal(update.proxyType, 'isp');
          writes++;
          return create;
        },
      },
    } as unknown as Prisma.TransactionClient);
  }) as typeof prisma.$transaction);
  let rejectLookup = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    proxies: {
      list: async () => {
        listCalls++;
        await barrier;
        if (rejectLookup) throw new Error('lookup failed');
        return { items: [], hasNextPage: () => false };
      },
      create: async () => {
        createCalls++;
        return { id: `created-${createCalls}` };
      },
    },
  } as unknown as Kernel;
  try {
    model.findUnique = (async () => {
      findCalls++;
      return null;
    }) as typeof model.findUnique;
    model.create = (async () => {
      throw new Error('cache writes must use the locked transaction, not root create');
    }) as typeof model.create;
    const calls = Array.from({ length: 20 }, () => getOrCreateKernelProxy(client, isp));
    release();
    const results = await Promise.all(calls);
    assert.equal(findCalls, 1);
    assert.equal(listCalls, 1);
    assert.equal(createCalls, 1, 'concurrent cache misses must allocate only one proxy');
    assert.equal(writes, 1);
    assert.equal(transactions, 1, 'coalesced callers share one transaction');
    assert.equal(lockQueries, 1);
    assert.equal(lockedReads, 1);
    assert(results.every((r) => r.proxyId === results[0].proxyId));

    rejectLookup = true;
    await assert.rejects(getOrCreateKernelProxy(client, isp), /lookup failed/);
    rejectLookup = false;
    await getOrCreateKernelProxy(client, isp);
    assert.equal(createCalls, 2, 'failed lookups must release the in-flight slot');
    assert.equal(listCalls, 3);

    model.findUnique = (async () => ({
      proxyKey: isp.proxyKey,
      proxyId: 'cached',
    })) as typeof model.findUnique;
    assert.equal((await getOrCreateKernelProxy(client, isp)).proxyId, 'cached');
    assert.equal(listCalls, 3, 'a cached proxy must not call the remote allocator');
    assert.equal(transactions, 3, 'cache hits never enter a fill transaction');
    assert.equal(writes, 2, 'failed lookups do not publish a cache entry');

    model.findUnique = (async () => null) as typeof model.findUnique;
    lockedWinner = { proxyKey: isp.proxyKey, proxyId: 'locked-winner' };
    assert.equal((await getOrCreateKernelProxy(client, isp)).proxyId, 'locked-winner');
    assert.equal(listCalls, 3, 'a winner found under the lock prevents remote work');
    assert.equal(createCalls, 2);
    assert.equal(writes, 2);
    lockedWinner = null;
    rejectTransaction = true;
    await assert.rejects(getOrCreateKernelProxy(client, isp), /fixture transaction rejected/);
    assert.equal(listCalls, 3, 'a failed transaction cannot start provider work');
    assert.equal(writes, 2);
    rejectTransaction = false;
    await getOrCreateKernelProxy(client, isp);
    assert.equal(createCalls, 3, 'transaction failure releases the coalescing slot');
    assert.equal(writes, 3);
  } finally {
    transaction.mock.restore();
    model.findUnique = oldFind;
    model.create = oldCreate;
  }
  process.stdout.write('PASS Kernel ISP reuse, concurrent allocation, retry and cache controls\n');
}
void main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
