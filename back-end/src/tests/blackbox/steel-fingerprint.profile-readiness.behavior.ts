import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { recreateSession } from '../../providers/steel/sessionResume';
import { releaseSteelRemoteSession, steel } from '../../providers/steel/session';

export async function testSteelWriterProfileHandoff(
  mode:
    | 'ready'
    | 'failed-profile'
    | 'failed-release'
    | 'failed-create'
    | 'lost-cas'
    | 'lost-lease-during-profile-read' = 'ready'
): Promise<void> {
  const findSession = prisma.browserSession.findUnique;
  const updateSession = prisma.browserSession.updateMany;
  const findAgent = prisma.agent.findUnique;
  const findIntegration = prisma.integration.findUnique;
  const upsertProfile = prisma.browserProviderProfile.upsert;
  const updateContext = prisma.browserContext.update;
  const events: string[] = [];
  let released = false;
  let reads = 0;
  let creates = 0;
  let binding = 'old-writer';
  let status = 'ACTIVE';
  const releases: string[] = [];
  try {
    prisma.browserSession.findUnique = (async (args: { select?: unknown }) =>
      args.select
        ? null
        : {
            id: 'writer-profile-task',
            sessionId: binding,
            provider: 'steel',
            status,
            closedAt: null,
            providerProfileId: 'writer-profile',
            providerProfileSource: 'user_persistent',
            providerProfilePersist: true,
            currentUrl: null,
            startUrl: null,
            agentId: 'writer-agent',
            contextId: 'writer-context',
            context: { userId: 'writer-user' },
          }) as typeof findSession;
    prisma.browserSession.updateMany = (async (args: {
      where: { sessionId: string };
      data: { sessionId?: string; status?: string };
    }) => {
      if (args.where.sessionId !== binding) return { count: 0 };
      if (args.data.sessionId) binding = args.data.sessionId;
      if (args.data.status) status = args.data.status;
      return { count: 1 };
    }) as typeof updateSession;
    prisma.agent.findUnique = (async () => null) as typeof findAgent;
    prisma.integration.findUnique = (async () => null) as typeof findIntegration;
    prisma.browserProviderProfile.upsert = (async () => ({})) as typeof upsertProfile;
    prisma.browserContext.update = (async () => ({})) as typeof updateContext;
    const dependencies = {
      releaseSession: async (id: string) => {
        releases.push(id);
        if (id === 'new-writer') return;
        assert.equal(id, 'old-writer');
        if (mode === 'failed-release') throw new Error('release unavailable');
        released = true;
        events.push('release-writer');
      },
      retrieveProfile: async (id: string) => {
        assert.equal(id, 'writer-profile');
        assert(released, 'profile readiness was checked before releasing its writer');
        reads++;
        const profileStatus =
          mode === 'failed-profile' ? 'FAILED' : reads === 1 ? 'UPLOADING' : 'READY';
        events.push(profileStatus);
        if (mode === 'lost-lease-during-profile-read' && profileStatus === 'READY') {
          await prisma.toolSideEffect.update({
            where: { operationKey: 'browser:steel-profile-handoff:writer-profile-task:old-writer' },
            data: { externalId: 'profile-read-successor' },
          });
        }
        return { status: profileStatus };
      },
      createSession: async (input: { profileId?: string; persistProfile?: boolean }) => {
        creates++;
        assert.equal(input.profileId, 'writer-profile');
        assert.equal(input.persistProfile, true);
        if (!released || reads < 2) {
          throw Object.assign(
            new Error("409 Profile 'writer-profile' is still uploading and cannot be attached"),
            { status: 409 }
          );
        }
        if (mode === 'failed-create') throw new Error('provider create unavailable');
        events.push('create-replacement');
        return {
          id: 'new-writer',
          debugUrl: 'https://steel.example/debug',
          profileId: 'writer-profile',
        };
      },
      validateConnection: async () => {
        if (mode === 'lost-cas') {
          binding = 'concurrent-writer';
          status = 'ACTIVE';
        }
        return null;
      },
    };
    const replacement = recreateSession(
      'writer-profile-task',
      { forceManagedRotation: true },
      dependencies
    );
    if (mode !== 'ready') {
      await assert.rejects(
        replacement,
        mode === 'lost-lease-during-profile-read' ? /lost lease/ : undefined
      );
      assert.deepEqual(
        releases,
        mode === 'lost-cas' ? ['old-writer', 'new-writer'] : ['old-writer'],
        'handoff must only release its exact writer and any uncommitted replacement'
      );
      assert.equal(binding, mode === 'lost-cas' ? 'concurrent-writer' : 'old-writer');
      assert.equal(status, mode === 'lost-cas' ? 'ACTIVE' : 'PAUSED');
      if (mode === 'lost-lease-during-profile-read') {
        assert.equal(reads, 2);
        assert.equal(creates, 0, 'lost readiness-reader lease allocated a replacement');
        const successor = await prisma.toolSideEffect.findUniqueOrThrow({
          where: { operationKey: 'browser:steel-profile-handoff:writer-profile-task:old-writer' },
        });
        assert.equal(successor.externalId, 'profile-read-successor');
        assert.equal(successor.status, 'STARTED');
      }
      if (mode === 'failed-profile') assert.equal(reads, 1, 'FAILED is terminal');
      if (mode === 'failed-profile' || mode === 'failed-release') assert.equal(creates, 0);
      return;
    }
    const result = await replacement;
    assert.equal(result.sessionId, 'new-writer');
    assert.equal(binding, 'new-writer');
    assert.equal(status, 'ACTIVE');
    assert.equal(creates, 1, 'an uploading profile must not consume a session-create attempt');
    assert.deepEqual(events, ['release-writer', 'UPLOADING', 'READY', 'create-replacement']);
  } finally {
    prisma.browserSession.findUnique = findSession;
    prisma.browserSession.updateMany = updateSession;
    prisma.agent.findUnique = findAgent;
    prisma.integration.findUnique = findIntegration;
    prisma.browserProviderProfile.upsert = upsertProfile;
    prisma.browserContext.update = updateContext;
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: 'browser:steel-profile-handoff:writer-profile-task:old-writer' },
    });
  }
}

export async function testSteelAlreadyReleasedWriterIsIdempotent(): Promise<void> {
  const release = steel.sessions.release;
  let calls = 0;
  try {
    steel.sessions.release = (async (id: string) => {
      assert.equal(id, 'already-released-writer');
      calls++;
      throw Object.assign(new Error('Not found'), { status: 404 });
    }) as typeof release;
    await releaseSteelRemoteSession('already-released-writer');
    assert.equal(calls, 1, 'an already-released writer must not retry or block handoff');
  } finally {
    steel.sessions.release = release;
  }
}
