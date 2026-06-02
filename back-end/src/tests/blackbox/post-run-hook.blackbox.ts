#!/usr/bin/env tsx
/* eslint-disable no-console */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  propagateBrowserRunCredentials,
  propagatePostRunCredentials,
} from '../../domains/credential-propagation/service';

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

async function addBrowserCredentialMessage(
  agentId: string,
  taskId: string,
  kind: string,
  id: string,
  text = ''
) {
  await prisma.message.create({
    data: {
      agentId,
      role: 'TOOL',
      text,
      timestamp: new Date(),
      metadata: {
        task_id: taskId,
        subAgentId: taskId,
        credential_ref: { kind, id },
      },
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

test('success run clears disabled fields on referenced cookie bundle', async () => {
  const userId = await createUser();
  try {
    const cookieBundle = await prisma.cookieBundle.create({
      data: {
        userId,
        authRealm: 'example.com',
        browserSource: 'chrome',
        browserProfile: 'Default',
        disabledAt: new Date(),
        disabledReason: 'previous failure',
      },
    });
    const agentId = await createAgent({ userId, status: 'COMPLETED' });
    await addCredentialMessage(agentId, 'cookie_bundle', cookieBundle.id);

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagatePostRunCredentials(agentId);
    });

    const updated = await prisma.cookieBundle.findUniqueOrThrow({ where: { id: cookieBundle.id } });
    assert(updated.disabledAt === null, 'expected disabledAt to be cleared');
    assert(updated.disabledReason === null, 'expected disabledReason to be cleared');
  } finally {
    await cleanup(userId);
  }
});

test('browser-run completion is the synchronous credential propagation trigger', async () => {
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
    const taskId = `browser-${randomUUID()}`;
    await addBrowserCredentialMessage(
      agentId,
      taskId,
      'password',
      password.id,
      'Authentication failed after using the saved credential'
    );

    await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, async () => {
      await propagateBrowserRunCredentials({
        agentId,
        taskId,
        status: 'max_iterations',
        success: false,
        message: 'Login failed: invalid password',
      });
    });

    const updated = await prisma.browserPassword.findUniqueOrThrow({ where: { id: password.id } });
    assert(updated.disabledAt !== null, 'expected browser-run trigger to disable password');
    const marker = await prisma.agentRunCredentialPropagation.findUnique({
      where: { agentId: `${agentId}:browser:${taskId}` },
    });
    assert(marker !== null, 'expected browser-run scoped propagation marker');
  } finally {
    await cleanup(userId);
  }
});

test('browser-run awaiting auth assistance updates credentials without visible failure surface', async () => {
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
    const taskId = `browser-${randomUUID()}`;
    await addBrowserCredentialMessage(
      agentId,
      taskId,
      'password',
      password.id,
      "Authentication failure state reached: yes. The site displayed 'Your password is invalid!' after using the saved credential."
    );

    await withEnv(
      {
        CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
        CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
          reason: 'all automated authentication options were exhausted',
          credentialOutcomes: [
            {
              reason: 'the saved password was rejected by the site before auth assistance',
              kind: 'password',
              id: password.id,
              outcome: 'auth_failed',
            },
          ],
        }),
      },
      async () => {
        await propagateBrowserRunCredentials({
          agentId,
          taskId,
          status: 'awaiting_auth_assistance',
          success: false,
          message: 'Automated authentication options were exhausted; requesting user assistance.',
        });
      }
    );

    const updated = await prisma.browserPassword.findUniqueOrThrow({ where: { id: password.id } });
    assert(updated.disabledAt !== null, 'expected exhausted password to be disabled');
    const surface = await prisma.message.findFirst({
      where: {
        agentId,
        metadata: {
          path: ['action_type'],
          equals: 'credential_failure_classification',
        },
      },
    });
    assert(surface === null, 'auth-assistance pause should not surface as browser failure');
  } finally {
    await cleanup(userId);
  }
});

