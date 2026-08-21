import { startOrgCardholderOnboarding } from '../../providers/agentcard/org-onboarding';
import { prisma } from '../../providers/database';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function assertBenchmarkAgentCardResetFixture(userId: string): Promise<void> {
  const integration = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
  });
  assert(integration !== null, 'expected a deterministic sandbox onboarding fixture');
  assert(
    integration.status === 'NOT_CONNECTED',
    'expected reset integration to require connection'
  );
  assert(integration.isActive, 'expected reset fixture to remain active');
  const config =
    typeof integration.config === 'object' &&
    integration.config !== null &&
    !Array.isArray(integration.config)
      ? (integration.config as Record<string, unknown>)
      : {};
  const expectedSessionId = `benchmark-agentcard-onboarding-${userId}`;
  const expectedSetupUrl = 'https://example.invalid/agentcard/benchmark-onboarding';
  assert(config.orgManaged === true, 'expected org-managed reset fixture');
  assert(
    config.onboardingSessionId === expectedSessionId,
    'expected deterministic benchmark session'
  );
  assert(
    config.onboardingSetupUrl === expectedSetupUrl,
    'expected non-routable benchmark setup URL'
  );

  const onboarding = await startOrgCardholderOnboarding(userId, {
    callOrgTool: async () => {
      throw new Error('benchmark reset must not call the real onboarding provider');
    },
  });
  assert(onboarding.sessionId === expectedSessionId, 'expected the seeded session to be reused');
  assert(onboarding.setupUrl === expectedSetupUrl, 'expected the seeded setup URL to be reused');
}
