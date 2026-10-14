import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { closeSession } from '../../providers/steel/session';
import {
  inFlightSteelSessionIds,
  unregisterInFlightSteelSession,
} from '../../providers/steel/sessionIdentity';
import { recreateSession } from '../../providers/steel/sessionResume';

const profileId = '2985ff78-3ece-4e5e-8bae-aa97924d84a4';
const oldId = '390ecfb9-fbe2-4168-b368-04bbafa2efcc';

/** Native lifecycle replay; all provider and DB effects are confined to the fixture. */
export async function assertSteelProfileReplacementLifecycle(): Promise<void> {
  let externalFetches = 0;
  const originals = {
    fetch: globalThis.fetch,
    query: prisma.$queryRaw,
    claim: prisma.toolSideEffect.updateMany,
    find: prisma.browserSession.findUnique,
    update: prisma.browserSession.updateMany,
    integration: prisma.integration.findUnique,
    profile: prisma.browserProviderProfile.upsert,
    context: prisma.browserContext.update,
  };
  let status = 'ACTIVE';
  let sessionId = oldId;
  let released = false;
  let phase = 'success';
  let createCalls = 0;
  const releases: string[] = [];
  const reset = (next: string) => {
    status = 'ACTIVE';
    sessionId = oldId;
    released = false;
    phase = next;
    createCalls = 0;
    releases.length = 0;
  };
  try {
    globalThis.fetch = (async () => {
      externalFetches++;
      throw new Error('unexpected external fetch in lifecycle fixture');
    }) as typeof fetch;
    const claims = new Map<string, string>();
    prisma.$queryRaw = (async (query: { values: unknown[] }) => {
      const key = String(query.values[1]);
      const owner = String(query.values[3]);
      if (claims.has(key)) return [];
      claims.set(key, owner);
      return [{ externalId: owner }];
    }) as typeof prisma.$queryRaw;
    prisma.toolSideEffect.updateMany = (async (input: {
      where: { operationKey: string; externalId: string };
    }) => {
      if (claims.get(input.where.operationKey) !== input.where.externalId) return { count: 0 };
      claims.delete(input.where.operationKey);
      return { count: 1 };
    }) as typeof prisma.toolSideEffect.updateMany;
    prisma.browserSession.findUnique = (async (input: {
      include?: unknown;
      select?: { provider?: boolean; id?: boolean; agentId?: boolean };
    }) =>
      input.include || input.select?.provider || (input.select?.id && !input.select?.agentId)
        ? {
            id: 'captured-profile-task',
            sessionId,
            provider: 'steel',
            status,
            providerProfileId: profileId,
            providerProfileSource: 'new_user_persistent',
            providerProfilePersist: true,
            contextId: 'test-context',
            context: { userId: 'test-user' },
            agentId: null,
            proxyRotationCount: 4,
            currentUrl: null,
            startUrl: null,
          }
        : null) as typeof prisma.browserSession.findUnique;
    prisma.browserSession.updateMany = (async (input: {
      where: { sessionId?: string; status?: string };
      data: { status?: string; sessionId?: string; providerProfileId?: string };
    }) => {
      if (
        input.where.sessionId !== sessionId ||
        (input.where.status && input.where.status !== status)
      )
        return { count: 0 };
      if (input.data.sessionId && phase === 'cas') return { count: 0 };
      if (input.data.providerProfileId) assert.equal(input.data.providerProfileId, profileId);
      status = input.data.status ?? status;
      sessionId = input.data.sessionId ?? sessionId;
      return { count: 1 };
    }) as typeof prisma.browserSession.updateMany;
    prisma.integration.findUnique = (async () => null) as typeof prisma.integration.findUnique;
    prisma.browserProviderProfile.upsert =
      (async () => ({})) as typeof prisma.browserProviderProfile.upsert;
    prisma.browserContext.update = (async () => ({})) as typeof prisma.browserContext.update;
    const dependencies = {
      inspectSession: async (id: string) => {
        assert.equal(id, oldId);
        return {
          id,
          profileId: phase === 'foreign' ? 'foreign-profile' : profileId,
          persistProfile: true,
          status: released ? 'released' : 'live',
        };
      },
      releaseSession: async (id: string) => {
        releases.push(id);
        if (id === 'replacement' && phase === 'cleanup')
          throw new Error('candidate cleanup rejected');
        if (id === oldId) {
          assert.equal(status, 'ERROR', 'must claim exact writer before release');
          if (phase === 'release') throw new Error('release acknowledgement lost');
          if (phase === 'releaseConfirmed') {
            released = true;
            throw new Error('release acknowledgement lost');
          }
          released = true;
        }
      },
      createSession: async (input: { profileId?: string; sessionContext?: unknown }) => {
        createCalls++;
        assert.equal(input.profileId, profileId, 'must retain complete bound profile');
        assert.equal(input.sessionContext, undefined, 'must not substitute cookie/storage state');
        if (!released || phase === 'readiness' || createCalls === 1)
          throw Object.assign(
            new Error(
              `409 Profile '${profileId}' is still uploading and cannot be attached to a session yet. Wait for its status to become 'ready', then retry.`
            ),
            { status: 409 }
          );
        if (phase === 'create') throw new Error('create rejected');
        return { id: 'replacement', debugUrl: 'https://steel.example/debug', profileId };
      },
      validateConnection: async () =>
        ['validation', 'cleanup'].includes(phase) ? 'validation rejected' : null,
    };
    const run = () =>
      recreateSession('captured-profile-task', { forceManagedRotation: true }, dependencies);
    const result = await run();
    assert.equal(result.steelProfileId, profileId);
    assert.equal(result.previousSessionReleased, true);
    assert.equal(status, 'ACTIVE');
    assert.equal(sessionId, 'replacement');
    assert.deepEqual(releases, [oldId]);

    for (const failure of [
      'release',
      'releaseConfirmed',
      'readiness',
      'create',
      'validation',
      'foreign',
      'cas',
    ]) {
      reset(failure);
      await assert.rejects(run());
      assert.equal(sessionId, oldId, 'failed replacement must not publish a candidate');
      assert.equal(
        status,
        failure === 'foreign' ? 'ACTIVE' : failure === 'release' ? 'ERROR' : 'CLOSED'
      );
      if (failure === 'foreign') assert.deepEqual(releases, []);
      if (failure === 'readiness') assert.equal(createCalls, 5);
      if (failure === 'validation')
        assert.equal(releases.filter((id) => id === 'replacement').length, 4);
      if (failure === 'cas') assert(releases.includes('replacement'));
      if (failure === 'cleanup') {
        assert(inFlightSteelSessionIds().has('replacement'));
        unregisterInFlightSteelSession('replacement');
      }
    }
    reset('success');
    const competing = await Promise.allSettled([run(), run(), closeSession(oldId, true)]);
    assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(releases.filter((id) => id === oldId).length, 1);
    assert.equal(status, 'ACTIVE');
  } finally {
    globalThis.fetch = originals.fetch;
    prisma.$queryRaw = originals.query;
    prisma.toolSideEffect.updateMany = originals.claim;
    prisma.browserSession.findUnique = originals.find;
    prisma.browserSession.updateMany = originals.update;
    prisma.integration.findUnique = originals.integration;
    prisma.browserProviderProfile.upsert = originals.profile;
    prisma.browserContext.update = originals.context;
    unregisterInFlightSteelSession('replacement');
    assert.equal(externalFetches, 0, 'lifecycle fixture must make no external calls');
  }
}
