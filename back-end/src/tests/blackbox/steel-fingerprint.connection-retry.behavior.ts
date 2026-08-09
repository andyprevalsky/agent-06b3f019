/**
 * Transient Steel SDK "Connection error" must backoff-retry rather than fail
 * the Kernel→Steel rotate ladder on the first flaky create.
 */
import { prisma } from '../../providers/database';
import { recreateSession } from '../../providers/steel/sessionResume';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
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

  try {
    delete process.env.STEEL_PROXY_SERVER;
    process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED = 'true';
    (
      prisma.browserSession as unknown as { findUnique: typeof prisma.browserSession.findUnique }
    ).findUnique = (async () => ({
      id: 'replacement-connection-retry-task',
      sessionId: 'steel-connection-old',
      provider: 'kernel',
      providerProfileId: 'kernel-profile',
      providerProfileSource: 'kernel_session',
      providerProfilePersist: true,
      currentUrl: 'https://example.com/connection-retry',
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
        proxyCity: 'RCA TEST CITY',
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
        createSession: async (input) => {
          connectionInputs.push(input as unknown as Record<string, unknown>);
          if (connectionInputs.length < 3) {
            throw new Error('Connection error');
          }
          return {
            id: 'steel-after-connection-retry',
            debugUrl: 'https://steel.example/debug',
            profileId: null,
            proxySource: 'steel',
          };
        },
        validateConnection: async () => true,
      }
    );
    assert(
      connectionResult.sessionId === 'steel-after-connection-retry',
      'connection-error retry did not succeed'
    );
    assert(
      connectionInputs.length === 3,
      `expected three Steel create attempts after Connection error, got ${connectionInputs.length}`
    );
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
