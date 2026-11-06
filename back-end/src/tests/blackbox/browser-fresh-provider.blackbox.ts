/** Fresh-session selection must not inherit another provider's learned recovery preference. */
import assert from 'node:assert/strict';
import { computeGrantBrowserProvider } from '../../domains/compute-grants/config';
import type { Prisma } from '@prisma/client';
import { createLogicalBrowserInTransaction } from '../../providers/browser/logicalSession';
import { createSessionWithContextUsingDependencies } from '../../providers/browser';
import { selectedBrowserProvider } from '../../providers/browser/config';
import { providerForSession } from '../../providers/browser/sessionProvider';
import { prisma } from '../../providers/database';
import type { BrowserProviderSession } from '../../providers/browser/types';

async function main() {
  const before = { ...process.env };
  process.env.BROWSER_PROVIDER = 'tilion';
  process.env.TILION_API_KEY = 'test-key';
  delete process.env.BROWSER_AGENT_TILION_ENABLED;
  const calls: string[] = [];
  const create = (provider: BrowserProviderSession['provider']) => async () => {
    calls.push(provider);
    return {
      provider,
      sessionId: 'test-session',
      debugUrl: 'https://live.example/test',
      taskId: 'test-task',
      wsUrl: 'wss://cdp.example/test',
      proxySource: provider,
      proxyLocation: { country: 'US' },
      profileId: null,
      profileSource: 'test',
      validationBrowser: null,
    };
  };
  const location = { city: 'SAN FRANCISCO', state: 'CA', country: 'US' };
  const preference = {
    version: 1,
    provider: 'steel',
    learnedAt: '2026-11-06T02:11:27.981Z',
    proxyMode: 'fixed',
    proxyLocation: location,
    steelProxyMode: 'fixed',
  };
  try {
    const session = await createSessionWithContextUsingDependencies(
      'context',
      'new-agent',
      location,
      undefined,
      undefined,
      {
        readPreferredConfig: async () => preference,
        defaultProvider: selectedBrowserProvider,
        createKernel: create('kernel'),
        createSteel: create('steel'),
        createBrowserUse: create('browser-use'),
        createTilion: create('tilion'),
      }
    );
    assert.equal(
      session.provider,
      'tilion',
      'fresh session must use Tilion despite saved Steel recovery'
    );
    assert.deepEqual(calls, ['tilion']);
    // Dispatch for already materialized rows must retain the recorded provider.
    const original = prisma.browserSession.findUnique;
    try {
      prisma.browserSession.findUnique = (async () => ({ provider: 'steel' })) as typeof original;
      assert.equal(await providerForSession('existing-steel'), 'steel');
      prisma.browserSession.findUnique = (async () => ({ provider: 'kernel' })) as typeof original;
      assert.equal(await providerForSession('existing-kernel'), 'kernel');
    } finally {
      prisma.browserSession.findUnique = original;
    }
    delete process.env.COMPUTE_GRANT_BROWSER_PROVIDER;
    assert.equal(
      computeGrantBrowserProvider(),
      'tilion',
      'fresh account-connect browsers must default to Tilion'
    );
    delete process.env.BROWSER_PROVIDER;
    const tx = {
      agent: { findUniqueOrThrow: async () => ({ userId: 'user' }) },
      $executeRaw: async () => [],
      browserContext: { upsert: async () => ({ id: 'context' }) },
      browserSession: {
        findUnique: async () => null,
        findFirst: async () => null,
        upsert: async ({ create: data }: { create: Record<string, unknown> }) => data,
      },
    } as unknown as Prisma.TransactionClient;
    const logical = await createLogicalBrowserInTransaction(tx, 'user', 'fresh-agent');
    assert.equal(
      logical.provider,
      'tilion',
      'unmaterialized logical browsers must use the same Tilion default'
    );
    console.log(
      'PASS: fresh Tilion selection and placeholders; existing Steel/Kernel bindings retained'
    );
  } finally {
    process.env = before;
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
