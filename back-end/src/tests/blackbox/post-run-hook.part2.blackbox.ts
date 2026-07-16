#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  buildCredentialClassifierSystemPrompt,
  buildCredentialClassifierUserPrompt,
  propagatePostRunCredentials,
} from '../../domains/credential-propagation/service';
import { updateAgentStatus } from '../../domains/agents/agentControlService';

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

test('classifier prompt includes full messages and normalized credential attempts', async () => {
  const credentialRef = { kind: 'password' as const, id: 'password-1' };
  const systemPrompt = buildCredentialClassifierSystemPrompt();
  const userPrompt = buildCredentialClassifierUserPrompt({
    agent: {
      id: 'agent-classifier-prompt-test',
      userId: 'user-classifier-prompt-test',
      goal: 'Sign in and check the account page',
      status: 'FAILED',
      statusMessage: 'Max iterations reached',
    },
    credentialRefs: [credentialRef],
    credentialInventory: [
      {
        ...credentialRef,
        label: 'alice@example.com @ https://example.com/login',
        details: { origin: 'https://example.com/login', username: 'alice@example.com' },
      },
    ],
    messages: [
      {
        role: 'TOOL',
        text: 'first message should be retained',
        timestamp: '2026-01-01T00:00:00.000Z',
        metadata: { action_type: 'goto', title: 'Navigated' },
      },
      {
        role: 'TOOL',
        text: 'middle credential message',
        timestamp: '2026-01-01T00:00:01.000Z',
        metadata: {
          action_type: 'input_text',
          title: 'Typed [encrypted_data] into password',
          credential_ref: credentialRef,
        },
      },
      {
        role: 'ASSISTANT',
        text: 'assistant reasoning should be retained',
        timestamp: '2026-01-01T00:00:01.500Z',
        metadata: { subAgentId: 'browser-task-1' },
      },
      {
        role: 'TOOL',
        text: 'last message should be retained',
        timestamp: '2026-01-01T00:00:02.000Z',
        metadata: { action_type: 'click', title: 'Clicked Sign in' },
      },
    ],
  });

  assert(
    systemPrompt.includes('Expected Input') && systemPrompt.includes('kind=password'),
    'expected system prompt to describe input and password semantics'
  );
  assert(userPrompt.includes('# Task'), 'expected markdown task section');
  assert(userPrompt.includes('# Credential Inventory'), 'expected credential inventory section');
  assert(
    !userPrompt.includes('# Credential Semantics'),
    'expected credential semantics to live in the system prompt only'
  );
  assert(
    !userPrompt.includes('# Credential Usage Timeline'),
    'expected usage timeline section removed'
  );
  assert(
    !userPrompt.includes('# Credential Attempt Summaries'),
    'expected attempt summaries section removed'
  );
  assert(userPrompt.includes('# Full Message Evidence'), 'expected full message evidence section');
  assert(userPrompt.includes('## Message 1'), 'expected first message markdown section');
  assert(userPrompt.includes('## Message 2'), 'expected second message markdown section');
  assert(userPrompt.includes('## Message 3'), 'expected third message markdown section');
  assert(userPrompt.includes('## Message 4'), 'expected fourth message markdown section');
  assert(userPrompt.includes('Role: TOOL'), 'expected role to be explicit per message');
  assert(userPrompt.includes('Role: ASSISTANT'), 'expected assistant reasoning messages retained');
  assert(userPrompt.includes('### Metadata'), 'expected metadata subsection per message');
  assert(
    userPrompt.includes('first message should be retained'),
    'expected first message retained'
  );
  assert(userPrompt.includes('middle credential message'), 'expected credential message retained');
  assert(
    userPrompt.includes('assistant reasoning should be retained'),
    'expected assistant reasoning retained'
  );
  assert(userPrompt.includes('last message should be retained'), 'expected last message retained');
  assert(userPrompt.includes('password-1'), 'expected credential id to be explicit');
  assert(
    userPrompt.includes('alice@example.com @ https://example.com/login'),
    'expected credential label'
  );
});

test('root terminal status update no longer triggers credential propagation', async () => {
  const userId = await createUser();
  try {
    const password = await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://example.com',
        username: 'user@example.com',
        encryptedPassword: 'encrypted',
        browserSource: 'chrome',
      },
    });
    const agentId = await createAgent({ userId, status: 'ACTIVE' });
    await addCredentialMessage(agentId, 'password', password.id, 'Authentication failed');

    await updateAgentStatus(agentId, {
      status: 'FAILED',
      statusMessage: 'Login failed: invalid password',
      progress: 1,
      tokenCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      contextSize: 0,
      messageCount: 1,
    });

    const updated = await prisma.browserPassword.findUniqueOrThrow({ where: { id: password.id } });
    assert(updated.disabledAt === null, 'expected root terminal status not to disable password');
    const marker = await prisma.agentRunCredentialPropagation.findUnique({ where: { agentId } });
    assert(
      marker === null,
      'expected no agent-scoped propagation marker from root terminal status'
    );
  } finally {
    await cleanup(userId);
  }
});

test('root terminal status immediately cleans up unspent purchase cards', async () => {
  const userId = await createUser();
  try {
    const agentId = await createAgent({ userId, status: 'ACTIVE' });
    const cleanedAgentIds: string[] = [];

    await updateAgentStatus(
      agentId,
      {
        status: 'COMPLETED',
        statusMessage: 'Done',
        progress: 1,
        tokenCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        contextSize: 0,
        messageCount: 1,
      },
      {
        cleanupPurchaseCards: async (terminalAgentId) => {
          cleanedAgentIds.push(terminalAgentId);
        },
      }
    );

    assert(
      cleanedAgentIds.length === 1 && cleanedAgentIds[0] === agentId,
      `expected terminal purchase cleanup for ${agentId}, got ${cleanedAgentIds.join(',')}`
    );
  } finally {
    await cleanup(userId);
  }
});

