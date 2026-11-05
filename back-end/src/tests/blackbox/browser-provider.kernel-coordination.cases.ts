import assert from 'node:assert/strict';
import { assertKernelProxyHealthFallback } from './browser-provider.kernel-health.support';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type { KernelProxyCandidate } from '../../providers/browser/kernelProxy';

type KernelModule = typeof import('../../providers/browser/kernelProxy');
type CacheRow = { proxyId: string; proxyKey: string };

/** Two actual module instances model separate processes; only dependencies are fake. */
export async function assertKernelSlowHolderReuse(): Promise<void> {
  for (const fullBudget of [false, true]) {
    let now = 0;
    let row: CacheRow | null = null;
    let locked = false;
    let creates = 0;
    let remoteFills = 0;
    let maximumRemoteFills = 0;
    const timers: { at: number; resolve: () => void }[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => timers.push({ at: now + ms, resolve }));
    const cache = {
      findUnique: async () => row,
      upsert: async ({ create }: { create: CacheRow }) => {
        await sleep(fullBudget ? 5_000 : 1_000);
        row = create;
        return row;
      },
    };
    const tx = { browserProviderProxy: cache, $queryRaw: async () => [{ acquired: false }] };
    const database = {
      prisma: { browserProviderProxy: cache },
      runTransactionWithRetry: async (
        fn: (client: typeof tx) => Promise<unknown>,
        options: { maxWait: number; timeout: number }
      ) => {
        assert.equal(options.maxWait, 2_000);
        assert.equal(options.timeout, 60_000);
        let acquired = false;
        try {
          return await fn({
            ...tx,
            $queryRaw: async () => {
              if (locked) return [{ acquired: false }];
              acquired = locked = true;
              remoteFills++;
              maximumRemoteFills = Math.max(maximumRemoteFills, remoteFills);
              return [{ acquired: true }];
            },
          });
        } finally {
          if (acquired) {
            locked = false;
            remoteFills--;
          }
        }
      },
    };
    const source = readFileSync(join(__dirname, '../../providers/browser/kernelProxy.ts'), 'utf8');
    const code = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    const load = (): KernelModule => {
      const scope = {
        exports: {},
        Error,
        AbortSignal,
        process: { env: {} },
        Date: class extends Date {
          static now() {
            return now;
          }
        },
        require: (name: string) => {
          if (name === '../database') return database;
          if (name === 'node:timers/promises') return { setTimeout: sleep };
          if (name === '@onkernel/sdk')
            return {
              APIConnectionTimeoutError: class extends Error {},
              BadRequestError: class extends Error {},
            };
          throw new Error(`Unexpected dependency ${name}`);
        },
      };
      runInNewContext(code, scope);
      return scope.exports as KernelModule;
    };
    const holder = load();
    const waiter = load();
    const candidate: KernelProxyCandidate = holder.kernelProxyCandidates({ country: 'US' })[0]!;
    const client = {
      proxies: {
        list: async (_query: unknown, options: { timeout: number }) => {
          assert.equal(options.timeout, 10_000);
          await sleep(10_000);
          return { items: [], hasNextPage: () => false };
        },
        create: async (_query: unknown, options: { timeout: number; maxRetries: number }) => {
          assert.equal(options.timeout, 45_000);
          assert.equal(options.maxRetries, 0);
          creates++;
          await sleep(fullBudget ? 45_000 : 44_000);
          return { id: 'shared-slow-proxy' };
        },
      },
    } as unknown as Parameters<KernelModule['getOrCreateKernelProxy']>[0];
    let settled = false;
    const work = Promise.allSettled([
      holder.getOrCreateKernelProxy(client, candidate),
      ...Array.from({ length: 4 }, () => waiter.getOrCreateKernelProxy(client, candidate)),
    ]).then((results) => {
      settled = true;
      return results;
    });
    for (let step = 0; step < 3_000 && !settled; step++) {
      for (let flush = 0; flush < 20; flush++) await Promise.resolve();
      timers.sort((a, b) => a.at - b.at);
      const timer = timers.shift();
      if (timer) {
        now = timer.at;
        timer.resolve();
      }
    }
    assert(settled, 'clock driver must terminate');
    const results = await work;
    assert(
      results.every(
        (result) => result.status === 'fulfilled' && result.value.proxyId === 'shared-slow-proxy'
      ),
      'all waiters reuse a valid holder finishing after 45 seconds'
    );
    assert.equal(now, fullBudget ? 60_000 : 55_000);
    assert.equal(creates, 1);
    assert.equal(maximumRemoteFills, 1, 'global admission still protects pool connections');
    assert.equal(
      waiter.isKernelProxyAvailabilityError(new waiter.KernelProxyReuseTimeoutError('timed out')),
      false
    );
    for (const commitsAtDeadline of [true, false]) {
      const deadline = now + 62_000;
      row = commitsAtDeadline ? { proxyId: 'boundary-proxy', proxyKey: candidate.proxyKey } : null;
      locked = true;
      cache.findUnique = async () => (now >= deadline ? row : null);
      const boundary = load();
      let complete = false;
      let value: Awaited<ReturnType<KernelModule['getOrCreateKernelProxy']>> | undefined;
      let failure: unknown;
      const pending = boundary.getOrCreateKernelProxy(client, candidate).then(
        (result) => {
          value = result;
          complete = true;
        },
        (error: unknown) => {
          failure = error;
          complete = true;
        }
      );
      for (let step = 0; step < 3_000 && !complete; step++) {
        for (let flush = 0; flush < 20; flush++) await Promise.resolve();
        timers.sort((a, b) => a.at - b.at);
        const timer = timers.shift();
        if (timer) {
          now = timer.at;
          timer.resolve();
        }
      }
      assert(complete, 'deadline scenario must settle');
      await pending;
      assert.equal(now, deadline);
      if (commitsAtDeadline) assert.equal(value?.proxyId, 'boundary-proxy');
      else assert(failure instanceof boundary.KernelProxyReuseTimeoutError);
      assert.equal(creates, 1, 'deadline lookup never starts another remote allocation');
    }
  }
}

export const kernelCoordinationCases: Array<[string, () => Promise<void>]> = [
  ['Kernel slow holder reuse preserves one allocation and provider windows', assertKernelSlowHolderReuse],
  ['Kernel proxy health errors preserve bounded geo fallback and cache custody', assertKernelProxyHealthFallback],
];
