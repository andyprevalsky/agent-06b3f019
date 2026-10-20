import { announceBrowserSessionBinding } from '../../providers/browser/sessionBindingAnnounce';
import { releaseSupersededBrowser } from '../../providers/browser/sessionCleanup';
import { injectUserData } from '../../providers/steel/injection';
import { withOwnedResumeTransport } from '../../providers/browser/resumeTransport';
/**
 * Transient Steel SDK "Connection error" must backoff-retry rather than fail
 * the Kernel→Steel rotate ladder on the first flaky create.
 */
import { __flushBroadcastQueueForTests } from '../../providers/chat/supabaseBroadcast';
import { prisma } from '../../providers/database';
import { validateSessionConnectionWithReason } from '../../providers/steel/sessionConnection';
import type { withSteelLifecycleClaim } from '../../providers/steel/lifecycleClaim';
import { navigateToSavedUrl, recreateSession } from '../../providers/steel/sessionResume';

// These legacy cases mock DB/provider effects; ambiguity still needs exact terminal evidence.
export const withReleasedFixtureLifecycleClaim: typeof withSteelLifecycleClaim = async (
  _taskId,
  callback
) =>
  callback(undefined!, undefined!, undefined!, async (id, inspect) => {
    const native = await inspect();
    return native.id === id && native.status === 'released';
  });

export const fixtureCandidateCleanup = {
  prepareCandidateCleanup: async () => {},
  settleCandidateCleanup: async () => {},
};

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export async function testRawCdpFailureClassification(): Promise<void> {
  const timeout = await validateSessionConnectionWithReason('wss://steel.example/cdp', async () => {
    throw new Error('connectOverCDP timed out after 10000ms');
  });
  assert(
    !timeout.valid && timeout.failureReason === 'Connection timeout',
    'raw CDP timeout must remain a connection timeout through the validation adapter'
  );

  let attempts = 0;
  const auth = await validateSessionConnectionWithReason('wss://steel.example/cdp', async () => {
    attempts++;
    if (attempts === 1) throw new Error('403 Forbidden');
    throw new Error('Connection timeout');
  });
  assert(
    !auth.valid && auth.failureReason === 'Authentication rejected',
    'an auth rejection must not be masked by a later connection timeout'
  );
  assert(attempts === 1, 'CDP validation must not retry an authentication rejection');
}