test('browser-run auth screen after cookie bundle disables referenced cookie bundle', async () => {
  const userId = await createUser();
  try {
    const cookieBundle = await prisma.cookieBundle.create({
      data: {
        userId,
        authRealm: 'amazon.com',
        browserSource: 'chrome',
        browserProfile: 'Default',
      },
    });
    const agentId = await createAgent({ userId, status: 'ACTIVE' });
    const taskId = `browser-${randomUUID()}`;
    await addBrowserCredentialMessage(
      agentId,
      taskId,
      'cookie_bundle',
      cookieBundle.id,
      'Cookie bundle was applied automatically, but checkout returned to /ap/signin and showed an authentication screen.'
    );

    await withEnv(
      {
        CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
        CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
          reason: 'The applied cookie bundle did not authenticate the browser session.',
          credentialOutcomes: [
            {
              reason:
                'The browser landed on an authentication screen after relying on this cookie bundle.',
              kind: 'cookie_bundle',
              id: cookieBundle.id,
              outcome: 'auth_failed',
            },
          ],
        }),
      },
      async () => {
        await propagateBrowserRunCredentials({
          agentId,
          taskId,
          status: 'awaiting_auth_assistance',
          success: false,
          message:
            'Cookie-based authentication was applied but Amazon still required sign-in before checkout.',
        });
      }
    );

    const updated = await prisma.cookieBundle.findUniqueOrThrow({
      where: { id: cookieBundle.id },
    });
    assert(updated.disabledAt !== null, 'expected rejected cookie bundle to be disabled');
    assert(
      updated.disabledReason?.includes('auth_exhausted') === true,
      'expected disabledReason to include auth_exhausted'
    );
  } finally {
    await cleanup(userId);
  }
});

test('browser-run propagation skips classification when no credential was used', async () => {
  const userId = await createUser();
  try {
    const agentId = await createAgent({ userId, status: 'ACTIVE' });
    const taskId = `browser-${randomUUID()}`;
    await prisma.message.create({
      data: {
        agentId,
        role: 'TOOL',
        text: 'Browser navigation failed before any credential was used.',
        timestamp: new Date(),
        metadata: { task_id: taskId, subAgentId: taskId, action_type: 'goto' },
      },
    });

    const result = await propagateBrowserRunCredentials({
      agentId,
      taskId,
      status: 'max_iterations',
      success: false,
      message: 'Max iterations reached before authentication',
    });

    assert(result?.refs === 0, 'expected no credential refs');
    assert(result?.applied === 0, 'expected no applied credential decisions');
    assert(result?.reason === 'no_credentials_used', 'expected no-credential skip reason');
    const marker = await prisma.agentRunCredentialPropagation.findUnique({
      where: { agentId: `${agentId}:browser:${taskId}` },
    });
    assert(marker === null, 'expected no propagation marker when no credential was used');
  } finally {
    await cleanup(userId);
  }
});

test('browser-run classifier applies outcomes per credential ref', async () => {
  const userId = await createUser();
  try {
    const first = await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://example.com',
        username: 'first@example.com',
        encryptedPassword: 'encrypted-1',
        browserSource: 'chrome',
      },
    });
    const second = await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://example.com',
        username: 'second@example.com',
        encryptedPassword: 'encrypted-2',
        browserSource: 'chrome',
      },
    });
    const agentId = await createAgent({ userId, status: 'ACTIVE' });
    const taskId = `browser-${randomUUID()}`;
    await addBrowserCredentialMessage(
      agentId,
      taskId,
      'password',
      first.id,
      'First password was listed but not submitted.'
    );
    await addBrowserCredentialMessage(
      agentId,
      taskId,
      'password',
      second.id,
      'Second password was submitted and rejected.'
    );

    await withEnv(
      {
        CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
        CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
          reason: 'Only the second password was tied to a rejected login submission.',
          credentialOutcomes: [
            {
              reason: 'No clear submission or rejection was tied to this credential.',
              kind: 'password',
              id: first.id,
              outcome: 'unused',
            },
            {
              reason: 'The browser run showed this credential being submitted and rejected.',
              kind: 'password',
              id: second.id,
              outcome: 'auth_failed',
            },
          ],
        }),
      },
      async () => {
        await propagateBrowserRunCredentials({
          agentId,
          taskId,
          status: 'max_iterations',
          success: false,
          message: 'Login failed after password submission',
        });
      }
    );

    const firstUpdated = await prisma.browserPassword.findUniqueOrThrow({
      where: { id: first.id },
    });
    const secondUpdated = await prisma.browserPassword.findUniqueOrThrow({
      where: { id: second.id },
    });
    assert(firstUpdated.disabledAt === null, 'expected unused password to remain enabled');
    assert(secondUpdated.disabledAt !== null, 'expected rejected password to be disabled');
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
