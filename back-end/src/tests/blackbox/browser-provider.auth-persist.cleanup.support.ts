import nodeAssert from 'node:assert/strict';
import {
  cleanupAuthPersistFixture,
  readAuthPersistInitOnce,
} from './browser-provider.auth-persist.cleanup';

export async function assertAuthPersistFailedInitCustody(): Promise<void> {
  const makeFixture = (failure?: string, userCreated = true) => {
    const calls: string[] = [];
    const originalFailure = new Error('original init failure');
    const options = {
      userId: 'fixture-user',
      userCreated,
      initUnresolved: false,
      allocated: [],
      originalFailure,
      journalPath: 'private-custody.json',
      snapshot: async () => {
        calls.push('snapshot');
        if (failure === 'snapshot') throw new Error('unavailable');
        return {
          identity: {
            phoneProvider: 'agentphone:recovery:fixture',
            phoneProviderAgentId: null,
            phoneProviderNumberId: null,
          },
          sessions: [
            {
              sessionId: 'closed-browser',
              provider: 'kernel',
              providerProfileId: 'new-profile',
              status: 'CLOSED',
            },
          ],
          profiles: [{ provider: 'kernel', profileId: 'new-profile' }],
        };
      },
      saveJournal: async (
        phase: string,
        _custody: unknown,
        results: Array<{ succeeded: boolean }>,
        ownerRetained: boolean
      ) => {
        calls.push(`journal:${phase}`);
        nodeAssert.equal(ownerRetained, true);
        nodeAssert.ok(results.every((result) => typeof result.succeeded === 'boolean'));
        if (failure === `journal:${phase}`) throw new Error('disk unavailable');
      },
      releaseBrowser: async (session: { sessionId: string }) => {
        calls.push(`release:${session.sessionId}`);
        if (failure === 'release') throw new Error('provider unavailable');
      },
      deleteProfile: async (id: string) => {
        calls.push(`profile:${id}`);
      },
      cleanupLocal: async (deleteUser: boolean) => {
        calls.push(`local:delete-user=${deleteUser}`);
        nodeAssert.equal(deleteUser, false, 'uncertain phone identity must not cascade');
      },
    };
    return { options, calls, originalFailure };
  };
  // Definitive HTTP500 has finished; its DB allocations still require cleanup.
  const successful = makeFixture();
  await cleanupAuthPersistFixture(successful.options);
  nodeAssert.deepEqual(successful.calls, [
    'snapshot',
    'journal:before-cleanup',
    'release:closed-browser',
    'journal:releasing-browsers',
    'profile:new-profile',
    'journal:releasing-profiles',
    'local:delete-user=false',
    'journal:phone-custody-retained',
  ]);
  // Unknown transport/body failures must not retry or mutate any owned resources.
  for (const lostAt of ['transport', 'body']) {
    let attempts = 0;
    let settled = false;
    const lost = new Error(`lost ${lostAt}`);
    await nodeAssert.rejects(
      readAuthPersistInitOnce(
        async () => {
          attempts++;
          if (lostAt === 'transport') throw lost;
          return {
            text: async (): Promise<string> => {
              throw lost;
            },
          };
        },
        () => {
          settled = true;
        }
      ),
      (error) => error === lost
    );
    nodeAssert.equal(attempts, 1);
    nodeAssert.equal(settled, false);
    const unknown = makeFixture();
    unknown.options.initUnresolved = true;
    await nodeAssert.rejects(cleanupAuthPersistFixture(unknown.options), AggregateError);
    nodeAssert.deepEqual(unknown.calls, [
      'snapshot',
      'journal:before-cleanup',
      'journal:init-unknown-retained',
    ]);
  }
  // A complete500 body is settled even though the HTTP operation failed.
  let settled500 = false;
  const definitive = await readAuthPersistInitOnce(
    async () => ({
      status: 500,
      text: async () => '{"error":"credential preparation failed"}',
    }),
    () => {
      settled500 = true;
    }
  );
  nodeAssert.equal(settled500, true);
  nodeAssert.equal(definitive.response.status, 500);
  // Definitive success with no identity deletes the owned User after native release.
  let successUnresolved = true;
  await readAuthPersistInitOnce(
    async () => ({
      status: 200,
      text: async () => '{"session_id":"browser"}',
    }),
    () => {
      successUnresolved = false;
    }
  );
  nodeAssert.equal(successUnresolved, false);
  const cleanCalls: string[] = [];
  await cleanupAuthPersistFixture({
    userId: 'fixture-user',
    userCreated: true,
    initUnresolved: successUnresolved,
    allocated: [],
    journalPath: 'private-custody.json',
    snapshot: async () => ({
      identity: null,
      sessions: [
        {
          sessionId: 'browser',
          provider: 'kernel',
          providerProfileId: 'profile',
        },
      ],
      profiles: [{ provider: 'kernel', profileId: 'profile' }],
    }),
    saveJournal: async (phase, _custody, _results, ownerRetained) => {
      cleanCalls.push(`journal:${phase}`);
      if (phase === 'cleanup-complete') nodeAssert.equal(ownerRetained, false);
    },
    releaseBrowser: async () => {
      cleanCalls.push('release');
    },
    deleteProfile: async () => {
      cleanCalls.push('profile');
    },
    cleanupLocal: async (deleteUser) => {
      nodeAssert.equal(deleteUser, true);
      cleanCalls.push('local-delete');
    },
  });
  nodeAssert.deepEqual(cleanCalls, [
    'journal:before-cleanup',
    'release',
    'journal:releasing-browsers',
    'profile',
    'journal:releasing-profiles',
    'local-delete',
    'journal:cleanup-complete',
  ]);
  // No successful User.create receipt means no ownership, even if matching rows exist.
  const unowned = makeFixture(undefined, false);
  await cleanupAuthPersistFixture(unowned.options);
  nodeAssert.deepEqual(unowned.calls, ['journal:setup-ownership-unconfirmed']);
  for (const failure of [
    'snapshot',
    'journal:before-cleanup',
    'release',
    'journal:releasing-browsers',
    'journal:releasing-profiles',
  ]) {
    const fixture = makeFixture(failure);
    await nodeAssert.rejects(cleanupAuthPersistFixture(fixture.options), (error: unknown) => {
      nodeAssert.ok(error instanceof AggregateError);
      nodeAssert.equal(error.errors[0], fixture.originalFailure);
      return true;
    });
    nodeAssert.ok(
      !fixture.calls.some((call) => call.startsWith('local:')),
      `${failure} must preserve local ownership`
    );
    if (failure === 'snapshot' || failure === 'journal:before-cleanup') {
      nodeAssert.ok(
        !fixture.calls.some((call) => call.startsWith('release:') || call.startsWith('profile:'))
      );
    }
    if (failure === 'release' || failure === 'journal:releasing-browsers') {
      nodeAssert.ok(!fixture.calls.some((call) => call.startsWith('profile:')));
    }
  }
}
