/** Exact stale-cache recovery through the real ladder, without mutating shared live proxies. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { Prisma } from '@prisma/client';
import type { Kernel } from '@onkernel/sdk';
import { prisma } from '../../providers/database';
import {
  createSessionOnKernelProxyLadder,
  kernelProxyCandidates,
} from '../../providers/browser/kernelProxy';

export async function assertKernelStaleCacheRecovery(): Promise<void> {
  const model = prisma.browserProviderProxy;
  const originals = {
    findUnique: model.findUnique,
    create: model.create,
    upsert: model.upsert,
    deleteMany: model.deleteMany,
  };
  let locked = false;
  let transactions = 0;
  let lockQueries = 0;
  let publications = 0;
  const transaction = mock.method(prisma, '$transaction', (async (
    run: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options: { maxWait: number; timeout: number }
  ) => {
    transactions++;
    assert.deepEqual(options, { maxWait: 2_000, timeout: 60_000 });
    try {
      return await run({
        $queryRaw: async () => {
          lockQueries++;
          locked = true;
          return [{ acquired: true }];
        },
        browserProviderProxy: model,
      } as unknown as Prisma.TransactionClient);
    } finally {
      locked = false;
    }
  }) as typeof prisma.$transaction);
  try {
    for (const reusable of [true, false]) {
      transactions = lockQueries = publications = 0;
      const candidates = kernelProxyCandidates({ country: 'US', state: 'GA' }, 'mobile');
      const candidate = candidates[0];
      const rows = new Map([[candidate.proxyKey, 'deleted-proxy']]);
      const dropped: string[] = [];
      const attempts: string[] = [];
      const created: unknown[] = [];
      model.findUnique = (async ({
        where,
      }: {
        where: { provider_proxyKey: { proxyKey: string } };
      }) => {
        const key = where.provider_proxyKey.proxyKey;
        return rows.has(key) ? { proxyKey: key, proxyId: rows.get(key) } : null;
      }) as unknown as typeof model.findUnique;
      model.deleteMany = (async ({ where }: { where: { proxyKey: string; proxyId: string } }) => {
        if (rows.get(where.proxyKey) !== where.proxyId) return { count: 0 };
        dropped.push(where.proxyId);
        rows.delete(where.proxyKey);
        return { count: 1 };
      }) as unknown as typeof model.deleteMany;
      model.create = (async () => {
        throw new Error('cache publication must use the transaction-local upsert');
      }) as typeof model.create;
      model.upsert = (async ({ create }: { create: { proxyKey: string; proxyId: string } }) => {
        assert(locked, 'cache publication requires the advisory lock');
        publications++;
        rows.set(create.proxyKey, create.proxyId);
        return create;
      }) as unknown as typeof model.upsert;
      const client = {
        proxies: {
          list: async () => ({
            items: reusable
              ? [
                  {
                    id: 'existing-geo-proxy',
                    name: candidate.name,
                    type: candidate.type,
                    config: candidate.config,
                    status: 'available',
                  },
                ]
              : [],
            hasNextPage: () => false,
          }),
          create: async (data: unknown) => {
            created.push(data);
            return { id: 'new-fixture-proxy' };
          },
          delete: async () => {
            throw new Error('Shared provider proxies must never be deleted by recovery');
          },
        },
      } as unknown as Kernel;
      const result = await createSessionOnKernelProxyLadder(client, candidates, async (proxy) => {
        attempts.push(proxy.proxyId);
        if (proxy.proxyId === 'deleted-proxy') throw new Error('proxy not found');
        return proxy;
      });
      assert.equal(transactions, 1);
      assert.equal(lockQueries, 1);
      assert.equal(publications, 1, 'replacement is published to the cache under its lock');
      assert.deepEqual(dropped, ['deleted-proxy']);
      assert.deepEqual(attempts, [
        'deleted-proxy',
        reusable ? 'existing-geo-proxy' : 'new-fixture-proxy',
      ]);
      assert.equal(
        result.source,
        candidate.source,
        'stale identity must refresh without relaxing location'
      );
      assert.deepEqual(result.location, candidate.location);
      assert.equal(rows.get(candidate.proxyKey), result.proxyId);
      assert.equal(
        created.length,
        reusable ? 0 : 1,
        'reuse existing project proxy before creating any replacement'
      );
      if (!reusable)
        assert.deepEqual(created[0], {
          type: candidate.type,
          name: candidate.name,
          config: candidate.config,
        });
    }
  } finally {
    transaction.mock.restore();
    Object.assign(model, originals);
  }
}
