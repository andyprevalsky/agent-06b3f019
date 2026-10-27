import assert from 'node:assert/strict';
import { unregisterInFlightSteelSession } from '../../providers/steel/sessionIdentity';
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
  const restoreClaims = mockCurrentLifecycleStorage();
  const nativeRetrieve = steel.sessions.retrieve;
  const allocated = new Map<string, 'live' | 'released'>();
  let newWriter = '';
  const events: string[] = [];
  let released = false;
  let reads = 0;
  let creates = 0;
  let binding = 'old-writer';
  let status = 'ACTIVE';
  const releases: string[] = [];
  const persistedFields: Record<string, unknown> = {};
  const sessionSnapshot = (): Record<string, unknown> => ({
    id: 'writer-profile-task',
    provider: 'steel',
    closedAt: null,
    providerProfileId: 'writer-profile',
    providerProfileSource: 'user_persistent',
    providerProfilePersist: true,
    currentUrl: null,
    startUrl: null,
    agentId: 'writer-agent',
    contextId: 'writer-context',
    context: { userId: 'writer-user' },
    ...persistedFields,
    sessionId: binding,
    status,
  });
  try {
    prisma.browserSession.findUnique = (async (args: { select?: unknown }) =>
      args.select ? null : sessionSnapshot()) as typeof findSession;
    prisma.browserSession.updateMany = (async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown> & { sessionId?: string; status?: string };
    }) => {
      const row = sessionSnapshot();
      const matches = Object.entries(args.where).every(([key, expected]) => {
        const actual = row[key];
        return expected instanceof Date && actual instanceof Date
          ? expected.getTime() === actual.getTime()
          : actual === expected;
      });
      if (!matches) return { count: 0 };
      Object.assign(persistedFields, args.data);
      if (args.data.sessionId) binding = args.data.sessionId;
      if (args.data.status) status = args.data.status;
      return { count: 1 };
    }) as typeof updateSession;
    prisma.agent.findUnique = (async () => null) as typeof findAgent;
    prisma.integration.findUnique = (async () => null) as typeof findIntegration;
    prisma.browserProviderProfile.upsert = (async () => ({})) as typeof upsertProfile;
    prisma.browserContext.update = (async () => ({})) as typeof updateContext;
    const inspectSession = async (id: string) => {
      if (id !== 'old-writer' && !allocated.has(id)) {
        throw Object.assign(new Error('fixture native session absent'), { status: 404 });
      }
      return {
        id,
        profileId: 'writer-profile',
        persistProfile: true,
        status: id === 'old-writer' ? (released ? 'released' : 'live') : allocated.get(id)!,
      };
    };
    await assert.rejects(inspectSession('foreign-unallocated-session'), { status: 404 });
    steel.sessions.retrieve = inspectSession as typeof steel.sessions.retrieve;
    const dependencies = {
      inspectSession,
      releaseSession: async (id: string) => {
        releases.push(id);
        if (allocated.has(id)) {
          allocated.set(id, 'released');
          return;
        }
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
            where: { operationKey: 'steel-browser-task-lifecycle:writer-profile-task' },
            data: { externalId: 'profile-read-successor' },
          });
        }
        return { status: profileStatus };
      },
      createSession: async (input: {
        sessionId?: string;
        profileId?: string;
        persistProfile?: boolean;
      }) => {
        creates++;
        assert(input.sessionId, 'replacement must use client-selected identity');
        newWriter = input.sessionId;
        allocated.set(newWriter, 'live');
        assert.equal(input.profileId, 'writer-profile');
        assert.equal(input.persistProfile, true);
        if (!released || reads < 2) {
          throw Object.assign(
            new Error("409 Profile 'writer-profile' is still uploading and cannot be attached"),
            { status: 409 }
          );
        }
        if (mode === 'failed-create') {
          allocated.set(newWriter, 'released'); // Exact terminal evidence permits bounded retry.
          throw new Error('provider create unavailable');
        }
        events.push('create-replacement');
        return {
          id: newWriter,
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
        mode === 'lost-lease-during-profile-read' ? /ownership changed/ : undefined
      );
      assert.deepEqual(
        releases,
        mode === 'lost-cas' ? ['old-writer', newWriter] : ['old-writer'],
        'handoff must only release its exact writer and any uncommitted replacement'
      );
      assert.equal(binding, mode === 'lost-cas' ? 'concurrent-writer' : 'old-writer');
      // Unconfirmed release retains ERROR custody; confirmed release retains PAUSED recovery.
      assert.equal(
        status,
        mode === 'lost-cas' ? 'ACTIVE' : mode === 'failed-release' ? 'ERROR' : 'PAUSED'
      );
      if (mode === 'lost-lease-during-profile-read') {
        assert.equal(reads, 2);
        assert.equal(creates, 0, 'lost readiness-reader lease allocated a replacement');
        const successor = await prisma.toolSideEffect.findUniqueOrThrow({
          where: { operationKey: 'steel-browser-task-lifecycle:writer-profile-task' },
        });
        assert.equal(successor.externalId, 'profile-read-successor');
        assert.equal(successor.status, 'STARTED');
      }
      if (mode === 'failed-profile') assert.equal(reads, 1, 'FAILED is terminal');
      if (mode === 'failed-profile' || mode === 'failed-release') assert.equal(creates, 0);
      return;
    }
    const result = await replacement;
    assert.equal(result.sessionId, newWriter);
    assert.equal(binding, newWriter);
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
    steel.sessions.retrieve = nativeRetrieve;
    for (const id of allocated.keys()) await unregisterInFlightSteelSession(id);
    restoreClaims();
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

