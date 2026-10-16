import { randomUUID } from 'node:crypto';
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
  const originals = {
    find: prisma.browserSession.findUnique,
    update: prisma.browserSession.updateMany,
    held: prisma.browserSession.findFirst,
    integration: prisma.integration.findUnique,
    profile: prisma.browserProviderProfile.upsert,
    context: prisma.browserContext.update,
    query: prisma.$queryRaw,
    transaction: prisma.$transaction,
    effectCreate: prisma.toolSideEffect.create,
    effectFind: prisma.toolSideEffect.findUnique,
    effectList: prisma.toolSideEffect.findMany,
    effectUpdate: prisma.toolSideEffect.updateMany,
    nativeCreate: steel.sessions.create,
    nativeRead: steel.sessions.retrieve,
    nativeRelease: steel.sessions.release,
    fetch: globalThis.fetch,
    workspace: process.env.CONDUCTOR_WORKSPACE_NAME,
  };
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
    globalThis.fetch = unexpectedNative as typeof fetch;
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
      args.select ? null : { ...row }) as typeof originals.find;
    prisma.browserSession.findFirst = (async () => null) as typeof originals.held;
    prisma.integration.findUnique = (async () => null) as typeof originals.integration;
    prisma.browserProviderProfile.upsert = (async () => ({})) as typeof originals.profile;
    prisma.browserContext.update = (async () => ({})) as typeof originals.context;
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
    }) as typeof originals.update;
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
    unregisterInFlightSteelSession(pending[0].externalId); // Simulate process exit.
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
    globalThis.fetch = originals.fetch;
    steel.sessions.create = originals.nativeCreate;
    steel.sessions.retrieve = originals.nativeRead;
    steel.sessions.release = originals.nativeRelease;
    prisma.$queryRaw = originals.query;
    prisma.$transaction = originals.transaction;
    prisma.toolSideEffect.create = originals.effectCreate;
    prisma.toolSideEffect.findUnique = originals.effectFind;
    prisma.toolSideEffect.findMany = originals.effectList;
    prisma.toolSideEffect.updateMany = originals.effectUpdate;
    prisma.browserSession.findUnique = originals.find;
    prisma.browserSession.updateMany = originals.update;
    prisma.browserSession.findFirst = originals.held;
    prisma.integration.findUnique = originals.integration;
    prisma.browserProviderProfile.upsert = originals.profile;
    prisma.browserContext.update = originals.context;
    if (originals.workspace === undefined) delete process.env.CONDUCTOR_WORKSPACE_NAME;
    else process.env.CONDUCTOR_WORKSPACE_NAME = originals.workspace;
  }
}
