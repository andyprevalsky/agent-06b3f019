/** Terminal workflow cleanup pauses browsers; explicit deletion alone retires them. */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

export async function runBrowserTerminalPauseCases(): Promise<void> {
  const path = new URL('../../providers/agentCleanup.ts', import.meta.url).pathname;
  const require = createRequire(import.meta.url);
  const loader = Module as unknown as {
    _load: (id: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  const previous = require.cache[path];
  const selections: string[][] = [];
  const releases: Array<{ sessionId: string; pause: boolean }> = [];
  let lazyOnly = false;
  let lazyStatus = 'PAUSED';
  let lazyNative: string | null = null;
  const retirements: unknown[] = [];
  const database = {
    browserSession: {
      findMany: async ({ where }: { where: { agentId: string; status: { in: string[] } } }) => {
        assert.equal(where.agentId, 'owner');
        selections.push(where.status.in);
        if (lazyOnly)
          return where.status.in.includes(lazyStatus)
            ? [{ id: 'logical-task', sessionId: lazyNative }]
            : [];
        return ['ACTIVE', 'PAUSED']
          .filter((status) => where.status.in.includes(status))
          .map((status) => ({ sessionId: `owned-${status}` }));
      },
      updateMany: async (args: unknown) => {
        retirements.push(args);
        assert.deepEqual(args, {
          where: {
            id: 'logical-task',
            agentId: 'owner',
            logicalOwnerKey: 'agent:owner',
            sessionId: null,
            status: 'PAUSED',
          },
          data: { status: 'CLOSED', closedAt: assertDate(args) },
        });
        if (lazyNative !== null || lazyStatus !== 'PAUSED') return { count: 0 };
        lazyStatus = 'CLOSED';
        return { count: 1 };
      },
    },
  };
  function assertDate(args: unknown): Date {
    const value = (args as { data: { closedAt: unknown } }).data.closedAt;
    assert(value instanceof Date);
    return value;
  }
  loader._load = function (id, parent, isMain) {
    if (parent?.filename === path) {
      if (id === './database') return { prisma: database };
      if (id === './logger') return { createLogger: () => ({ info() {}, warn() {} }) };
      if (id === './browser')
        return {
          closeSession: async (sessionId: string, pause: boolean) => {
            releases.push({ sessionId, pause });
          },
        };
      if (
        [
          './purchaseCleanup',
          './claudeCodeLocalSession',
          './localDevices/hub',
          './localDevices/session',
        ].includes(id)
      )
        return {};
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    delete require.cache[path];
    const { releaseAgentBrowserSessions } = require(
      path
    ) as typeof import('../../providers/agentCleanup');
    assert.equal(await releaseAgentBrowserSessions('owner'), 1);
    assert.deepEqual(selections.pop(), ['ACTIVE', 'ERROR']);
    assert.deepEqual(releases.splice(0), [{ sessionId: 'owned-ACTIVE', pause: true }]);

    assert.equal(await releaseAgentBrowserSessions('owner', {}, { retire: true }), 2);
    assert.deepEqual(selections.pop(), ['ACTIVE', 'PAUSED', 'ERROR']);
    assert.deepEqual(releases.splice(0), [
      { sessionId: 'owned-ACTIVE', pause: false },
      { sessionId: 'owned-PAUSED', pause: false },
    ]);

    lazyOnly = true;
    assert.equal(await releaseAgentBrowserSessions('owner'), 0);
    assert.equal(lazyStatus, 'PAUSED', 'ordinary shutdown preserves lazy logical identity');
    assert.equal(retirements.length, 0);
    assert.equal(await releaseAgentBrowserSessions('owner', {}, { retire: true }), 1);
    assert.equal(lazyStatus, 'CLOSED');
    assert.deepEqual(releases, [], 'unmaterialized retirement must not call a provider');
    lazyStatus = 'PAUSED';
    await assert.rejects(
      releaseAgentBrowserSessions(
        'owner',
        {
          findActiveSessions: async () => {
            lazyNative = 'concurrently-bound';
            return [{ id: 'logical-task', sessionId: null }];
          },
        },
        { retire: true }
      ),
      AggregateError,
      'a lost null-binding CAS must fail closed for retry'
    );
    assert.equal(lazyStatus, 'PAUSED');
    assert.deepEqual(releases, []);
    lazyOnly = false;

    const attempted: string[] = [];
    await assert.rejects(
      releaseAgentBrowserSessions('owner', {
        findActiveSessions: async () => [{ sessionId: 'failed' }, { sessionId: 'healthy' }],
        closeSession: async (sessionId, pause) => {
          assert.equal(pause, true);
          attempted.push(sessionId);
          if (sessionId === 'failed') throw new Error('checkpoint unavailable');
        },
      }),
      AggregateError
    );
    assert.deepEqual(
      attempted,
      ['failed', 'healthy'],
      'one failed checkpoint must not skip siblings'
    );
  } finally {
    loader._load = originalLoad;
    delete require.cache[path];
    if (previous) require.cache[path] = previous;
  }
}