/** In-memory DB seam only: execute the production nested durable lifecycle claims. */
function mockCurrentLifecycleStorage(): () => void {
  const original = {
    query: prisma.$queryRaw,
    transaction: prisma.$transaction,
    create: prisma.toolSideEffect.create,
    find: prisma.toolSideEffect.findUnique,
    findThrow: prisma.toolSideEffect.findUniqueOrThrow,
    update: prisma.toolSideEffect.update,
    updateMany: prisma.toolSideEffect.updateMany,
  };
  type Row = {
    operationKey: string;
    operationType: string;
    externalId: string;
    status: string;
    request: Record<string, unknown>;
    updatedAt?: Date;
  };
  const rows = new Map<string, Row>();
  prisma.$transaction = (async (callback: (tx: typeof prisma) => Promise<unknown>) =>
    callback(prisma)) as typeof prisma.$transaction;
  prisma.$queryRaw = (async (query: { strings: string[]; values: unknown[] }) => {
    if (query.strings[0].includes('SELECT')) {
      assert(query.strings.join('').includes('FOR UPDATE'), 'claim mutation must lock its owner');
      const row = rows.get(String(query.values[0]));
      return row ? [{ ...row, request: { ...row.request } }] : [];
    }
    const key = String(query.values[1]);
    const held = rows.get(key);
    if (held?.status === 'STARTED') return [];
    const row = {
      operationKey: key,
      operationType: 'steel_browser_task_lifecycle',
      externalId: String(query.values[3]),
      status: 'STARTED',
      request: JSON.parse(String(query.values[4])),
      updatedAt: query.values[5] as Date,
    };
    rows.set(key, row);
    return [{ externalId: row.externalId }];
  }) as typeof prisma.$queryRaw;
  prisma.toolSideEffect.create = (async ({ data }: { data: Row }) => {
    assert(!rows.has(data.operationKey), 'candidate identity duplicated');
    rows.set(data.operationKey, data);
    return data;
  }) as typeof prisma.toolSideEffect.create;
  prisma.toolSideEffect.findUnique = (async ({ where }: { where: { operationKey: string } }) =>
    rows.get(where.operationKey) ?? null) as typeof prisma.toolSideEffect.findUnique;
  prisma.toolSideEffect.findUniqueOrThrow = (async ({
    where,
  }: {
    where: { operationKey: string };
  }) => {
    const row = rows.get(where.operationKey);
    assert(row, 'expected real claim');
    return row;
  }) as typeof prisma.toolSideEffect.findUniqueOrThrow;
  prisma.toolSideEffect.update = (async ({
    where,
    data,
  }: {
    where: { operationKey: string };
    data: Partial<Row>;
  }) => {
    const row = rows.get(where.operationKey);
    assert(row, 'cannot revoke absent claim');
    Object.assign(row, data);
    return row;
  }) as typeof prisma.toolSideEffect.update;
  prisma.toolSideEffect.updateMany = (async ({
    where,
    data,
  }: {
    where: Partial<Row>;
    data: Partial<Row>;
  }) => {
    const row = rows.get(where.operationKey!);
    if (
      !row ||
      (where.externalId !== undefined && row.externalId !== where.externalId) ||
      (where.status !== undefined && row.status !== where.status) ||
      (where.operationType !== undefined && row.operationType !== where.operationType)
    )
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  }) as typeof prisma.toolSideEffect.updateMany;
  return () => {
    prisma.$queryRaw = original.query;
    prisma.$transaction = original.transaction;
    prisma.toolSideEffect.create = original.create;
    prisma.toolSideEffect.findUnique = original.find;
    prisma.toolSideEffect.findUniqueOrThrow = original.findThrow;
    prisma.toolSideEffect.update = original.update;
    prisma.toolSideEffect.updateMany = original.updateMany;
  };
}
