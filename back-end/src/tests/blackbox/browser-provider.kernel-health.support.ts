import assert from 'node:assert/strict';
import { APIError, type Kernel } from '@onkernel/sdk';
import { prisma } from '../../providers/database';
import {
  createSessionOnKernelProxyLadder,
  kernelProxyCandidates,
} from '../../providers/browser/kernelProxy';

/** Replay Kernel's real health errors through cache invalidation and geo fallback. */
export async function assertKernelProxyHealthFallback(): Promise<void> {
  const cases = [
    { message: '400 Proxy is marked unavailable from the last health check', invalidate: true },
    {
      message:
        '400 Proxy health check failed: transport error: proxy connection failed: context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
      invalidate: true,
    },
    {
      message:
        '400 error when testing a connection through the proxy: transport error: proxy connection failed: context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
      invalidate: true,
    },
    { message: '401 Unauthorized', terminal: true, invalidate: false },
    { message: '400 Invalid request payload', terminal: true, invalidate: false },
  ];
  const model = prisma.browserProviderProxy;
  const originalFind = model.findUnique;
  const originalDelete = model.deleteMany;
  try {
    for (const test of cases) {
      const candidates = kernelProxyCandidates({ country: 'US', state: 'TX' }, 'mobile');
      const [state, country] = candidates;
      assert.ok(state && country);
      const rows = new Map([
        [state.proxyKey, 'state-proxy'],
        [country.proxyKey, 'country-proxy'],
      ]);
      model.findUnique = (async ({
        where,
      }: {
        where: { provider_proxyKey: { proxyKey: string } };
      }) => {
        const proxyKey = where.provider_proxyKey.proxyKey;
        const proxyId = rows.get(proxyKey);
        return proxyId === undefined ? null : { proxyKey, proxyId };
      }) as unknown as typeof model.findUnique;
      model.deleteMany = (async ({ where }: { where: { proxyKey: string } }) => ({
        count: Number(rows.delete(where.proxyKey)),
      })) as unknown as typeof model.deleteMany;
      const attempts: string[] = [];
      const failure = APIError.generate(
        Number(test.message.slice(0, 3)),
        { message: test.message.slice(4) },
        undefined,
        new Headers()
      );
      const client = {
        proxies: {
          retrieve: async () => ({ status: test.invalidate ? 'unavailable' : 'available' }),
        },
      } as unknown as Kernel;
      const run = () =>
        createSessionOnKernelProxyLadder(client, candidates, async (proxy) => {
          attempts.push(proxy.proxyId);
          if (proxy.proxyId === 'state-proxy') throw failure;
          return proxy;
        });
      if (test.terminal === true) {
        await assert.rejects(run, (error: unknown) => error === failure);
        assert.deepEqual(attempts, ['state-proxy']);
      } else {
        const result = await run();
        assert.equal(result.proxyId, 'country-proxy', test.message);
        assert.equal(result.proxyType, 'mobile');
        assert.deepEqual(attempts, ['state-proxy', 'country-proxy']);
      }
      assert.equal(rows.has(state.proxyKey), !test.invalidate, test.message);
      assert.equal(rows.get(country.proxyKey), 'country-proxy');
    }
  } finally {
    model.findUnique = originalFind;
    model.deleteMany = originalDelete;
  }
}
