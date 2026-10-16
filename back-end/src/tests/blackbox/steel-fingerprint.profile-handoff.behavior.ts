import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { recreateSession } from '../../providers/steel/sessionResume';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function testWritableSteelProfileHandoffRetainsRecoveryCustody(): Promise<void> {
  const findUnique = prisma.browserSession.findUnique;
  const updateMany = prisma.browserSession.updateMany;
  const integrationFindUnique = prisma.integration.findUnique;
  const profileUpsert = prisma.browserProviderProfile.upsert;
  const contextUpdate = prisma.browserContext.update;
  const leaseUpdateMany = prisma.toolSideEffect.updateMany;
  const fixture = randomUUID();
  const sourceId = `steel-profile-handoff-old-${fixture}`;
  const profileId = `steel-profile-handoff-profile-${fixture}`;
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
  const leaseKey = `browser:steel-profile-handoff:${row.id}:${sourceId}`;
  let releases = 0;
  let candidateReleases = 0;
  let creates = 0;
  let failCreate = true;
  let custodyAvailable = true;
  let closeBeforeCheckpoint = false;
  let closeBeforePublication = false;
  let revokeBeforePublication = false;
  let createStarted: (() => void) | undefined;
  let createBarrier: Promise<void> | undefined;
  const resetSource = () => {
    row = { ...row, sessionId: sourceId, status: 'ACTIVE', closedAt: null };
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
    prisma.browserSession.findUnique = (async (args: { select?: unknown }) =>
      args.select ? null : { ...row }) as typeof findUnique;
    prisma.integration.findUnique = (async () => null) as typeof integrationFindUnique;
    prisma.browserProviderProfile.upsert = (async () => ({})) as typeof profileUpsert;
    prisma.browserContext.update = (async () => ({})) as typeof contextUpdate;
    prisma.browserSession.updateMany = (async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (closeBeforeCheckpoint && args.data.status === 'PAUSED') {
        closeBeforeCheckpoint = false;
        row = { ...row, status: 'CLOSED', closedAt: new Date() };
      }
      if (!custodyAvailable || !matches(args.where)) return { count: 0 };
      row = { ...row, ...args.data };
      return { count: 1 };
    }) as typeof updateMany;
    const dependencies = {
      retrieveProfile: async () => ({ status: 'READY' }),
      releaseSession: async (sessionId: string) => {
        if (sessionId !== sourceId) {
          assert(sessionId.startsWith('steel-profile-handoff-new-'), 'released unrelated session');
          candidateReleases++;
          return;
        }
        assert(row.status === 'PAUSED', 'source release preceded durable resumable custody');
        assert(
          row.sessionId === sessionId && row.providerProfileId === profileId,
          'source release lost the exact session/profile recovery binding'
        );
        releases++;
      },
      createSession: async (input: { profileId?: string }) => {
        creates++;
        if (releases === 0) {
          throw Object.assign(
            new Error('409 Profile is still uploading until its source is released'),
            { status: 409 }
          );
        }
        assert(input.profileId === profileId, 'replacement changed profile');
        createStarted?.();
        await createBarrier;
        if (failCreate) throw new Error('503 Deliberate replacement creation failure');
        return {
          id: `steel-profile-handoff-new-${creates}`,
          debugUrl: 'https://steel.example/debug',
          profileId: input.profileId,
        };
      },
      validateConnection: async () => {
        if (closeBeforePublication) {
          closeBeforePublication = false;
          row = { ...row, status: 'CLOSED', closedAt: new Date() };
        }
        if (revokeBeforePublication) {
          revokeBeforePublication = false;
          await prisma.toolSideEffect.update({
            where: { operationKey: leaseKey },
            data: { externalId: 'test-successor-owner' },
          });
        }
        return null;
      },
    };
    const failure = await attempt(dependencies);
    assert(releases === 1, 'writable profile was retried while its source session remained live');
    assert(failure instanceof Error && failure.message.includes('503'), 'expected create failure');
    assert(row.status === 'PAUSED', 'failed replacement lost resumable source custody');
    assert(row.sessionId === sourceId, 'failed replacement published a new session');
    assert(row.providerProfileId === profileId, 'failed replacement lost profile');
    failCreate = false;
    const recovered = await recreateSession(row.id, { forceManagedRotation: true }, dependencies);
    assert(recovered.sessionId === row.sessionId, 'replacement could not recover');
    assert(row.status === 'ACTIVE', 'recovery did not publish the replacement');
    assert(row.providerProfileId === profileId, 'recovery changed profile');

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

    // Existing explicit resume of a CLOSED snapshot remains supported.
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

    resetSource();
    revokeBeforePublication = true;
    const beforeLostCreates = creates;
    const beforeLostCandidateReleases = candidateReleases;
    const lostLease = await attempt(dependencies);
    assert(
      lostLease instanceof Error && lostLease.message.includes('lost lease'),
      'lost lease ignored'
    );
    assert(creates === beforeLostCreates + 1, 'revoked owner kept creating replacement candidates');
    assert(candidateReleases === beforeLostCandidateReleases + 1, 'revoked candidate leaked');
    assert(
      row.status === 'PAUSED' && row.sessionId === sourceId,
      'revoked owner published a session'
    );
    const successor = await prisma.toolSideEffect.findUniqueOrThrow({
      where: { operationKey: leaseKey },
    });
    assert(
      successor.externalId === 'test-successor-owner' && successor.status === 'STARTED',
      'stale release cleared the successor lease'
    );
    await prisma.toolSideEffect.deleteMany({ where: { operationKey: leaseKey } });

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
    createStarted = undefined;
    createBarrier = undefined;

    // A committed replacement is not handed off if final lease release throws.
    resetSource();
    const releaseFailure = new Error('fixture lease release failed');
    let localCloses = 0;
    const localBrowser = {
      close: async () => {
        localCloses++;
        throw new Error('fixture local close failed');
      },
    } as unknown as import('playwright').Browser;
    prisma.toolSideEffect.updateMany = (async (args: Parameters<typeof leaseUpdateMany>[0]) => {
      if (args.where?.operationKey === leaseKey && args.data.status === 'RELEASED') {
        throw releaseFailure;
      }
      return leaseUpdateMany.call(prisma.toolSideEffect, args);
    }) as typeof leaseUpdateMany;
    const beforeReleaseFailureCreates = creates;
    const beforeReleaseFailureSourceReleases = releases;
    const beforeReleaseFailureCandidateReleases = candidateReleases;
    let caughtReleaseFailure: unknown;
    try {
      await recreateSession(
        row.id,
        { forceManagedRotation: true, keepValidationConnection: true },
        {
          ...dependencies,
          validateConnection: async () => ({ browser: localBrowser, failure: null }),
        }
      );
    } catch (error) {
      caughtReleaseFailure = error;
    } finally {
      prisma.toolSideEffect.updateMany = leaseUpdateMany;
    }
    assert(caughtReleaseFailure === releaseFailure, 'local close replaced the lease release error');
    assert(localCloses === 1, 'unhanded owned validation connection was not closed exactly once');
    assert(creates === beforeReleaseFailureCreates + 1, 'lease release failure retried creation');
    assert(releases === beforeReleaseFailureSourceReleases + 1, 'source release was repeated');
    assert(
      candidateReleases === beforeReleaseFailureCandidateReleases,
      'committed remote session was released'
    );
    assert(
      row.status === 'ACTIVE' && row.sessionId !== sourceId,
      'lease release failure changed the committed binding'
    );
    assert(row.providerProfileId === profileId, 'lease release failure changed the profile');
  } finally {
    prisma.browserSession.findUnique = findUnique;
    prisma.browserSession.updateMany = updateMany;
    prisma.integration.findUnique = integrationFindUnique;
    prisma.browserProviderProfile.upsert = profileUpsert;
    prisma.browserContext.update = contextUpdate;
    prisma.toolSideEffect.updateMany = leaseUpdateMany;
    await prisma.toolSideEffect.deleteMany({ where: { operationKey: leaseKey } });
  }
}
