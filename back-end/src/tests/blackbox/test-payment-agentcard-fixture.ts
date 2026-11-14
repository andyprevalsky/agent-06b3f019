import { getV2ConnectedUserId } from '../../providers/agentcard/store';
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
  assert(typeof config.v2UserId === 'string', 'reset must retain the exclusive provider identity');
  assert(config.onboardingSessionId === undefined, 'reset must not manufacture an MCP session');
  assert((await getV2ConnectedUserId(userId)) === undefined, 'reset must require connection again');
}