export async function testConnectionErrorRetriesOnReplacement(): Promise<void> {
  const browserSessionFindUnique = prisma.browserSession.findUnique;
  const browserSessionUpdateMany = prisma.browserSession.updateMany;
  const agentFindUnique = prisma.agent.findUnique;
  const integrationFindUnique = prisma.integration.findUnique;
  const profileFindUnique = prisma.browserProviderProfile.findUnique;
  const contextFindUnique = prisma.browserContext.findUnique;
  const previousProxyServer = process.env.STEEL_PROXY_SERVER;
  const previousProxyEnabled = process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED;
  let savedUrl: string | null = 'https://example.com/connection-retry';
  // rotateBrowserProxy reserves the rotation before the provider recreates the
  // session, so the row a rotation reads already carries its own position.
  let replacedSessionId = 'steel-connection-old';
  let proxyRotationCount = 1;

  try {
    delete process.env.STEEL_PROXY_SERVER;
    process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED = 'true';
    (
      prisma.browserSession as unknown as { findUnique: typeof prisma.browserSession.findUnique }
    ).findUnique = (async () => ({
      id: 'replacement-connection-retry-task',
      sessionId: replacedSessionId,
      proxyRotationCount,
      provider: 'kernel',
      providerProfileId: 'kernel-profile',
      providerProfileSource: 'kernel_session',
      providerProfilePersist: true,
      currentUrl: savedUrl,
      startUrl: null,
      agentId: 'replacement-city-retry-agent',
      contextId: 'replacement-city-retry-context',
      context: { userId: 'replacement-city-retry-user' },
    })) as typeof prisma.browserSession.findUnique;
    (
      prisma.browserSession as unknown as { updateMany: typeof prisma.browserSession.updateMany }
    ).updateMany = (async () => ({ count: 1 })) as typeof prisma.browserSession.updateMany;
    (prisma.agent as unknown as { findUnique: typeof prisma.agent.findUnique }).findUnique =
      (async () => ({
        proxyCountry: 'US',
        proxyState: 'CA',
        // A distinct city: the rejected-city test memoizes 'RCA TEST CITY' for the process.
        proxyCity: 'RCA RESUME CITY',
      })) as typeof prisma.agent.findUnique;
    (
      prisma.integration as unknown as { findUnique: typeof prisma.integration.findUnique }
    ).findUnique = (async () => null) as typeof prisma.integration.findUnique;
    (
      prisma.browserProviderProfile as unknown as {
        findUnique: typeof prisma.browserProviderProfile.findUnique;
      }
    ).findUnique = (async () => null) as typeof prisma.browserProviderProfile.findUnique;
    (
      prisma.browserContext as unknown as { findUnique: typeof prisma.browserContext.findUnique }
    ).findUnique = (async () => ({ contextId: null })) as typeof prisma.browserContext.findUnique;

    const connectionInputs: Array<Record<string, unknown>> = [];
    const connectionResult = await recreateSession(
      'replacement-connection-retry-task',
      { forceManagedRotation: true },
      {
        withLifecycleClaim: withReleasedFixtureLifecycleClaim,
        inspectSession: async (id) => ({ id, status: 'released' }),
        releaseSession: async () => {},
        ...fixtureCandidateCleanup,
        createSession: async (input) => {
          connectionInputs.push(input as unknown as Record<string, unknown>);
          if (connectionInputs.length < 3) {
            throw new Error('Connection error');
          }
          return {
            id: input.sessionId!,
            debugUrl: 'https://steel.example/debug',
            profileId: null,
            proxySource: 'steel',
          };
        },
        validateConnection: async () => null,
      }
    );
    assert(
      connectionResult.sessionId === connectionInputs[2]?.sessionId,
      'connection-error retry did not succeed'
    );
    assert(
      connectionInputs.length === 3,
      `expected three Steel create attempts after Connection error, got ${connectionInputs.length}`
    );
    // A rotation must land on a different egress IP: Steel's pool kept handing
    // the same exit node back for the same state, so a rotation requests another
    // US state and no city. Resumes keep the user's own location.
    const rotationGeo = (
      connectionInputs[0].useProxy as { geolocation?: Record<string, unknown> } | undefined
    )?.geolocation;
    assert(
      rotationGeo !== undefined &&
        rotationGeo.country === 'US' &&
        typeof rotationGeo.state === 'string' &&
        rotationGeo.state !== 'CA' &&
        rotationGeo.city === undefined,
      `rotation must request a different state without a city, got ${JSON.stringify(rotationGeo)}`
    );
    // Every rotation of a task moves again. Live parity (2026-10-07) replaced
    // Kernel session ociyyt6sx5uvqc1j22yq7g94 and then Steel session
    // eaac6de5-290b-4bf9-bc9d-d7effdd6b147: both rotations asked Steel for FL
    // and the second session read the first one's exit IP.
    const consecutiveStates: unknown[] = [];
    for (const [position, sessionId] of [
      [3, 'ociyyt6sx5uvqc1j22yq7g94'],
      [4, 'eaac6de5-290b-4bf9-bc9d-d7effdd6b147'],
    ] as const) {
      proxyRotationCount = position;
      replacedSessionId = sessionId;
      await recreateSession(
        'replacement-connection-retry-task',
        { forceManagedRotation: true },
        {
          withLifecycleClaim: withReleasedFixtureLifecycleClaim,
          inspectSession: async (id) => ({ id, status: 'released' }),
          releaseSession: async () => {},
          ...fixtureCandidateCleanup,
          createSession: async (input) => {
            const geo = (input as { useProxy?: { geolocation?: Record<string, unknown> } }).useProxy
              ?.geolocation;
            consecutiveStates.push(geo?.state);
            return {
              id: input.sessionId!,
              debugUrl: 'https://steel.example/debug',
              profileId: null,
              proxySource: 'steel',
            };
          },
          validateConnection: async () => null,
        }
      );
    }
    assert(
      consecutiveStates.length === 2 &&
        consecutiveStates.every((state) => typeof state === 'string' && state !== 'CA') &&
        consecutiveStates[0] !== consecutiveStates[1],
      `consecutive rotations must request different states, got ${JSON.stringify(consecutiveStates)}`
    );
    // A committed replacement is not handed off if its enclosing lifecycle claim
    // rejects as it settles: close the kept validation transport exactly once
    // (even when close itself fails) and forward the claim's original error.
    const claimFailure = new Error('fixture lifecycle claim release failed');
    let localCloses = 0;
    let claimCreates = 0;
    let claimReleases = 0;
    const localBrowser = {
      close: async () => {
        localCloses++;
        throw new Error('fixture local close failed');
      },
    } as unknown as import('playwright').Browser;
    const priorSavedUrl = savedUrl;
    savedUrl = null;
    const claimRejection = await recreateSession(
      'replacement-connection-retry-task',
      { forceManagedRotation: true, keepValidationConnection: true },
      {
        withLifecycleClaim: (async (...args: Parameters<typeof withSteelLifecycleClaim>) => {
          await withReleasedFixtureLifecycleClaim(...args);
          throw claimFailure;
        }) as typeof withSteelLifecycleClaim,
        inspectSession: async (id) => ({ id, status: 'released' }),
        releaseSession: async () => {
          claimReleases++;
        },
        ...fixtureCandidateCleanup,
        createSession: async (input) => {
          claimCreates++;
          return { id: input.sessionId!, debugUrl: 'https://steel.example/debug', profileId: null };
        },
        validateConnection: async () => ({ browser: localBrowser, failure: null }),
      }
    ).catch((error: unknown) => error);
    savedUrl = priorSavedUrl;
    assert(claimRejection === claimFailure, 'local close replaced the claim release error');
    assert(localCloses === 1, 'unhanded owned validation connection was not closed exactly once');
    assert(claimCreates === 1, 'claim release failure retried creation');
    assert(claimReleases === 0, 'committed remote session was released');
    const resumeInputs: Array<Record<string, unknown>> = [];
    await recreateSession(
      'replacement-connection-retry-task',
      { forceManagedRotation: false },
      {
        withLifecycleClaim: withReleasedFixtureLifecycleClaim,
        inspectSession: async (id) => ({ id, status: 'released' }),
        releaseSession: async () => {},
        ...fixtureCandidateCleanup,
        createSession: async (input) => {
          resumeInputs.push(input as unknown as Record<string, unknown>);
          return {
            id: input.sessionId!,
            debugUrl: 'https://steel.example/debug',
            profileId: null,
            proxySource: 'steel',
          };
        },
        validateConnection: async () => null,
      }
    );
    const resumeGeo = (
      resumeInputs[0]?.useProxy as { geolocation?: Record<string, unknown> } | undefined
    )?.geolocation;
    assert(
      resumeGeo !== undefined && resumeGeo.city === 'RCA RESUME CITY',
      `resume must keep the user's city, got ${JSON.stringify(resumeGeo)}`
    );

    // A created session whose CDP validation times out must retain the
    // connectivity reason through the replacement error. The live parity gate
    // can only distinguish this outage from a Steel auth or contract defect
    // when the owning provider returns that reason.
    savedUrl = null;
    let validationFailure: unknown;
    let releasedSessions = 0;
    try {
      await recreateSession(
        'replacement-connection-retry-task',
        { forceManagedRotation: true },
        {
          withLifecycleClaim: withReleasedFixtureLifecycleClaim,
          inspectSession: async (id) => ({ id, status: 'released' }),
          ...fixtureCandidateCleanup,
          createSession: async (input) => ({
            id: input.sessionId!,
            debugUrl: 'https://steel.example/debug',
            profileId: null,
          }),
          validateConnection: async () => 'Connection timeout',
          releaseSession: async () => {
            releasedSessions += 1;
          },
        }
      );
    } catch (error) {
      validationFailure = error;
    }
    assert(
      validationFailure instanceof Error &&
        validationFailure.message.includes('Connection timeout'),
      `replacement lost the CDP timeout reason: ${String(validationFailure)}`
    );
    assert(releasedSessions === 5, 'replacement did not release every invalid Steel session');
    let transportCloses = 0;
    const retained = {
      close: async () => {
        transportCloses += 1;
      },
    } as import('playwright').Browser;
    const retainedResult = await recreateSession(
      'replacement-connection-retry-task',
      { forceManagedRotation: false, keepValidationConnection: true },
      {
        withLifecycleClaim: withReleasedFixtureLifecycleClaim,
        inspectSession: async (id) => ({ id, status: 'released' }),
        ...fixtureCandidateCleanup,
        // The ownership contract adopts only the client-selected session ID.
        createSession: async (input) => ({
          id: input.sessionId!,
          debugUrl: 'https://steel.example/debug',
          profileId: null,
        }),
        validateConnection: async () => ({ browser: retained, failure: null }),
      }
    );
    assert(
      retainedResult.validationBrowser === retained && transportCloses === 0,
      'replacement discarded or closed the handed-off validation transport'
    );
    await withOwnedResumeTransport(retainedResult, async () => undefined);
    assert(transportCloses === 1, 'handed-off transport was not closed once by assembly owner');
    Object.assign(prisma.browserSession, { updateMany: async () => ({ count: 0 }) });
    transportCloses = 0;
    let casReleases = 0;
    let casFailure: unknown;
    try {
      await recreateSession(
        'replacement-connection-retry-task',
        { forceManagedRotation: false, keepValidationConnection: true },
        {
          withLifecycleClaim: withReleasedFixtureLifecycleClaim,
          inspectSession: async (id) => ({ id, status: 'released' }),
          ...fixtureCandidateCleanup,
          createSession: async (input) => ({
            id: input.sessionId!,
            debugUrl: 'https://steel.example/debug',
            profileId: null,
          }),
          validateConnection: async () => ({ browser: retained, failure: null }),
          releaseSession: async () => {
            casReleases += 1;
          },
        }
      );
    } catch (error) {
      casFailure = error;
    }
    assert(
      casFailure instanceof Error && casReleases === 1 && transportCloses === 1,
      'CAS loss must close only its transport and release only its uncommitted session once'
    );
    // Deliver this fixture's binding announcements before a later fixture observes broadcasts.
    await __flushBroadcastQueueForTests();
  } finally {
    (
      prisma.browserSession as unknown as { findUnique: typeof prisma.browserSession.findUnique }
    ).findUnique = browserSessionFindUnique;
    (
      prisma.browserSession as unknown as { updateMany: typeof prisma.browserSession.updateMany }
    ).updateMany = browserSessionUpdateMany;
    (prisma.agent as unknown as { findUnique: typeof prisma.agent.findUnique }).findUnique =
      agentFindUnique;
    (
      prisma.integration as unknown as { findUnique: typeof prisma.integration.findUnique }
    ).findUnique = integrationFindUnique;
    (
      prisma.browserProviderProfile as unknown as {
        findUnique: typeof prisma.browserProviderProfile.findUnique;
      }
    ).findUnique = profileFindUnique;
    (
      prisma.browserContext as unknown as { findUnique: typeof prisma.browserContext.findUnique }
    ).findUnique = contextFindUnique;
    if (previousProxyServer === undefined) delete process.env.STEEL_PROXY_SERVER;
    else process.env.STEEL_PROXY_SERVER = previousProxyServer;
    if (previousProxyEnabled === undefined) delete process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED;
    else process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED = previousProxyEnabled;
  }
}

