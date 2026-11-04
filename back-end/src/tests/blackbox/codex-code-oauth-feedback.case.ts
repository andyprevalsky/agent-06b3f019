import { prisma } from '../../providers/database';

const COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';
// The funded Codex path is the Azure deployment; its backoff row is codex_funded_cooldown.
const COOLDOWN_NAME = 'codex_funded_cooldown';
// The shared OpenAI key gates the Rose chat path and never funds a Codex sandbox.
const OPENAI_KEY_COOLDOWN_NAME = 'gpt_api_key_cooldown';

/** The shared OpenAI-key cooldown end, to prove Codex feedback never touches it. */
async function openAiKeyCooldownUntil(): Promise<number | null> {
  const row = await prisma.integration.findUnique({
    where: {
      userId_name_accountId: {
        userId: COOLDOWN_USER_ID,
        name: OPENAI_KEY_COOLDOWN_NAME,
        accountId: '',
      },
    },
    select: { rateLimitedUntil: true },
  });
  return row?.rateLimitedUntil?.getTime() ?? null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

export async function testPersistOutput_coolsExhaustedOAuthCredential() {
  await prisma.integration.deleteMany({
    where: { userId: COOLDOWN_USER_ID, name: COOLDOWN_NAME },
  });
  const integration = await prisma.integration.create({
    data: {
      userId: crypto.randomUUID(),
      name: 'gpt_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  const taskId = crypto.randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId: crypto.randomUUID(),
      sandboxId: `codex-exhaustion-${taskId}`,
      goal: 'captured long Codex fallback replay',
      status: 'ACTIVE',
      claudeTokenSource: 'user',
      claudeTokenIntegrationId: integration.id,
    },
  });

  try {
    const output =
      Array.from({ length: 650 }, (_, index) => `normal fallback output ${index}`).join('\n') +
      '\nCODEX_E2B_DONE\n';
    const response = await fetch(
      `${process.env.TEST_BASE_URL || 'http://localhost:3001'}/api/codex-code-session/${taskId}/output`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.BACKEND_API_KEY || '',
        },
        body: JSON.stringify({
          output,
          credential_feedback: [
            {
              source: 'oauth',
              reason: 'Quota exceeded. Check your plan and billing details.',
            },
          ],
        }),
      }
    );
    const body = await response.text();
    assert(response.status === 200, `expected HTTP 200, got ${response.status}: ${body}`);

    const persisted = await prisma.integration.findUnique({ where: { id: integration.id } });
    assert(
      persisted?.rateLimitedUntil instanceof Date &&
        persisted.rateLimitedUntil.getTime() > Date.now(),
      'structured feedback must cool the exact OAuth integration after terminal truncation'
    );
    const fundedKeyCooldown = await prisma.integration.findUnique({
      where: {
        userId_name_accountId: { userId: COOLDOWN_USER_ID, name: COOLDOWN_NAME, accountId: '' },
      },
    });
    assert(
      fundedKeyCooldown === null,
      'successful funded fallback must not back off the healthy Azure deployment'
    );
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: taskId } });
    await prisma.integration.deleteMany({ where: { id: integration.id } });
    await prisma.integration.deleteMany({
      where: { userId: COOLDOWN_USER_ID, name: COOLDOWN_NAME },
    });
  }
}

export async function testPersistOutput_coolsFundedKeyForObservedBalanceError() {
  const { persistOutput } = await import('../../domains/codex-code/service');
  const { codexSmokeCreditSkipReason } = await import('./codex-credit-skip');
  const taskId = crypto.randomUUID();
  const output =
    '[Codex] Error: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';
  await prisma.integration.deleteMany({ where: { userId: COOLDOWN_USER_ID, name: COOLDOWN_NAME } });
  const openAiKeyBefore = await openAiKeyCooldownUntil();
  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId: crypto.randomUUID(),
      sandboxId: `codex-balance-${taskId}`,
      goal: 'captured funded API balance failure',
      status: 'ACTIVE',
    },
  });
  try {
    await persistOutput(taskId, output);
    const cooldown = await prisma.integration.findFirst({
      where: { userId: COOLDOWN_USER_ID, name: COOLDOWN_NAME },
    });
    assert(
      cooldown?.rateLimitedUntil && cooldown.rateLimitedUntil.getTime() > Date.now(),
      'observed no-credits API response must back off the funded Azure deployment'
    );
    assert(
      (await openAiKeyCooldownUntil()) === openAiKeyBefore,
      'funded Codex exhaustion must not cool the shared OpenAI key (Rose chat path)'
    );
    assert(
      codexSmokeCreditSkipReason(output, []) !== null,
      'funded-only exhaustion qualifies for skip'
    );
    assert(
      codexSmokeCreditSkipReason('auth error code: token_revoked\n' + output, []) === null,
      'captured OAuth revocation plus API exhaustion must remain a hard failure'
    );
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: taskId } });
    await prisma.integration.deleteMany({
      where: { userId: COOLDOWN_USER_ID, name: COOLDOWN_NAME },
    });
  }
}
