#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { EmailProvider, IntegrationStatus, IntegrationType } from '@prisma/client';
import { prisma } from '../../providers/database';
import { classifierUnavailableDecision } from '../../domains/credential-propagation/classifier';
import { propagatePostRunCredentials } from '../../domains/credential-propagation/service';

config();
process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM = '1';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const createdAgentIds = new Set<string>();

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createUser() {
  const userId = `prop-${randomUUID()}`;
  await prisma.user.create({
    data: {
      userId,
      isAnonymous: true,
    },
  });
  return userId;
}

async function createAgent(params: {
  userId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
  statusMessage?: string | null;
}) {
  const agentId = randomUUID();
  await prisma.agent.create({
    data: {
      id: agentId,
      userId: params.userId,
      goal: 'Sign in and check the account page',
      status: params.status,
      statusMessage: params.statusMessage ?? null,
      model: 'rose-labs/rose-1-lite',
      reasoningMaxTokens: 2048,
    },
  });
  createdAgentIds.add(agentId);
  return agentId;
}

async function addCredentialMessage(agentId: string, kind: string, id: string, text = '') {
  await prisma.message.create({
    data: {
      agentId,
      role: 'TOOL',
      text,
      timestamp: new Date(),
      metadata: { credential_ref: { kind, id } },
    },
  });
}

async function cleanup(userId: string) {
  const agentIds = [...createdAgentIds];
  if (agentIds.length > 0) {
    await prisma.agentRunCredentialPropagation.deleteMany({
      where: {
        OR: [
          { agentId: { in: agentIds } },
          ...agentIds.map((agentId) => ({ agentId: { startsWith: `${agentId}:browser:` } })),
        ],
      },
    });
    for (const agentId of agentIds) createdAgentIds.delete(agentId);
  }
  await prisma.message.deleteMany({ where: { agent: { userId } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.browserPassword.deleteMany({ where: { userId } });
  await prisma.steelSessionAuth.deleteMany({ where: { userId } });
  await prisma.mintedAccount.deleteMany({ where: { userId } });
  await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

test('rerun hook is a no-op for the same agent and credential ref', async () => {
  const userId = await createUser();
  try {
    const minted = await prisma.mintedAccount.create({
      data: {
        userId,
        authRealm: 'example.com',
        accountLabel: 'agent@example.com',
        disabledAt: new Date(),
        disabledReason: 'previous failure',
      },
    });
    const agentId = await createAgent({ userId, status: 'COMPLETED' });
    await addCredentialMessage(agentId, 'minted', minted.id);

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });
    await prisma.mintedAccount.update({
      where: { id: minted.id },
      data: { disabledAt: new Date(), disabledReason: 'changed after first propagation' },
    });
    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });

    const updated = await prisma.mintedAccount.findUniqueOrThrow({ where: { id: minted.id } });
    assert(updated.disabledAt !== null, 'expected second propagation to skip the credential');
    assert(
      updated.disabledReason === 'changed after first propagation',
      'expected second propagation to preserve later change'
    );
  } finally {
    await cleanup(userId);
  }
});

