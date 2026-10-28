/** Actual resume owner/response assembly under a delayed completed-follower schedule. */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
const root = new URL('../../', import.meta.url).pathname;
const local = createRequire(import.meta.url);
const original = Module._load;
let provider = 'steel';
let phase: 'healthy' | 'health' | 'assembly' = 'healthy';
let row: Record<string, unknown>;
let ledger: Record<string, unknown>;
let healthCalls = 0;
function replaceWithPending() {
  Object.assign(row, {
    sessionId: 'unprepared-B',
    status: 'PAUSED',
    wsUrl: 'ws://B',
    debugUrl: 'https://B.invalid',
  });
  ledger = {
    operationType: 'browser_task_resume',
    status: 'STARTED',
    externalId: 'new-owner',
    request: {
      source: 'prepared-A',
      provider,
      ownershipIdentity: 'readiness-fixture',
      compatibility: 'fresh',
      phase: 'hydrating',
      nativeId: 'unprepared-B',
    },
  };
}
const database = {
  browserSession: {
    findUniqueOrThrow: async () => structuredClone(row),
    findUnique: async () => structuredClone(row),
  },
  toolSideEffect: {
    findUnique: async (args: { where: { operationKey: string } }) =>
      args.where.operationKey.startsWith('browser-initialization:')
        ? null
        : structuredClone(ledger),
  },
  user: { findUnique: async () => null },
  browserPassword: { findMany: async () => [] },
};
Module._load = function (id, parent, isMain) {
  const owner = parent?.filename ?? '';
  if (owner.startsWith(root) && (id === './database' || id === '../database'))
    return {
      prisma: database,
      runTransactionWithRetry: async () => {
        throw new Error('follower must not mutate');
      },
    };
  if (owner.endsWith('/browser/resumeLifecycle.ts') && id === '../steel/sessionIdentity')
    return { steelEnvironmentIdentity: () => 'readiness-fixture', SHARED_STEEL_IDENTITY: 'shared' };
  if (owner.endsWith('/browserSessionResume.ts') && id === './browser')
    return {
      getFingerprintInjectionData: async () => null,
      getBrowserSessionHealth: async (id: string) => {
        healthCalls++;
        if (phase === 'health' || (phase === 'assembly' && healthCalls === 2)) replaceWithPending();
        return { provider, sessionId: id, status: 'live', ttlMs: 1800000 };
      },
    };
  return original.call(this, id, parent, isMain);
};
(async () => {
  try {
    const { resumeBrowserSession } = local('../../providers/browserSessionResume');
    for (provider of ['steel', 'kernel'])
      for (phase of ['healthy', 'health', 'assembly'] as const) {
        healthCalls = 0;
        row = {
          id: 'logical',
          logicalOwnerKey: 'agent:owned',
          contextId: 'context',
          context: { userId: 'user' },
          sessionId: 'prepared-A',
          status: 'ACTIVE',
          provider,
          controlState: 'AGENT',
          controlLeaseExpiresAt: null,
          wsUrl: 'ws://A',
          debugUrl: 'https://A.invalid',
          currentUrl: null,
          startUrl: null,
          providerProfileId: null,
          providerProfileSource: 'logical',
        };
        ledger = {
          operationType: 'browser_task_resume',
          status: 'RELEASED',
          externalId: 'ready-owner',
          request: {
            ownershipIdentity: 'readiness-fixture',
            compatibility: 'default',
            requestId: 'A',
          },
          response: { phase: 'ready', sessionId: 'prepared-A' },
        };
        if (phase === 'healthy')
          assert.equal((await resumeBrowserSession('logical')).session_id, 'prepared-A');
        else
          await assert.rejects(
            resumeBrowserSession('logical'),
            /ready.*changed/i,
            `${provider}/${phase} cannot expose a pending replacement`
          );
        console.log(`PASS completed follower readiness ${provider}/${phase}`);
      }
  } finally {
    Module._load = original;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
