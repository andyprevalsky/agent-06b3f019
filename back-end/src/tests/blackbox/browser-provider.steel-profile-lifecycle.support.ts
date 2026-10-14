import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { reconcileSteelCandidateCleanup } from '../../providers/steel/candidateCleanup';
import { steelSessionTimeoutMs } from '../../providers/steel/sessionLifetime';
import { withSteelLifecycleClaim } from '../../providers/steel/lifecycleClaim';
import { steel, closeSession } from '../../providers/steel/session';
import {
  inFlightSteelSessionIds,
  unregisterInFlightSteelSession,
} from '../../providers/steel/sessionIdentity';
import { recreateSession } from '../../providers/steel/sessionResume';

const profileId = '2985ff78-3ece-4e5e-8bae-aa97924d84a4';
const oldId = '390ecfb9-fbe2-4168-b368-04bbafa2efcc';
const invalidatedRecordedProfileId = '1fb295cf-7069-434e-9a97-6c4ba9c6a28e';

/** Native lifecycle replay; all provider and DB effects are confined to the fixture. */
export async function assertSteelProfileReplacementLifecycle(): Promise<void> {
  let externalFetches = 0;
  const originals = {
    fetch: globalThis.fetch,
    date: globalThis.Date,
    workspace: process.env.CONDUCTOR_WORKSPACE_NAME,
    candidateCreate: prisma.toolSideEffect.create,
    candidateFind: prisma.toolSideEffect.findUnique,
    candidateList: prisma.toolSideEffect.findMany,
    nativeRead: steel.sessions.retrieve,
    nativeRelease: steel.sessions.release,
    heldRead: prisma.browserSession.findFirst,
    contextRead: prisma.browserContext.findUnique,
    profileRead: prisma.browserProviderProfile.findUnique,
    query: prisma.$queryRaw,
    transaction: prisma.$transaction,
    claim: prisma.toolSideEffect.updateMany,
    find: prisma.browserSession.findUnique,
    update: prisma.browserSession.updateMany,
    integration: prisma.integration.findUnique,
    profile: prisma.browserProviderProfile.upsert,
    context: prisma.browserContext.update,
  };
  let status = 'ACTIVE';
  let closedAt: Date | null = null;
  let sessionId = oldId;
  let released = false;
  let phase = 'success';
  let createCalls = 0;
  let lastCandidateId = '';
  let recordedSource = 'new_user_persistent';
  let clockOffset = 0;
  let mutationEntered: (() => void) | undefined;
  let mutationGate: Promise<void> | undefined;
  let mutationHeld = false;
  let lateAllocated = false;
  let lateReleased = false;
  const releasedCandidateIds = new Set<string>();
  const NativeDate = originals.date;
  const releases: string[] = [];
  const reset = (next: string) => {
    status = 'ACTIVE';
    closedAt = null;
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
    process.env.CONDUCTOR_WORKSPACE_NAME = 'steel-profile-lifecycle-fixture';
    globalThis.Date = class extends NativeDate {
      constructor(value?: string | number) {
        super(value === undefined ? NativeDate.now() + clockOffset : value);
      }
      static now() {
        return NativeDate.now() + clockOffset;
      }
    } as DateConstructor;
    const claims = new Map<
      string,
      {
        externalId: string;
        request: { expiresAt: string; nativeOutstanding?: boolean };
        status: string;
        operationType: string;
        updatedAt: Date;
      }
    >();
    const candidates = new Map<
      string,
      {
        externalId: string;
        request: {
          taskId: string;
          sessionId: string;
          profileId?: string;
          ownershipIdentity: string;
        };
        status: string;
      }
    >();
    prisma.$transaction = (async (callback: (transaction: typeof prisma) => Promise<unknown>) =>
      callback(prisma)) as typeof prisma.$transaction;
    prisma.$queryRaw = (async (query: { values: unknown[]; strings: string[] }) => {
      if (query.strings[0].includes('SELECT')) {
        assert(
          query.strings.join('').includes('FOR UPDATE'),
          'binding mutation must lock claim atomically'
        );
        if (phase === 'writeGap' && status === 'PAUSED' && createCalls >= 2 && !mutationHeld) {
          mutationHeld = true;
          mutationEntered?.();
          await mutationGate;
        }
        const item = claims.get(String(query.values[0]));
        return item ? [{ ...item, request: { ...item.request } }] : [];
      }
      const key = String(query.values[1]);
      const owner = String(query.values[3]);
      const existing = claims.get(key);
      const now = query.values[5] as Date;
      if (
        existing?.status === 'STARTED' &&
        (Date.parse(existing.request.expiresAt) > now.getTime() ||
          existing.request.nativeOutstanding)
      )
        return [];
      claims.set(key, {
        externalId: owner,
        request: JSON.parse(String(query.values[4])),
        status: 'STARTED',
        operationType: 'steel_browser_task_lifecycle',
        updatedAt: now,
      });
      return [{ externalId: owner }];
    }) as typeof prisma.$queryRaw;
    prisma.toolSideEffect.updateMany = (async (input: {
      where: { operationKey: string; externalId: string; operationType?: string };
      data: {
        status?: string;
        request?: { expiresAt: string; nativeOutstanding?: boolean; nativeEffect?: string };
        externalId?: string;
        updatedAt?: Date;
      };
    }) => {
      if (input.where.operationType === 'steel_candidate_cleanup') {
        const item = candidates.get(input.where.operationKey);
        if (!item || item.externalId !== input.where.externalId) return { count: 0 };
        if (phase === 'commitBookkeeping' && input.data.status === 'COMMITTED')
          throw new Error('committed intent update rejected');
        item.status = input.data.status ?? item.status;
        return { count: 1 };
      }
      const item = claims.get(input.where.operationKey);
      if (!item || item.externalId !== input.where.externalId) return { count: 0 };
      if (phase === 'leaseRelease' && input.data.status === 'RELEASED')
        throw new Error('lease release write rejected');
      if (
        phase === 'clearNative' &&
        input.data.status !== 'RELEASED' &&
        input.data.request?.nativeOutstanding === false &&
        createCalls >= 2
      )
        throw new Error('native custody clear write rejected');
      Object.assign(item, input.data);
      if (
        (phase === 'preSendExpiry' ||
          (phase === 'preSendProfile' && input.where.operationKey.includes(':profile:'))) &&
        input.data.request?.nativeOutstanding === true &&
        input.data.request.nativeEffect === 'create'
      )
        clockOffset = steelSessionTimeoutMs() + 1;
      return { count: 1 };
    }) as typeof prisma.toolSideEffect.updateMany;
    prisma.toolSideEffect.create = (async (input: {
      data: {
        operationKey: string;
        externalId: string;
        request: { taskId: string; sessionId: string; ownershipIdentity: string };
        status: string;
      };
    }) => {
      if (phase === 'unexpectedPrepare' && input.data.externalId === lastCandidateId)
        throw new Error('unexpected ID custody write rejected');
      assert(!candidates.has(input.data.operationKey), 'candidate identities must be unique');
      candidates.set(input.data.operationKey, input.data);
      return input.data;
    }) as typeof prisma.toolSideEffect.create;
    prisma.toolSideEffect.findUnique = (async (input: { where: { operationKey: string } }) =>
      claims.has(input.where.operationKey)
        ? {
            ...claims.get(input.where.operationKey)!,
            request: { ...claims.get(input.where.operationKey)!.request },
          }
        : null) as typeof prisma.toolSideEffect.findUnique;
    prisma.toolSideEffect.findMany = (async () =>
      [...candidates.entries()]
        .filter(([, item]) => item.status === 'PENDING')
        .map(([operationKey, item]) => ({
          operationKey,
          ...item,
        }))) as typeof prisma.toolSideEffect.findMany;
    prisma.browserProviderProfile.findUnique = (async () => ({
      profileId,
    })) as typeof prisma.browserProviderProfile.findUnique;
    prisma.browserContext.findUnique = (async () => ({
      contextId: profileId,
    })) as typeof prisma.browserContext.findUnique;
    prisma.browserSession.findFirst = (async (input: { where: { sessionId: string } }) =>
      phase === 'clearNative' && status === 'ACTIVE' && input.where.sessionId === sessionId
        ? { id: 'captured-profile-task' }
        : null) as typeof prisma.browserSession.findFirst;
    steel.sessions.release = (async (id: string) => {
      if (phase === 'ambiguous' && !lateAllocated)
        throw Object.assign(new Error('not allocated yet'), { status: 404 });
      if (phase === 'ambiguous') {
        assert.equal(id, lastCandidateId);
        lateReleased = true;
      }
      return {};
    }) as typeof steel.sessions.release;
    steel.sessions.retrieve = (async (id: string) => {
      if (phase === 'clearNative') return { id, status: 'live' };
      if (phase === 'transientLive')
        return { id, status: releasedCandidateIds.has(id) ? 'released' : 'live' };
      if (phase === 'ambiguous') {
        if (!lateAllocated) throw Object.assign(new Error('not allocated yet'), { status: 404 });
        return { id, status: lateReleased ? 'released' : 'live' };
      }
      if (phase === 'inflight')
        throw Object.assign(new Error('native absence does not settle an in-flight create'), {
          status: 404,
        });
      return { id, status: 'released' };
    }) as typeof steel.sessions.retrieve;
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
            closedAt,
            providerProfileId:
              recordedSource === 'steel_session_auth_invalidated'
                ? invalidatedRecordedProfileId
                : profileId,
            providerProfileSource: recordedSource,
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
      where: {
        sessionId?: string;
        status?: string;
        closedAt?: Date | null;
        providerProfileSource?: string;
        providerProfileId?: string;
        providerProfilePersist?: boolean;
        provider?: string;
      };
      data: {
        status?: string;
        sessionId?: string;
        providerProfileId?: string;
        closedAt?: Date | null;
      };
    }) => {
      if (
        input.where.sessionId !== sessionId ||
        (input.where.status && input.where.status !== status) ||
        ('closedAt' in input.where &&
          (input.where.closedAt?.getTime() ?? null) !== (closedAt?.getTime() ?? null)) ||
        ('providerProfileSource' in input.where &&
          input.where.providerProfileSource !== recordedSource) ||
        ('providerProfileId' in input.where &&
          input.where.providerProfileId !==
            (recordedSource === 'steel_session_auth_invalidated'
              ? invalidatedRecordedProfileId
              : profileId)) ||
        ('providerProfilePersist' in input.where && input.where.providerProfilePersist !== true) ||
        ('provider' in input.where && input.where.provider !== 'steel')
      )
        return { count: 0 };
      if (input.data.sessionId && phase === 'cas') return { count: 0 };
      if ('providerProfileId' in input.data) assert.equal(input.data.providerProfileId, profileId);
      status = input.data.status ?? status;
      if ('closedAt' in input.data) closedAt = input.data.closedAt ?? null;
      sessionId = input.data.sessionId ?? sessionId;
      return { count: 1 };
    }) as typeof prisma.browserSession.updateMany;
    prisma.integration.findUnique = (async () => null) as typeof prisma.integration.findUnique;
    prisma.browserProviderProfile.upsert =
      (async () => ({})) as typeof prisma.browserProviderProfile.upsert;
    prisma.browserContext.update = (async () => ({})) as typeof prisma.browserContext.update;
    const dependencies = {
      inspectSession: async (id: string) => {
        if (id !== oldId) return steel.sessions.retrieve(id);
        return {
          id,
          profileId: phase === 'foreign' ? 'foreign-profile' : profileId,
          persistProfile: true,
          status: released ? 'released' : 'live',
        };
      },
      releaseSession: async (id: string) => {
        releases.push(id);
        if (id !== oldId) releasedCandidateIds.add(id);
        if (id !== oldId && phase === 'cleanup') throw new Error('candidate cleanup rejected');
        if (id === oldId) {
          assert.equal(status, 'PAUSED', 'must claim exact writer before release');
          if (phase === 'release') throw new Error('release acknowledgement lost');
          if (phase === 'releaseConfirmed') {
            released = true;
            throw new Error('release acknowledgement lost');
          }
          released = true;
        }
      },
      createSession: async (input: {
        sessionId?: string;
        profileId?: string;
        sessionContext?: unknown;
      }) => {
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
        if (phase === 'create') throw Object.assign(new Error('create rejected'), { status: 400 });
        lastCandidateId = input.sessionId!;
        if (phase === 'ambiguous') throw new Error('native create transport timeout');
        if (['transientResolved', 'transientLive'].includes(phase) && createCalls === 2)
          throw new Error('Connection error');
        if (phase === 'unexpectedPrepare') {
          lastCandidateId = `${input.sessionId!.slice(0, -6)}abcdef`;
        }
        return { id: lastCandidateId, debugUrl: 'https://steel.example/debug', profileId };
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
    assert.equal(sessionId, result.sessionId);
    assert.deepEqual(releases, [oldId]);

    for (const failure of [
      'release',
      'releaseConfirmed',
      'readiness',
      'create',
      'validation',
      'cleanup',
      'foreign',
      'cas',
    ]) {
      reset(failure);
      await assert.rejects(run());
      assert.equal(sessionId, oldId, 'failed replacement must not publish a candidate');
      assert.equal(
        status,
        failure === 'foreign' ? 'ACTIVE' : failure === 'release' ? 'ERROR' : 'PAUSED'
      );
      if (failure === 'foreign') assert.deepEqual(releases, []);
      if (failure === 'readiness') assert.equal(createCalls, 5);
      if (failure === 'validation') assert.equal(releases.filter((id) => id !== oldId).length, 4);
      if (failure === 'cas') assert(releases.some((id) => id !== oldId));
      if (failure === 'cleanup') {
        assert(inFlightSteelSessionIds().has(lastCandidateId));
        unregisterInFlightSteelSession(lastCandidateId);
        assert.equal(
          candidates.get(`steel-candidate-cleanup:${lastCandidateId}`)?.status,
          'PENDING'
        );
        const recovered = await reconcileSteelCandidateCleanup({
          inFlight: () => new Set(),
          held: async () => false,
          release: async (id) => {
            assert.equal(id, lastCandidateId);
            releases.push(id);
          },
        });
        assert.equal(recovered.released, 1);
        assert.equal(
          candidates.get(`steel-candidate-cleanup:${lastCandidateId}`)?.status,
          'RELEASED'
        );
      }
    }
    reset('success');
    recordedSource = 'steel_session_auth_invalidated';
    const invalidatedClaim = await withSteelLifecycleClaim(`profile:${profileId}`, async () => {
      await assert.rejects(run(), /already in progress/);
    });
    void invalidatedClaim;
    assert.deepEqual(releases, [], 'invalidated binding must claim the resolved context profile');
    recordedSource = 'new_user_persistent';

    for (const transientPhase of ['transientResolved', 'transientLive']) {
      reset(transientPhase);
      const retried = await run();
      assert.equal(createCalls, 3, 'retain the original transient Connection error retry contract');
      assert.equal(sessionId, retried.sessionId);
      assert.equal(status, 'ACTIVE');
      assert(![...claims.values()].some((item) => item.request.nativeOutstanding));
      assert(![...candidates.values()].some((item) => item.status === 'PENDING'));
      if (transientPhase === 'transientLive')
        assert(
          releases.some((id) => id !== oldId),
          'exact live candidate must be released before another UUID is allocated'
        );
    }

    reset('unexpectedPrepare');
    const intentsBeforeUnexpected = new Set(candidates.keys());
    await assert.rejects(run(), /custody write rejected/);
    assert.equal(sessionId, oldId);
    assert.equal(status, 'PAUSED');
    assert(
      releases.includes(lastCandidateId),
      'known unexpected allocation must be cleaned despite bookkeeping failure'
    );
    assert(
      [...candidates]
        .filter(([key]) => !intentsBeforeUnexpected.has(key))
        .some(([, item]) => item.status === 'PENDING'),
      'requested custody must not be falsely discharged by a different echo'
    );

    candidates.clear(); // isolate the acknowledged contract-violation scenario
    for (const preSendPhase of ['preSendExpiry', 'preSendProfile']) {
      reset(preSendPhase);
      await assert.rejects(run(), /expired/);
      assert.equal(createCalls, 0, 'expiry before request dispatch must not call provider');
      assert(
        ![...claims.values()].some((item) => item.request.nativeOutstanding),
        'known-unsent request must not strand custody'
      );
      assert([...candidates.values()].every((item) => item.status === 'RELEASED'));
      clockOffset = 0;
      claims.clear();
      candidates.clear();
    }

    reset('ambiguous');
    await assert.rejects(run(), /Failed to release Steel session/);
    const ambiguousId = lastCandidateId;
    assert.equal(candidates.get(`steel-candidate-cleanup:${ambiguousId}`)?.status, 'PENDING');
    assert(!releases.includes(ambiguousId), 'ambiguous create must not settle through release404');
    unregisterInFlightSteelSession(ambiguousId);
    clockOffset = steelSessionTimeoutMs() + 1;
    const absentRecovery = await reconcileSteelCandidateCleanup({
      inFlight: () => new Set(),
      held: async () => false,
    });
    assert.equal(absentRecovery.released, 0);
    assert.equal(candidates.get(`steel-candidate-cleanup:${ambiguousId}`)?.status, 'PENDING');
    assert(
      [...claims.values()].some(
        (item) => item.status === 'STARTED' && item.request.nativeOutstanding
      )
    );
    lateAllocated = true;
    const lateRecovery = await reconcileSteelCandidateCleanup({
      inFlight: () => new Set(),
      held: async () => false,
    });
    assert.equal(lateRecovery.released, 1);
    assert.equal(lateReleased, true);
    assert.equal(candidates.get(`steel-candidate-cleanup:${ambiguousId}`)?.status, 'RELEASED');
    clockOffset = 0;
    claims.clear();

    reset('commitBookkeeping');
    const committedDespiteIntentError = await run();
    assert.equal(status, 'ACTIVE');
    assert.equal(sessionId, committedDespiteIntentError.sessionId);
    assert.equal(createCalls, 2);
    assert.equal(candidates.get(`steel-candidate-cleanup:${sessionId}`)?.status, 'PENDING');

    candidates.clear(); // COMMITTED bookkeeping scenario has been asserted
    reset('leaseRelease');
    const committedDespiteLeaseError = await run();
    assert.equal(status, 'ACTIVE');
    assert.equal(sessionId, committedDespiteLeaseError.sessionId);
    assert.equal(createCalls, 2, 'postcommit lease cleanup must not repeat native create');
    claims.clear(); // next isolated fixture scenario

    reset('clearNative');
    const committedWithNativeCustody = await run();
    assert.equal(status, 'ACTIVE');
    assert.equal(sessionId, committedWithNativeCustody.sessionId);
    clockOffset = steelSessionTimeoutMs() + 1;
    await withSteelLifecycleClaim('captured-profile-task', async () => undefined);
    await withSteelLifecycleClaim(`profile:${profileId}`, async () => undefined);
    assert.equal(sessionId, committedWithNativeCustody.sessionId);
    assert.deepEqual(
      releases,
      [oldId],
      'recovery must transfer custody to committed binding without closing it'
    );
    clockOffset = 0;
    claims.clear();

    const originalCreate = dependencies.createSession;
    for (const expiryMode of ['inflight', 'inflightRecovered', 'writeGap']) {
      reset(expiryMode);
      let acknowledge!: () => void;
      let entered!: () => void;
      const nativeGate = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const nativeEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      mutationHeld = false;
      mutationEntered = entered;
      mutationGate = nativeGate;
      let held = false;
      dependencies.createSession = async (input) => {
        const resource = await originalCreate(input);
        if (!held && expiryMode !== 'writeGap') {
          held = true;
          entered();
          await nativeGate;
        }
        return resource;
      };
      const oldOperation = run();
      await nativeEntered;
      const pendingId = lastCandidateId;
      clockOffset = steelSessionTimeoutMs() + 1;
      let winner: Awaited<ReturnType<typeof recreateSession>> | undefined;
      if (expiryMode === 'inflight') await assert.rejects(run(), /already in progress/);
      else winner = await run(); // exact terminal native confirmation permits takeover
      acknowledge();
      await assert.rejects(oldOperation, /expired|cleanup|ownership/);
      assert.equal(status, winner ? 'ACTIVE' : 'PAUSED');
      assert.equal(
        sessionId,
        winner ? winner.sessionId : oldId,
        'stale owner must not overwrite the winner'
      );
      assert.equal(candidates.get(`steel-candidate-cleanup:${pendingId}`)?.status, 'PENDING');
      unregisterInFlightSteelSession(pendingId);
      phase = 'restart';
      const restart = await reconcileSteelCandidateCleanup({
        inFlight: () => new Set(),
        held: async (id) => id === sessionId && status === 'ACTIVE',
        release: async (id) => {
          assert.equal(id, pendingId);
        },
      });
      assert.equal(restart.released, 1);
      assert.equal(candidates.get(`steel-candidate-cleanup:${pendingId}`)?.status, 'RELEASED');
      dependencies.createSession = originalCreate;
      mutationEntered = undefined;
      mutationGate = undefined;
      clockOffset = 0;
    }

    reset('success');
    const competing = await Promise.allSettled([run(), run(), closeSession(oldId, true)]);
    assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(releases.filter((id) => id === oldId).length, 1);
    assert.equal(status, 'ACTIVE');
  } finally {
    globalThis.fetch = originals.fetch;
    globalThis.Date = originals.date;
    if (originals.workspace === undefined) delete process.env.CONDUCTOR_WORKSPACE_NAME;
    else process.env.CONDUCTOR_WORKSPACE_NAME = originals.workspace;
    prisma.toolSideEffect.create = originals.candidateCreate;
    prisma.toolSideEffect.findUnique = originals.candidateFind;
    prisma.toolSideEffect.findMany = originals.candidateList;
    steel.sessions.retrieve = originals.nativeRead;
    steel.sessions.release = originals.nativeRelease;
    prisma.browserSession.findFirst = originals.heldRead;
    prisma.browserContext.findUnique = originals.contextRead;
    prisma.browserProviderProfile.findUnique = originals.profileRead;
    prisma.$queryRaw = originals.query;
    prisma.$transaction = originals.transaction;
    prisma.toolSideEffect.updateMany = originals.claim;
    prisma.browserSession.findUnique = originals.find;
    prisma.browserSession.updateMany = originals.update;
    prisma.integration.findUnique = originals.integration;
    prisma.browserProviderProfile.upsert = originals.profile;
    prisma.browserContext.update = originals.context;
    unregisterInFlightSteelSession(lastCandidateId);
    assert.equal(externalFetches, 0, 'lifecycle fixture must make no external calls');
  }
}