test('email OTP credential refs record metadata when they point at an email credential', async () => {
  const userId = await createUser();
  try {
    const integration = await prisma.integration.create({
      data: {
        userId,
        name: 'gmail',
        type: IntegrationType.TOOL_SETUP,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });
    const credential = await prisma.emailIntegrationCredential.create({
      data: {
        userId,
        integrationId: integration.id,
        provider: EmailProvider.GMAIL,
        email: 'user@example.com',
        accessToken: 'access-token',
      },
    });
    const agentId = await createAgent({ userId, status: 'COMPLETED' });
    await addCredentialMessage(agentId, 'email_otp', credential.id);

    await propagatePostRunCredentials(agentId);

    const updated = await prisma.emailIntegrationCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    const metadata = updated.metadata as { lastUsedAt?: string } | null;
    assert(typeof metadata?.lastUsedAt === 'string', 'expected email OTP lastUsedAt metadata');
  } finally {
    await cleanup(userId);
  }
});

test('mocked classifier schema path can classify non-heuristic failures', async () => {
  const userId = await createUser();
  try {
    const cookieBundle = await prisma.cookieBundle.create({
      data: {
        userId,
        authRealm: 'example.com',
        browserSource: 'chrome',
        browserProfile: 'Default',
      },
    });
    const agentId = await createAgent({
      userId,
      status: 'FAILED',
      statusMessage: 'The final page could not be reached',
    });
    await addCredentialMessage(agentId, 'cookie_bundle', cookieBundle.id, 'Navigation failed');

    await withEnv(
      {
        CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
        CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
          reason: 'The site reported a temporary rate limit.',
          credentialOutcomes: [
            {
              reason: 'The credential was used, but the failure was a site rate limit.',
              kind: 'cookie_bundle',
              id: cookieBundle.id,
              outcome: 'rate_limited',
            },
          ],
        }),
      },
      async () => {
        await propagatePostRunCredentials(agentId);
      }
    );

    const updated = await prisma.cookieBundle.findUniqueOrThrow({ where: { id: cookieBundle.id } });
    assert(updated.disabledAt === null, 'expected rate limit not to disable credential');
    assert(
      updated.disabledReason?.includes('rate_limited') === true,
      'expected LLM reason recorded'
    );
  } finally {
    await cleanup(userId);
  }
});

test('classifier failure preserves raw error and leaves failureReason null', async () => {
  const userId = await createUser();
  try {
    const cookieBundle = await prisma.cookieBundle.create({
      data: {
        userId,
        authRealm: 'example.com',
        browserSource: 'chrome',
        browserProfile: 'Default',
      },
    });
    const agentId = await createAgent({
      userId,
      status: 'FAILED',
      statusMessage: 'Login failed: invalid password',
    });
    await addCredentialMessage(agentId, 'cookie_bundle', cookieBundle.id, 'Authentication failed');

    await withEnv(
      {
        CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
        CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: 'not json',
      },
      async () => {
        const decision = await propagatePostRunCredentials(agentId);
        assert(
          decision?.failureReason === null,
          'expected null failureReason on classifier failure'
        );
      }
    );

    const updated = await prisma.cookieBundle.findUniqueOrThrow({ where: { id: cookieBundle.id } });
    assert(
      updated.disabledAt === null,
      'classifier failure must not heuristically disable credential'
    );

    const surface = await prisma.message.findFirst({
      where: {
        agentId,
        metadata: {
          path: ['action_type'],
          equals: 'credential_failure_classification',
        },
      },
    });
    assert(surface !== null, 'expected visible raw failure message');
    const metadata = surface.metadata as {
      toolCallId?: string;
      rawError?: string;
      failureReason?: string | null;
    } | null;
    assert(
      metadata?.toolCallId === `credential_failure_classifier:${agentId}`,
      'expected classifier TOOL message to include toolCallId'
    );
    assert(
      metadata?.rawError?.includes('invalid password') === true,
      'expected raw error preserved'
    );
    assert(metadata.failureReason === null, 'expected null failureReason in surface metadata');
  } finally {
    await cleanup(userId);
  }
});

test('domain classifier unavailable decision preserves raw error without failureReason', async () => {
  const decision = classifierUnavailableDecision(
    {
      id: 'agent-domain-classifier-test',
      goal: 'Sign in and check the account page',
      status: 'FAILED',
      statusMessage: 'Login failed: invalid password',
    },
    [{ text: 'Authentication failed after password entry' }]
  );

  assert(
    decision.outcome === 'task_level',
    'expected classifier failure not to disable credentials'
  );
  assert(decision.reason === 'classifier_unavailable', 'expected classifier_unavailable reason');
  assert(decision.failureReason === null, 'expected null failureReason');
  assert(
    decision.rawError?.includes('invalid password') === true,
    'expected raw error preservation'
  );
});

async function main() {
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, passed: true });
      console.log(`PASS ${item.name}`);
    } catch (error) {
      results.push({
        name: item.name,
        passed: false,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
      console.error(`FAIL ${item.name}`);
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }

  await prisma.$disconnect();
  const failed = results.filter((result) => !result.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
