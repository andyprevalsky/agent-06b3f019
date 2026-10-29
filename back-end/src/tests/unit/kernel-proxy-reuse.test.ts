import assert from 'node:assert/strict';
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
    model.create = (async ({ data }: { data: unknown }) => {
      writes++;
      return data;
    }) as typeof model.create;
    const calls = Array.from({ length: 20 }, () => getOrCreateKernelProxy(client, isp));
    release();
    const results = await Promise.all(calls);
    assert.equal(findCalls, 1);
    assert.equal(listCalls, 1);
    assert.equal(createCalls, 1, 'concurrent cache misses must allocate only one proxy');
    assert.equal(writes, 1);
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
  } finally {
    model.findUnique = oldFind;
    model.create = oldCreate;
  }
  process.stdout.write('PASS Kernel ISP reuse, concurrent allocation, retry and cache controls\n');
}
void main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
