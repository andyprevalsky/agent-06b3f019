/** Exact stale-cache recovery through the real ladder, without mutating shared live proxies. */
import assert from 'node:assert/strict';
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
    deleteMany: model.deleteMany,
  };
  try {
    for (const reusable of [true, false]) {
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
      model.create = (async ({ data }: { data: { proxyKey: string; proxyId: string } }) => {
        rows.set(data.proxyKey, data.proxyId);
        return data;
      }) as unknown as typeof model.create;
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
    Object.assign(model, originals);
  }
}