export async function testSavedUrlNavigationAlwaysClosesBrowser(): Promise<void> {
  let closeCount = 0;
  const browser = {
    contexts: () => [
      {
        pages: () => [
          {
            goto: async () => {
              throw new Error('navigation timeout');
            },
          },
        ],
        newPage: async () => {
          throw new Error('unexpected new page');
        },
      },
    ],
    close: async () => {
      closeCount += 1;
    },
  };

  await navigateToSavedUrl(
    'wss://connect.steel.dev?sessionId=session-1',
    'https://example.com/saved',
    async () => browser as unknown as import('playwright').Browser
  );
  assert(closeCount === 1, `failed saved-URL navigation closed browser ${closeCount} times`);
  let reconnects = 0;
  await navigateToSavedUrl(
    'wss://connect.steel.dev?sessionId=session-1',
    'https://example.com/saved',
    async () => {
      reconnects += 1;
      throw new Error('replacement transport must not reconnect');
    },
    browser as unknown as import('playwright').Browser
  );
  assert(reconnects === 0, `borrowed saved navigation reconnected ${reconnects} times`);
  assert(closeCount === 1, 'borrowed saved navigation closed the handoff transport');
  const sessionFind = prisma.browserSession.findUnique;
  const integrationFind = prisma.integration.findFirst;
  const localFind = prisma.localStorageOrigin.findMany;
  const indexedFind = prisma.indexedDBOrigin.findMany;
  const permissionFind = prisma.browserPermission.findMany;
  const cacheFind = prisma.cacheStorageOrigin.findMany;
  const bundleFind = prisma.cookieBundle.findMany;
  const cookieFind = prisma.cookie.findMany;
  const previousDisableAuth = process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
  try {
    Object.assign(prisma.browserSession, { findUnique: async () => null });
    Object.assign(prisma.integration, { findFirst: async () => null });
    Object.assign(prisma.localStorageOrigin, { findMany: async () => [] });
    Object.assign(prisma.indexedDBOrigin, { findMany: async () => [] });
    Object.assign(prisma.browserPermission, { findMany: async () => [] });
    Object.assign(prisma.cacheStorageOrigin, { findMany: async () => [] });
    let missingSessionFailure: unknown;
    try {
      await injectUserData('missing-transport-session', 'fixture-user', 'https://example.com', {
        browser: browser as import('playwright').Browser,
      });
    } catch (error) {
      missingSessionFailure = error;
    }
    assert(
      missingSessionFailure instanceof Error &&
        missingSessionFailure.message === 'No WebSocket URL found for session',
      'missing-session injection changed its existing error'
    );
    assert(closeCount === 1, 'early injection error closed the borrowed owner transport');
    let dbFailure: unknown;
    const expectedLookupError = new Error('lookup fixture failure');
    Object.assign(prisma.browserSession, {
      findUnique: async () => {
        throw expectedLookupError;
      },
    });
    try {
      await withOwnedResumeTransport({ validationBrowser: browser }, () =>
        injectUserData('lookup-failure-session', 'fixture-user', 'https://example.com', {
          browser: browser as import('playwright').Browser,
        })
      );
    } catch (error) {
      dbFailure = error;
    }
    assert(
      dbFailure === expectedLookupError && closeCount === 2,
      'pre-injection DB failure must preserve the error and close its owner once'
    );
    delete process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
    Object.assign(prisma.browserSession, {
      findUnique: async () => ({
        provider: 'kernel',
        wsUrl: 'ws://already-connected.invalid',
        context: { userId: 'fixture-user' },
      }),
    });
    Object.assign(prisma.cookieBundle, {
      findMany: async () => [
        {
          id: 'fixture-bundle',
          browserSource: 'chrome',
          browserProfile: 'Default',
          disabledAt: null,
        },
      ],
    });
    let cookieReads = 0;
    Object.assign(prisma.cookie, {
      findMany: async () =>
        ++cookieReads === 1
          ? [{ name: 'session', creationUtc: 1000n, hasExpires: false, expiresUtc: 0n }]
          : [],
    });
    let cookieFailure: unknown;
    try {
      await withOwnedResumeTransport({ validationBrowser: browser }, () =>
        injectUserData('cookie-race-session', 'fixture-user', 'https://example.com', {
          browser: browser as import('playwright').Browser,
        })
      );
    } catch (error) {
      cookieFailure = error;
    }
    assert(
      cookieFailure instanceof Error &&
        cookieFailure.message.includes('contains no cookie rows') &&
        closeCount === 3,
      'cookie-selection race must retain its error and close its owner once'
    );
  } finally {
    Object.assign(prisma.browserSession, { findUnique: sessionFind });
    Object.assign(prisma.integration, { findFirst: integrationFind });
    Object.assign(prisma.localStorageOrigin, { findMany: localFind });
    Object.assign(prisma.indexedDBOrigin, { findMany: indexedFind });
    Object.assign(prisma.browserPermission, { findMany: permissionFind });
    Object.assign(prisma.cacheStorageOrigin, { findMany: cacheFind });
    Object.assign(prisma.cookieBundle, { findMany: bundleFind });
    Object.assign(prisma.cookie, { findMany: cookieFind });
    if (previousDisableAuth === undefined) delete process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
    else process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH = previousDisableAuth;
  }
  let nonfatalCloseCount = 0;
  const nonfatalOwner = {
    validationBrowser: {
      close: async () => {
        nonfatalCloseCount += 1;
      },
    },
  };
  const nonfatalResult = await withOwnedResumeTransport(nonfatalOwner, async () => {
    await announceBrowserSessionBinding(
      { id: 'fixture-task' },
      {
        findRow: async () => {
          throw new Error('announcement fixture failure');
        },
      }
    );
    const released = await releaseSupersededBrowser(
      {
        taskId: 'fixture-task',
        previousProvider: 'kernel',
        previousSessionId: 'superseded-fixture',
        operation: 'rotation',
      },
      {
        releaseKernel: async () => {
          throw new Error('release fixture failure');
        },
        releaseSteel: async () => {
          throw new Error('unexpected Steel release');
        },
        releaseBrowserUse: async () => {
          throw new Error('unexpected Browser Use release');
        },
      }
    );
    assert(
      released === false && nonfatalCloseCount === 0,
      'nonfatal announcement/release failure changed handoff custody'
    );
    return 'retained-result';
  });
  assert(
    nonfatalResult === 'retained-result' && nonfatalCloseCount === 1,
    'nonfatal publication/release failure lost result or leaked owner transport'
  );
  for (let iteration = 0; iteration < 10_000; iteration++) {
    let ownedCloseCount = 0;
    const expected = new Error('assembly fixture failure');
    const fail = iteration % 2 === 0;
    let outcome: unknown;
    try {
      outcome = await withOwnedResumeTransport(
        {
          validationBrowser: {
            close: async () => {
              ownedCloseCount += 1;
            },
          },
        },
        async () => {
          if (fail) throw expected;
          return iteration;
        }
      );
    } catch (error) {
      outcome = error;
    }
    assert(ownedCloseCount === 1, `assembly owner close count ${ownedCloseCount}`);
    assert(outcome === (fail ? expected : iteration), 'assembly owner changed action outcome');
  }

  // The whole assembly action, including its first lookup and later preparation,
  // is inside this owner. Repeated failure/success cannot accumulate transports.
}