test('auth failure disables referenced password and records raw error', async () => {
  const userId = await createUser();
  try {
    const password = await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://example.com',
        username: 'user@example.com',
        encryptedPassword: 'encrypted',
        browserSource: 'chrome',
      },
    });
    const agentId = await createAgent({
      userId,
      status: 'FAILED',
      statusMessage: 'Login failed: invalid password',
    });
    await addCredentialMessage(agentId, 'password', password.id, 'Authentication failed');

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });

    const updated = await prisma.browserPassword.findUniqueOrThrow({ where: { id: password.id } });
    assert(updated.disabledAt !== null, 'expected password to be disabled');
    assert(
      updated.disabledReason?.includes('invalid password') === true,
      'expected disabledReason to include raw error'
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
    assert(surface !== null, 'expected visible failure classification message');
    const metadata = surface.metadata as { rawError?: string; failureReason?: string } | null;
    assert(
      metadata?.rawError?.includes('invalid password') === true,
      'expected rawError in surface'
    );
    assert(metadata.failureReason === 'auth_exhausted', 'expected failureReason in surface');
  } finally {
    await cleanup(userId);
  }
});

test('completed run with observed credential rejection disables referenced password', async () => {
  const userId = await createUser();
  try {
    const password = await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://practicetestautomation.com/practice-test-login/',
        username: 'student',
        encryptedPassword: 'encrypted',
        browserSource: 'chrome',
      },
    });
    const agentId = await createAgent({
      userId,
      status: 'COMPLETED',
      statusMessage: 'Browser check completed',
    });
    await addCredentialMessage(
      agentId,
      'password',
      password.id,
      "Authentication failure state reached: yes. The site displayed 'Your password is invalid!' after using the saved credential."
    );

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });

    const updated = await prisma.browserPassword.findUniqueOrThrow({ where: { id: password.id } });
    assert(updated.disabledAt !== null, 'expected completed auth rejection to disable password');
    assert(
      updated.disabledReason?.includes('auth_exhausted') === true,
      'expected completed auth rejection disabledReason to include auth_exhausted'
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
    assert(surface !== null, 'expected visible failure classification message');
    const metadata = surface.metadata as {
      failureReason?: string;
      credentialPropagationOutcome?: string;
    } | null;
    assert(metadata?.failureReason === 'auth_exhausted', 'expected auth_exhausted failureReason');
    assert(
      metadata?.credentialPropagationOutcome === 'auth_failed',
      'expected auth_failed credential propagation outcome'
    );
  } finally {
    await cleanup(userId);
  }
});

test('completed run with credential ref and documentation-only invalid password text remains success', async () => {
  const userId = await createUser();
  try {
    const password = await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://example.com',
        username: 'user@example.com',
        encryptedPassword: 'encrypted',
        browserSource: 'chrome',
        disabledAt: new Date(),
        disabledReason: 'previous failure',
      },
    });
    const agentId = await createAgent({ userId, status: 'COMPLETED' });
    await addCredentialMessage(
      agentId,
      'password',
      password.id,
      "The page documentation listed a negative test case: verify error message text is 'Your password is invalid!'. The actual saved-credential login succeeded."
    );

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });

    const updated = await prisma.browserPassword.findUniqueOrThrow({ where: { id: password.id } });
    assert(updated.disabledAt === null, 'expected success run to clear disabledAt');
    assert(updated.disabledReason === null, 'expected success run to clear disabledReason');
  } finally {
    await cleanup(userId);
  }
});

test('auth failure disables Steel auth and resets persistent context', async () => {
  const userId = await createUser();
  try {
    const contextId = `ctx-${randomUUID()}`;
    await prisma.browserContext.create({
      data: { userId, contextId },
    });
    const steelAuth = await prisma.steelSessionAuth.create({
      data: {
        userId,
        contextId,
        authRealm: 'example.com',
      },
    });
    const agentId = await createAgent({
      userId,
      status: 'FAILED',
      statusMessage: 'Authentication failed; session expired and logged out',
    });
    await addCredentialMessage(agentId, 'steel_session', steelAuth.id);

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });

    const updated = await prisma.steelSessionAuth.findUniqueOrThrow({
      where: { id: steelAuth.id },
    });
    const context = await prisma.browserContext.findUniqueOrThrow({ where: { userId } });
    assert(updated.disabledAt !== null, 'expected Steel auth to be disabled');
    assert(context.contextId === null, 'expected persistent Steel profile to reset');
  } finally {
    await cleanup(userId);
  }
});

test('captcha failure records reason without disabling Steel auth', async () => {
  const userId = await createUser();
  try {
    const steelAuth = await prisma.steelSessionAuth.create({
      data: {
        userId,
        contextId: `ctx-${randomUUID()}`,
        authRealm: 'example.com',
      },
    });
    const agentId = await createAgent({
      userId,
      status: 'FAILED',
      statusMessage: 'Blocked by reCAPTCHA challenge',
    });
    await addCredentialMessage(agentId, 'steel_session', steelAuth.id);

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });

    const updated = await prisma.steelSessionAuth.findUniqueOrThrow({
      where: { id: steelAuth.id },
    });
    assert(updated.disabledAt === null, 'expected Steel auth to remain enabled');
    assert(
      updated.disabledReason?.includes('captcha_blocked') === true,
      'expected captcha reason to be recorded'
    );
  } finally {
    await cleanup(userId);
  }
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
