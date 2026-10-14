/** Real output-service + database credential feedback; no sandbox or provider requests. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { persistOutput, type CodexCredentialFeedback } from '../../domains/codex-code/service';
import { withIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';
import { codexSmokeCreditSkipReason } from './codex-credit-skip';

async function main() {
  const userId = randomUUID();
  const sharedWhere = {
    userId: '00000000-0000-0000-0000-000000000000',
    name: 'gpt_api_key_cooldown',
    accountId: '',
  };
  const captured =
    '401 token_revoked\nrefresh_token_invalidated\n[Codex] ChatGPT OAuth unavailable — retrying with funded OpenAI API key\nYou have no credits remaining.';
  const failures: string[] = [];
  try {
    for (const source of ['user', 'pool']) {
      for (const mode of [
        'plain',
        'structured',
        'initial',
        'empty-feedback',
        'quota',
        'funded-only',
      ]) {
        try {
          await prisma.integration.deleteMany({ where: sharedWhere });
          const accountId = randomUUID();
          const selected = await prisma.integration.create({
            data: {
              userId,
              accountId,
              name: 'gpt_code',
              type: 'TOOL_SETUP',
              status: 'CONNECTED',
              isActive: true,
              poolingEnabled: source === 'pool',
            },
          });
          const other = await prisma.integration.create({
            data: {
              userId,
              accountId: randomUUID(),
              name: 'gpt_code',
              type: 'TOOL_SETUP',
              status: 'CONNECTED',
              isActive: true,
            },
          });
          await prisma.computeAccountConnection.createMany({
            data: [selected, other].map((row) => ({
              userId,
              provider: 'codex',
              accountId: row.accountId,
              state: 'connected',
            })),
          });
          const taskId = randomUUID();
          await prisma.claudeCodeSession.create({
            data: {
              id: taskId,
              agentId: randomUUID(),
              sandboxId: `offline-revocation-${taskId}`,
              goal: 'captured credential feedback replay',
              claudeTokenSource: source,
              claudeTokenIntegrationId: selected.id,
            },
          });
          let feedback: CodexCredentialFeedback[] | undefined;
          let output = captured;
          if (mode === 'structured') {
            output = 'Terminal display no longer contains the OAuth failure.';
            feedback = [
              { source: 'oauth', reason: 'usage_limit_reached' },
              { source: 'oauth', reason: 'oauth_refresh_invalid' },
              { source: 'funded_api_key', reason: 'You have no credits remaining.' },
            ];
          } else if (mode === 'initial') {
            output = 'Terminal snapshot';
            feedback = [
              { source: 'initial', reason: 'refresh_token_invalidated' },
              { source: 'funded_api_key', reason: 'no credits remaining' },
            ];
          } else if (mode === 'empty-feedback') feedback = [];
          else if (mode === 'quota') {
            output = 'CODEX_E2B_DONE';
            feedback = [
              { source: 'oauth', reason: 'Quota exceeded. Check your plan and billing details.' },
            ];
          } else if (mode === 'funded-only') {
            output = '401 token_revoked';
            feedback = [{ source: 'funded_api_key', reason: 'token_revoked' }];
          }
          await persistOutput(taskId, output, feedback);
          const actual = await prisma.integration.findUniqueOrThrow({ where: { id: selected.id } });
          const connection = await prisma.computeAccountConnection.findUniqueOrThrow({
            where: { userId_provider_accountId: { userId, provider: 'codex', accountId } },
          });
          if (mode === 'quota') {
            assert.equal(actual.status, 'CONNECTED');
            assert.equal(connection.state, 'connected');
            assert.ok(
              actual.rateLimitedUntil && actual.rateLimitedUntil > new Date(),
              'temporary quota stays a cooldown'
            );
          } else if (mode === 'funded-only') {
            assert.equal(
              actual.status,
              'CONNECTED',
              'funded-key auth errors must not invalidate OAuth'
            );
            assert.equal(connection.state, 'connected');
            assert.equal(actual.rateLimitedUntil, null);
          } else {
            assert.equal(
              actual.status,
              'EXPIRED',
              `${source}/${mode}: captured permanent revocation must expire selected credential`
            );
            assert.equal(actual.isActive, false);
            assert.equal(actual.failureReason, 'auth_error');
            assert.equal(
              actual.rateLimitedUntil,
              null,
              'permanent revocation is not a temporary cooldown'
            );
            assert.equal(connection.state, 'needs_reconnect');
            assert.equal(connection.lastErrorReason, 'auth_error');
            assert.equal(
              codexSmokeCreditSkipReason(captured, []),
              null,
              'revocation remains a hard smoke failure'
            );
            const cooldown = await prisma.integration.findUnique({
              where: { userId_name_accountId: sharedWhere },
            });
            assert.ok(
              cooldown?.rateLimitedUntil && cooldown.rateLimitedUntil > new Date(),
              'funded exhaustion still cools shared key'
            );
          }
          if (mode === 'quota' || mode === 'funded-only') {
            assert.equal(
              await prisma.integration.findUnique({
                where: { userId_name_accountId: sharedWhere },
              }),
              null,
              'no funded quota event means no shared-key cooldown'
            );
          }
          const untouched = await prisma.integration.findUniqueOrThrow({ where: { id: other.id } });
          assert.equal(untouched.status, 'CONNECTED');
          assert.equal(untouched.isActive, true);
          assert.equal(untouched.rateLimitedUntil, null);
          assert.equal(
            (
              await prisma.computeAccountConnection.findUniqueOrThrow({
                where: {
                  userId_provider_accountId: {
                    userId,
                    provider: 'codex',
                    accountId: other.accountId,
                  },
                },
              })
            ).state,
            'connected'
          );
          console.log(`PASS ${source}/${mode}`);
        } catch (error) {
          const failure = `${source}/${mode}: ${String(error)}`;
          failures.push(failure);
          console.error(failure);
        }
      }
    }
    assert.deepEqual(failures, [], 'all credential feedback cases must pass');
  } finally {
    await prisma.claudeCodeSession.deleteMany({
      where: {
        sandboxId: { startsWith: 'offline-revocation-' },
        claudeTokenIntegrationId: {
          in: (await prisma.integration.findMany({ where: { userId }, select: { id: true } })).map(
            (row) => row.id
          ),
        },
      },
    });
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.computeAccountConnection.deleteMany({ where: { userId } });
  }
}
withIsolatedFundedKeyCooldowns(main)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
