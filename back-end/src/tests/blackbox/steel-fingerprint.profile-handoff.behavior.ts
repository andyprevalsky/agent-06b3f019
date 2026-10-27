import { randomUUID } from 'node:crypto';
import { __flushBroadcastQueueForTests } from '../../providers/chat/supabaseBroadcast';
import { prisma } from '../../providers/database';
import { steel } from '../../providers/steel/session';
import { recreateSession } from '../../providers/steel/sessionResume';
import { reconcileSteelCandidateCleanup } from '../../providers/steel/candidateCleanup';
import { unregisterInFlightSteelSession } from '../../providers/steel/sessionIdentity';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Real lifecycle/custody code; native and database effects are wholly in-memory. */
export async function testWritableSteelProfileHandoffRetainsRecoveryCustody(): Promise<void> {
  // Every patched provider/database entry point is restored after the fixture.
  const patched: Array<[object, string]> = [
    [prisma.browserSession, 'findUnique'],
    [prisma.browserSession, 'updateMany'],
    [prisma.browserSession, 'findFirst'],
    [prisma.integration, 'findUnique'],
    [prisma.browserProviderProfile, 'upsert'],
    [prisma.browserContext, 'update'],
    [prisma, '$queryRaw'],
    [prisma, '$transaction'],
    [prisma.toolSideEffect, 'create'],
    [prisma.toolSideEffect, 'findUnique'],
    [prisma.toolSideEffect, 'findMany'],
    [prisma.toolSideEffect, 'updateMany'],
    [steel.sessions, 'create'],
    [steel.sessions, 'retrieve'],
    [steel.sessions, 'release'],
    [globalThis, 'fetch'],
  ];
  const originals = patched.map(([target, key]) => Reflect.get(target, key) as unknown);
  const workspace = process.env.CONDUCTOR_WORKSPACE_NAME;
  const fixture = randomUUID();
  const sourceId = randomUUID();
  const profileId = randomUUID();
  let row = {
    id: `steel-profile-handoff-task-${fixture}`,
    sessionId: sourceId,
    provider: 'steel',
    status: 'ACTIVE',
    closedAt: null as Date | null,
    providerProfileId: profileId,
    providerProfileSource: 'new_user_persistent',
    providerProfilePersist: true,
    currentUrl: null,
    startUrl: null,
    agentId: null,
    contextId: `steel-profile-handoff-context-${fixture}`,
    context: { userId: `steel-profile-handoff-user-${fixture}` },
    proxyRotationCount: 4,
  };
  const leaseKey = `steel-browser-task-lifecycle:${row.id}`;
  type Effect = {
    operationKey: string;
    operationType: string;
    externalId: string;
    status: string;
    request: Record<string, unknown>;
    updatedAt?: Date;
  };
  const leases = new Map<string, Effect>();
  const intents = new Map<string, Effect>();
  const candidates = new Map<string, 'live' | 'released'>();
  let sourceReleased = false;
  let releases = 0;
  let candidateReleases = 0;
  let creates = 0;
  let failCreate = true;
  let profileMode: 'ready' | 'failed' | 'uploading' | 'revoked' | 'read-failed' = 'ready';
  let profileReads = 0;
  let custodyAvailable = true;
  let closeBeforeCheckpoint = false;
  let closeBeforePublication = false;
  let revokeBeforePublication = false;
  let checkpointChange: 'closedAt' | 'profileSource' | undefined;
  let publicationChange: 'closedAt' | 'profileSource' | undefined;
  let externalRequests = 0;
  let observeBindings = false;
  const announcements: Record<string, unknown>[] = [];
  let createStarted: (() => void) | undefined;
  let createBarrier: Promise<void> | undefined;
  const resetSource = () => {
    row = {
      ...row,
      sessionId: sourceId,
      status: 'ACTIVE',
      closedAt: null,
      providerProfileSource: 'new_user_persistent',
      providerProfilePersist: true,
    };
    sourceReleased = false;
  };
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, expected]) => {
      const actual = (row as Record<string, unknown>)[key];
      return expected instanceof Date && actual instanceof Date
        ? expected.getTime() === actual.getTime()
        : actual === expected;
    });
  const attempt = async (dependencies: Parameters<typeof recreateSession>[2]) => {
    try {
      await recreateSession(row.id, { forceManagedRotation: true }, dependencies);
      return undefined;
    } catch (error) {
      return error;
    }
  };
  try {
    process.env.CONDUCTOR_WORKSPACE_NAME = `steel-profile-handoff-${fixture}`;
    const unexpectedNative = async () => {
      externalRequests++;
      throw new Error('unexpected external request in profile-handoff fixture');
    };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (observeBindings && String(url).endsWith('/realtime/v1/api/broadcast')) {
        const body = JSON.parse(String(init?.body));
        for (const message of body.messages) {
          assert(message.event === 'BROWSER_SESSION', 'unexpected broadcast event');
          announcements.push(message.payload.record);
        }
        return new Response('{}', { status: 200 });
      }
      return unexpectedNative();
    }) as typeof fetch;
    steel.sessions.create = unexpectedNative as typeof steel.sessions.create;
    steel.sessions.release = unexpectedNative as typeof steel.sessions.release;
    prisma.$transaction = (async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma)) as typeof prisma.$transaction;
    prisma.$queryRaw = (async (query: { strings: string[]; values: unknown[] }) => {
      if (query.strings[0].includes('SELECT')) {
        assert(query.strings.join('').includes('FOR UPDATE'), 'mutation omitted owner row lock');
        const lease = leases.get(String(query.values[0]));
        return lease ? [{ ...lease, request: { ...lease.request } }] : [];
      }
      const key = String(query.values[1]);
      const owner = String(query.values[3]);
      const request = JSON.parse(String(query.values[4]));
      const now = query.values[5] as Date;
      const lease = leases.get(key);
      if (
        lease?.status === 'STARTED' &&
        (Date.parse(String(lease.request.expiresAt)) > now.getTime() ||
          lease.request.nativeOutstanding === true)
      )
        return [];
      leases.set(key, {
        operationKey: key,
        operationType: 'steel_browser_task_lifecycle',
        externalId: owner,
        status: 'STARTED',
        request,
        updatedAt: now,
      });
      return [{ externalId: owner }];
    }) as typeof prisma.$queryRaw;
    prisma.toolSideEffect.create = (async (input: { data: Effect }) => {
      assert(!intents.has(input.data.operationKey), 'candidate custody identity duplicated');
      intents.set(input.data.operationKey, input.data);
      return input.data;
    }) as typeof prisma.toolSideEffect.create;
    prisma.toolSideEffect.findUnique = (async (input: { where: { operationKey: string } }) =>
      leases.get(input.where.operationKey) ?? null) as typeof prisma.toolSideEffect.findUnique;
    prisma.toolSideEffect.findMany = (async () =>
      [...intents.values()].filter(
        (intent) => intent.status === 'PENDING'
      )) as typeof prisma.toolSideEffect.findMany;
    prisma.toolSideEffect.updateMany = (async (input: {
      where: {
        operationKey: string;
        externalId: string;
        operationType?: string;
      };
      data: Partial<Effect>;
    }) => {
      const table = input.where.operationType === 'steel_candidate_cleanup' ? intents : leases;
      const effect = table.get(input.where.operationKey);
      if (!effect || effect.externalId !== input.where.externalId) return { count: 0 };
      Object.assign(effect, input.data);
      return { count: 1 };
    }) as typeof prisma.toolSideEffect.updateMany;
    prisma.browserSession.findUnique = (async (args: { select?: unknown }) =>
      args.select
        ? observeBindings
          ? { ...row, agentId: fixture, debugUrl: null }
          : null
        : { ...row }) as typeof prisma.browserSession.findUnique;
    prisma.browserSession.findFirst = (async () => null) as typeof prisma.browserSession.findFirst;
    prisma.integration.findUnique = (async () => null) as typeof prisma.integration.findUnique;
    prisma.browserProviderProfile.upsert =
      (async () => ({})) as typeof prisma.browserProviderProfile.upsert;
    prisma.browserContext.update = (async () => ({})) as typeof prisma.browserContext.update;
    prisma.browserSession.updateMany = (async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (closeBeforeCheckpoint && args.data.status === 'PAUSED') {
        closeBeforeCheckpoint = false;
        sourceReleased = true; // The competing close completed its native release.
        row = { ...row, status: 'CLOSED', closedAt: new Date() };
      }
      if (checkpointChange && args.data.status === 'PAUSED') {
        if (checkpointChange === 'closedAt') row.closedAt = new Date();
        else row.providerProfileSource = 'steel_session_auth_invalidated';
        checkpointChange = undefined;
      }
      if (!custodyAvailable || !matches(args.where)) return { count: 0 };
      row = { ...row, ...args.data };
      return { count: 1 };
    }) as typeof prisma.browserSession.updateMany;
    const inspectSession = async (id: string) => {
      if (id !== sourceId && !candidates.has(id))
        throw Object.assign(new Error('native fixture session absent'), {
          status: 404,
        });
      return {
        id,
        profileId,
        persistProfile: true,
        status: id === sourceId ? (sourceReleased ? 'released' : 'live') : candidates.get(id)!,
      };
    };
    steel.sessions.retrieve = inspectSession as typeof steel.sessions.retrieve;
    const dependencies = {
      inspectSession,
      retrieveProfile: async (id: string) => {
        assert(id === profileId, 'readiness inspected a foreign profile');
        assert(sourceReleased, 'readiness preceded confirmed writer release');
        profileReads++;
        if (profileMode === 'read-failed') throw new Error('deliberate readiness read unavailable');
        if (profileMode === 'revoked') {
          const lease = leases.get(leaseKey);
          assert(lease, 'readiness lost real task claim');
          lease.externalId = 'readiness-successor';
        }
        return {
          status:
            profileMode === 'failed'
              ? 'FAILED'
              : profileMode === 'uploading' && profileReads === 1
                ? 'UPLOADING'
                : 'READY',
        };
      },
      releaseSession: async (sessionId: string) => {
        if (sessionId !== sourceId) {
          assert(candidates.has(sessionId), 'released unrelated session');
          candidateReleases++;
          candidates.set(sessionId, 'released');
          return;
        }
        assert(row.status === 'PAUSED', 'source release preceded durable resumable transition');
        assert(
          row.sessionId === sessionId && row.providerProfileId === profileId,
          'source release lost the exact session/profile recovery binding'
        );
        sourceReleased = true;
        releases++;
      },
      createSession: async (input: {
        profileId?: string;
        sessionId?: string;
        sessionContext?: unknown;
      }) => {
        creates++;
        assert(sourceReleased, 'replacement attached before its exact writer was released');
        assert(input.profileId === profileId, 'replacement changed full profile');
        assert(input.sessionContext === undefined, 'replacement substituted partial context');
        assert(typeof input.sessionId === 'string', 'candidate omitted client-owned UUID');
        createStarted?.();
        await createBarrier;
        if (failCreate) {
          // Native failure after allocation/termination: exact terminal evidence
          // permits the existing bounded retry without orphaning another UUID.
          candidates.set(input.sessionId, 'released');
          throw Object.assign(new Error('503 Deliberate replacement creation failure'), {
            status: 503,
          });
        }
        candidates.set(input.sessionId, 'live');
        return {
          id: input.sessionId,
          debugUrl: 'https://steel.example/debug',
          profileId,
        };
      },
      validateConnection: async () => {
        if (publicationChange) {
          if (publicationChange === 'closedAt') row.closedAt = new Date();
          else row.providerProfileSource = 'steel_session_auth_invalidated';
          publicationChange = undefined;
        }
        if (closeBeforePublication) {
          closeBeforePublication = false;
          row = { ...row, status: 'CLOSED', closedAt: new Date() };
        }
        if (revokeBeforePublication) {
          revokeBeforePublication = false;
          const lease = leases.get(leaseKey);
          assert(lease, 'ownership revocation found no real lifecycle claim');
          lease.externalId = 'test-successor-owner';
        }
        return null;
      },
    };
    for (const nativeReleased of [false, true]) {
      resetSource();
      observeBindings = true;
      const releaseError = new Error('deliberate exact writer release acknowledgement loss');
      const beforeCreates = creates;
      const beforeAnnouncements = announcements.length;
      const failure = await attempt({
        ...dependencies,
        releaseSession: async (id: string) => {
          assert(
            id === sourceId && row.status === 'PAUSED',
            'release was not exact claimed writer'
          );
          releases++;
          sourceReleased = nativeReleased;
          throw releaseError;
        },
      });
      await __flushBroadcastQueueForTests();
      assert(failure === releaseError, 'writer failure was replaced or swallowed');
      assert(creates === beforeCreates, 'writer release failure created a replacement');
      assert(
        row.status === (nativeReleased ? 'PAUSED' : 'ERROR'),
        'recovery custody state changed'
      );
      assert(
        announcements.length === beforeAnnouncements + 1,
        'committed writer failure omitted binding announcement'
      );
      const notice = announcements[announcements.length - 1];
      assert(
        notice.taskId === row.id &&
          notice.sessionId === sourceId &&
          notice.status === row.status &&
          notice.live === false,
        'announcement did not project exact persisted failed binding'
      );
      observeBindings = false;
      // The entire native/lease store belongs to this in-memory fixture; preserve
      // the actual failed-custody assertions above before isolating the next case.
      leases.clear();
    }
    for (const concurrentChange of ['closed', 'rebound'] as const) {
      resetSource();
      observeBindings = true;
      const releaseError = new Error('deliberate writer failure after concurrent binding change');
      const beforeAnnouncements = announcements.length;
      const failure = await attempt({
        ...dependencies,
        releaseSession: async () => {
          if (concurrentChange === 'closed')
            row = { ...row, status: 'CLOSED', closedAt: new Date() };
          else row = { ...row, sessionId: randomUUID(), status: 'ACTIVE' };
          throw releaseError;
        },
      });
      await __flushBroadcastQueueForTests();
      assert(failure === releaseError, 'concurrent writer failure lost original error');
      assert(
        announcements.length === beforeAnnouncements,
        'failed writer CAS announced another binding'
      );
      assert(
        concurrentChange === 'closed' ? row.status === 'CLOSED' : row.sessionId !== sourceId,
        'writer error overwrote concurrent binding'
      );
      observeBindings = false;
      leases.clear();
    }
    for (const mode of ['failed', 'uploading', 'revoked', 'read-failed'] as const) {
      resetSource();
      profileMode = mode;
      profileReads = 0;
      const beforeCreates = creates;
      const result = await attempt(dependencies);
      assert(result instanceof Error, 'deliberate readiness/create control unexpectedly succeeded');
      if (mode === 'failed') {
        assert(result.message.includes('failed to persist'), 'FAILED profile was not terminal');
        assert(
          profileReads === 1 && creates === beforeCreates,
          'FAILED profile allocated or retried'
        );
      } else if (mode === 'uploading') {
        assert(profileReads === 5, 'profile readiness lost existing bounded retry');
        assert(creates === beforeCreates + 4, 'UPLOADING profile allocated a replacement');
      } else if (mode === 'read-failed') {
        assert(
          profileReads === 5 && creates === beforeCreates,
          'unavailable readiness allocated or lost bounded retry'
        );
      } else {
        assert(creates === beforeCreates, 'revoked readiness owner allocated a replacement');
        assert(
          leases.get(leaseKey)?.externalId === 'readiness-successor',
          'stale owner cleared successor'
        );
        leases.delete(leaseKey); // Fixture owns successor; isolate subsequent controls.
      }
    }
    resetSource();
    profileMode = 'ready';
    profileReads = 0;
    releases = 0;
    creates = 0;
    const failure = await attempt(dependencies);
    assert(releases === 1, 'writable profile was retried while its source session remained live');
    assert(failure instanceof Error && failure.message.includes('503'), 'expected create failure');
    assert(creates === 5, 'deliberate terminal 503 lost the existing five-attempt bound');
    assert(
      row.status === 'PAUSED' && row.closedAt === null,
      'confirmed release failure must retain resumable custody'
    );
    assert(row.sessionId === sourceId, 'failed replacement published a new session');
    assert(row.providerProfileId === profileId, 'failed replacement lost profile');
    assert(
      [...intents.values()].every((intent) => intent.status === 'RELEASED'),
      'terminal failure left candidate custody unresolved'
    );
    failCreate = false;
    const recovered = await recreateSession(row.id, { forceManagedRotation: true }, dependencies);
    assert(recovered.sessionId === row.sessionId, 'replacement could not recover');
    assert(row.status === 'ACTIVE', 'recovery did not publish the replacement');
    assert(row.providerProfileId === profileId, 'recovery changed profile');

    for (const sourceStatus of ['ACTIVE', 'PAUSED', 'CLOSED']) {
      for (const nativeReleased of [false, true]) {
        resetSource();
        row.status = sourceStatus;
        row.closedAt = sourceStatus === 'CLOSED' ? new Date() : null;
        sourceReleased = nativeReleased;
        const beforeRelease = releases;
        const replacement = await recreateSession(
          row.id,
          { forceManagedRotation: true },
          dependencies
        );
        assert(
          releases === beforeRelease + (nativeReleased ? 0 : 1),
          'resume duplicated release or attached a live writer'
        );
        assert(
          replacement.previousSessionReleased === true,
          'resume lost prior-release wrapper suppression'
        );
        assert(
          row.status === 'ACTIVE' && row.providerProfileId === profileId,
          'status/native matrix lost full binding'
        );
      }
    }

    resetSource();
    custodyAvailable = false;
    const priorReleases = releases;
    const priorCreates = creates;
    assert((await attempt(dependencies)) instanceof Error, 'missing custody did not fail closed');
    assert(
      releases === priorReleases && creates === priorCreates,
      'lost custody allowed provider effects'
    );
    custodyAvailable = true;

    closeBeforeCheckpoint = true;
    assert((await attempt(dependencies)) instanceof Error, 'concurrent close was resurrected');
    assert(row.status === 'CLOSED' && row.closedAt !== null, 'checkpoint changed terminal row');
    assert(
      releases === priorReleases && creates === priorCreates,
      'close allowed provider effects'
    );
    await recreateSession(row.id, { forceManagedRotation: true }, dependencies);
    assert(row.status === 'ACTIVE', 'intentional CLOSED resume was prohibited');

    resetSource();
    closeBeforePublication = true;
    const priorCandidateReleases = candidateReleases;
    assert(
      (await attempt(dependencies)) instanceof Error,
      'publication resurrected concurrent close'
    );
    assert(
      row.status === 'CLOSED' && row.sessionId === sourceId,
      'publication replaced terminal row'
    );
    assert(candidateReleases === priorCandidateReleases + 1, 'unpublished candidate leaked');

    for (const field of ['closedAt', 'profileSource'] as const) {
      resetSource();
      checkpointChange = field;
      const beforeCheckpointRelease = releases;
      const beforeCheckpointCreate = creates;
      assert(
        (await attempt(dependencies)) instanceof Error,
        'changed checkpoint snapshot was ignored'
      );
      assert(
        releases === beforeCheckpointRelease && creates === beforeCheckpointCreate,
        'changed checkpoint authorized provider effects'
      );
      assert(row.sessionId === sourceId, 'checkpoint change published another binding');
      resetSource();
      publicationChange = field;
      const beforePublicationCleanup = candidateReleases;
      assert(
        (await attempt(dependencies)) instanceof Error,
        'changed publication snapshot was ignored'
      );
      assert(
        row.sessionId === sourceId && row.status === 'PAUSED',
        'publication overwrote changed source snapshot'
      );
      assert(
        candidateReleases === beforePublicationCleanup + 1,
        'snapshot loser leaked its candidate'
      );
      assert(
        field === 'closedAt'
          ? row.closedAt !== null
          : row.providerProfileSource === 'steel_session_auth_invalidated',
        'publication erased the concurrent snapshot change'
      );
    }

    resetSource();
    revokeBeforePublication = true;
    const beforeLostCreates = creates;
    const beforeLostCandidateReleases = candidateReleases;
    const lostLease = await attempt(dependencies);
    assert(
      lostLease instanceof Error && /ownership changed|Failed to release/.test(lostLease.message),
      'lost ownership ignored'
    );
    assert(creates === beforeLostCreates + 1, 'revoked owner kept creating replacement candidates');
    assert(
      candidateReleases === beforeLostCandidateReleases,
      'stale owner performed native effects after revocation'
    );
    assert(
      row.status === 'PAUSED' && row.sessionId === sourceId,
      'revoked owner published or overwrote successor state'
    );
    const successor = leases.get(leaseKey);
    assert(
      successor?.externalId === 'test-successor-owner' && successor.status === 'STARTED',
      'stale release cleared successor lease'
    );
    const pending = [...intents.values()].filter((intent) => intent.status === 'PENDING');
    assert(
      pending.length === 1 && candidates.get(pending[0].externalId) === 'live',
      'revoked candidate lost durable custody'
    );
    await unregisterInFlightSteelSession(pending[0].externalId); // Simulate process exit.
    successor.status = 'RELEASED'; // The successor, not the stale callback, relinquishes ownership.
    const reconciled = await reconcileSteelCandidateCleanup({
      inFlight: () => new Set(),
      held: async () => false,
      release: dependencies.releaseSession,
      inspect: inspectSession,
    });
    assert(
      reconciled.released === 1 && reconciled.failed === 0,
      'restart did not reconcile revoked candidate'
    );
    assert(
      candidateReleases === beforeLostCandidateReleases + 1,
      'revoked candidate leaked after custody transfer'
    );
    assert(
      pending[0].status === 'RELEASED' && candidates.get(pending[0].externalId) === 'released',
      'restart falsely discharged candidate'
    );

    resetSource();
    let continueCreate!: () => void;
    const started = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    createBarrier = new Promise<void>((resolve) => {
      continueCreate = resolve;
    });
    const first = attempt(dependencies);
    await started;
    const overlapReleases = releases;
    const overlapCreates = creates;
    const contender = await attempt(dependencies);
    assert(contender instanceof Error, 'overlapping replacement acquired the same source');
    assert(
      releases === overlapReleases && creates === overlapCreates,
      'overlapping replacement performed provider effects'
    );
    continueCreate();
    assert((await first) === undefined, 'exclusive owner could not finish replacement');

    assert(
      [...intents.values()].every((intent) => intent.status !== 'PENDING'),
      'completed fixture stranded candidate custody'
    );
    assert(externalRequests === 0, 'fixture performed external provider/database traffic');
  } finally {
    patched.forEach(([target, key], index) => Reflect.set(target, key, originals[index]));
    if (workspace === undefined) delete process.env.CONDUCTOR_WORKSPACE_NAME;
    else process.env.CONDUCTOR_WORKSPACE_NAME = workspace;
  }
}
