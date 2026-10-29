#!/usr/bin/env tsx
/** Default is read-only. Explicit --apply deletes at most --limit (1..100) duplicates. */
import Kernel from '@onkernel/sdk';
import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { deletePlannedKernelProxy, planKernelProxyCleanup } from './kernel-proxy-cleanup-plan';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let apply = false;
  let limit = 100;
  let report: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--limit') limit = Number(args[++i]);
    else if (args[i] === '--report') report = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('--limit must be 1..100');
  if (!process.env.KERNEL_API_KEY || !process.env.DATABASE_URL) {
    throw new Error('Set KERNEL_API_KEY and DATABASE_URL explicitly; no env file is auto-loaded');
  }
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY, maxRetries: 0, timeout: 30_000 });
  const prisma = new PrismaClient();
  const outcomes: Array<{ id: string; outcome: string }> = [];
  let plan: ReturnType<typeof planKernelProxyCleanup> = [];
  const protectedIds = async (): Promise<Set<string>> => {
    const rows = await prisma.browserProviderProxy.findMany({
      where: { provider: 'kernel' },
      select: { proxyId: true },
    });
    const protectedSet = new Set(rows.map((row) => row.proxyId));
    for await (const browser of kernel.browsers.list({ status: 'active', limit: 100 })) {
      if (browser.proxy_id) protectedSet.add(browser.proxy_id);
      // An unreported proxy reference cannot safely prove that any proxy is idle.
      else throw new Error(`Active browser ${browser.session_id} has no proxy_id; cleanup stopped`);
    }
    return protectedSet;
  };
  try {
    const proxies = [];
    for await (const proxy of kernel.proxies.list({ limit: 100 })) proxies.push(proxy);
    const protectedSet = await protectedIds();
    plan = planKernelProxyCleanup(proxies, protectedSet, limit);
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          proxyCount: proxies.length,
          protectedCount: protectedSet.size,
          candidateCount: plan.length,
          candidates: plan.map(({ id, name, keepIds }) => ({ id, name, keepIds })),
        },
        null,
        2
      )
    );
    if (apply)
      for (const candidate of plan) {
        const outcome = await deletePlannedKernelProxy(candidate, {
          protectedIds,
          retrieve: (id) => kernel.proxies.retrieve(id),
          delete: (id) => kernel.proxies.delete(id),
        });
        outcomes.push({ id: candidate.id, outcome });
        console.log(JSON.stringify({ id: candidate.id, outcome }));
      }
  } finally {
    if (report)
      await writeFile(
        report,
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            mode: apply ? 'apply' : 'dry-run',
            candidates: plan.map(({ id, name, keepIds }) => ({ id, name, keepIds })),
            outcomes,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // SDK errors may carry request headers; print only the message, never the full object.
  console.error(error instanceof Error ? error.message : 'Kernel cleanup failed');
  process.exitCode = 1;
});
