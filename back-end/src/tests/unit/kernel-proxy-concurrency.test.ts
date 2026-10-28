import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import Kernel, { APIError } from '@onkernel/sdk';
import { prisma } from '../../providers/database';
import {
  getOrCreateKernelProxy,
  kernelProxyCandidates,
  isKernelProxyAvailabilityError,
  createSessionOnKernelProxyLadder,
} from '../../providers/browser/kernelProxy';

const deniedMessage =
  'proxy configuration validation failed: failed to validate country: pingproxy: unexpected status 403: You do not have permission to perform this action.';

async function worker(): Promise<void> {
  const [key, endpoint] = process.argv.slice(-2);
  const candidate = { ...kernelProxyCandidates({ country: 'US' })[0]!, proxyKey: key! };
  const find = prisma.browserProviderProxy.findUnique.bind(prisma.browserProviderProxy);
  let first = true;
  prisma.browserProviderProxy.findUnique = (async (...args: Parameters<typeof find>) => {
    if (!first) return find(...args);
    first = false;
    // Every process observes the same cache miss before any may allocate.
    const go = once(process, 'message');
    process.send!({ ready: true });
    await go;
    return null;
  }) as typeof find;
  const client = {
    proxies: {
      list: async () => ({ items: [], hasNextPage: () => false }),
      create: async () => (await fetch(endpoint!, { method: 'POST' })).json(),
    },
  } as unknown as Kernel;
  const result = await getOrCreateKernelProxy(client, candidate);
  process.send!({ proxyId: result.proxyId });
  await prisma.$disconnect();
  process.disconnect();
}

async function concurrency(): Promise<void> {
  const key = `residential:US:test-${randomUUID()}`;
  let creates = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.end();
      return;
    }
    creates += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `test-proxy-${creates}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const children = Array.from({ length: 6 }, () =>
    fork(__filename, ['--worker', key, `http://127.0.0.1:${address.port}`], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
  );
  try {
    const ids: string[] = [];
    let ready = 0;
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.on('message', (message: { ready?: boolean; proxyId?: string }) => {
              if (message.ready && ++ready === children.length)
                children.forEach((c) => c.send('go'));
              if (message.proxyId) ids.push(message.proxyId);
            });
            child.on('error', reject);
            child.on('exit', (code) =>
              code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))
            );
          })
      )
    );
    assert.equal(creates, 1, 'concurrent cache misses across processes must allocate once');
    assert.equal(ids.length, children.length);
    assert.equal(new Set(ids).size, 1, 'all workers must reuse the committed proxy');
    process.stdout.write(
      'PASS six independent processes: one remote allocation and one shared ID\n'
    );
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    server.close();
    await prisma.browserProviderProxy.deleteMany({ where: { provider: 'kernel', proxyKey: key } });
  }
}

async function localRetry(): Promise<void> {
  const candidate = {
    ...kernelProxyCandidates({ country: 'US' })[0]!,
    proxyKey: `residential:US:test-${randomUUID()}`,
  };
  let creates = 0;
  let fail = true;
  let mixedVersion = false;
  const failure = new Error('provider denied creation');
  const client = {
    proxies: {
      list: async () => ({ items: [], hasNextPage: () => false }),
      create: async () => {
        creates++;
        if (fail) throw failure;
        if (mixedVersion)
          await prisma.browserProviderProxy.create({
            data: {
              provider: 'kernel',
              proxyKey: candidate.proxyKey,
              proxyId: 'older-worker-winner',
              proxyType: candidate.type,
              config: candidate.config,
            },
          });
        return { id: 'local-retry-proxy' };
      },
    },
  } as unknown as Kernel;
  try {
    const failed = await Promise.allSettled(
      Array.from({ length: 8 }, () => getOrCreateKernelProxy(client, candidate))
    );
    assert(failed.every((result) => result.status === 'rejected' && result.reason === failure));
    assert.equal(creates, 1, 'same-process callers share the failed attempt');
    fail = false;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateKernelProxy(client, candidate))
    );
    assert(results.every((result) => result.proxyId === 'local-retry-proxy'));
    assert.equal(creates, 2, 'a failed promise must not poison subsequent reuse');
    await prisma.browserProviderProxy.deleteMany({
      where: { provider: 'kernel', proxyKey: candidate.proxyKey },
    });
    mixedVersion = true;
    const mixed = await getOrCreateKernelProxy(client, candidate);
    assert.equal(
      mixed.proxyId,
      'older-worker-winner',
      'a pre-lock worker insert must survive without aborting the transaction'
    );
    assert.equal(creates, 3);
    process.stdout.write(
      'PASS same-process coalescing, failed-attempt release, and successful retry\n'
    );
  } finally {
    await prisma.browserProviderProxy.deleteMany({
      where: { provider: 'kernel', proxyKey: candidate.proxyKey },
    });
  }
}

async function permission(): Promise<void> {
  const denied = APIError.generate(400, { message: deniedMessage }, undefined, new Headers());
  assert.equal(
    isKernelProxyAvailabilityError(denied),
    false,
    'permission denial is not geo inventory'
  );
  const candidates = kernelProxyCandidates(
    { country: 'US', state: 'CA', city: 'San Francisco' },
    'mobile'
  );
  const model = prisma.browserProviderProxy;
  const find = model.findUnique;
  model.findUnique = (async () => ({
    proxyId: 'denied',
    proxyKey: candidates[0]!.proxyKey,
  })) as typeof find;
  let relaxed = 0;
  let retrieved = 0;
  const client = {
    proxies: {
      retrieve: async () => {
        retrieved++;
        return { status: 'unavailable' };
      },
    },
  } as unknown as Kernel;
  try {
    await assert.rejects(
      createSessionOnKernelProxyLadder(
        client,
        candidates,
        async () => {
          throw denied;
        },
        {
          onRelax: () => {
            relaxed++;
          },
        }
      ),
      (error) => error === denied
    );
    assert.equal(relaxed, 0);
    assert.equal(
      retrieved,
      0,
      'denied access must fail before health-based fallback or cache eviction'
    );
  } finally {
    model.findUnique = find;
  }
  process.stdout.write('PASS provider permission denial propagates without geo fallback\n');
}

async function main(): Promise<void> {
  if (process.argv.includes('--worker')) return worker();
  try {
    if (process.argv.includes('--permission')) await permission();
    else if (process.argv.includes('--concurrency')) await concurrency();
    else {
      await concurrency();
      await localRetry();
      await permission();
    }
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
