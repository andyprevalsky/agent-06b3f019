import { prisma } from '../../providers/database';

const COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';
const COOLDOWN_NAME = 'gpt_api_key_cooldown';

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
      'successful funded fallback must not cool the healthy shared key'
    );
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: taskId } });
    await prisma.integration.deleteMany({ where: { id: integration.id } });
    await prisma.integration.deleteMany({
      where: { userId: COOLDOWN_USER_ID, name: COOLDOWN_NAME },
    });
  }
}
