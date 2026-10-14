/**
 * Transient Steel SDK "Connection error" must backoff-retry rather than fail
 * the Kernel→Steel rotate ladder on the first flaky create.
 */
import { prisma } from '../../providers/database';
import { validateSessionConnectionWithReason } from '../../providers/steel/sessionConnection';
import type { withSteelLifecycleClaim } from '../../providers/steel/lifecycleClaim';
import { recreateSession } from '../../providers/steel/sessionResume';

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
