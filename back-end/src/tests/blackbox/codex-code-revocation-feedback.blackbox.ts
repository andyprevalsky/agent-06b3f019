/** Real output-service + database credential feedback; no sandbox or provider requests. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { persistOutput, type CodexCredentialFeedback } from '../../domains/codex-code/service';
import { withIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';
import { codexQuotaCollisions } from './codex-quota-dialects.support';
import { codexSmokeCreditSkipReason } from './codex-credit-skip';

async function historicalOutput(): Promise<string> {
  const raw = JSON.parse(
    await readFile('.context/pr1520-cycle1-draft/historical-output.private.json', 'utf8')
  ) as { output: string };
  assert.equal(
    createHash('sha256').update(raw.output).digest('hex'),
    'b3321937f08d255920ee5f86378548b7e1c9614e13ec66c2a459b9113368406e'
  );
  return raw.output;
}

async function main() {
  const userId = randomUUID();
  // The funded Codex path is the Azure deployment: its backoff row, not the OpenAI key's.
  const sharedWhere = {
    userId: '00000000-0000-0000-0000-000000000000',
    name: 'codex_funded_cooldown',
    accountId: '',
  };
  const captured =
    '[Codex] Error: 401 token_revoked\n[Codex] Turn failed: refresh_token_invalidated\n[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n[Codex] Error: You have no credits remaining.';
  const quotaCollisions = new Map(
    codexQuotaCollisions().flatMap(({ label, reason }) =>
      [false, true].map(
        (structured) =>
          [`collision-${label}-structured-${structured}`, { reason, structured }] as const
      )
    )
  );
  const failures: string[] = [];
  const taskIds: string[] = [];
  try {
    for (const source of ['user', 'pool']) {
      for (const mode of [
        ...quotaCollisions.keys(),
        'plain',
        'structured',
        'initial',
        'empty-feedback',
        'quota',
        'funded-only',
        'turn-failed',
        'bare-refresh',
        'structured-reversed',
        'unknown-auth',
        'google-auth',
        'application-auth',
        'command-auth',
        'agent-prose',
        'quota-auth',
        'structured-prose',
        'multiline-error',
        'multiline-turn',
        'multiline-refresh',
        'multiline-unrelated',
        'multiline-command',
        'oauth-printed-quota',
        'funded-legacy-printed',
        'funded-legacy-quota',
        'funded-legacy-native',
        'fallback-printed-funding',
        'quota-reset',
        'structured-multiline',
        'historical',
        'command-fallback-routing',
        'same-error-quota-revoked',
        'structured-same-error',
        'same-error-phrase',
        'structured-same-phrase',
        'same-block-quota-revoked',
        'distinct-block-quota-revoked',
        'native-payment-parity',
        'structured-payment-parity',
        'funded-legacy-payment',
        'native-invalid-grant',
        'native-disk-quota',
        'native-rate-quota',
        'native-bare-quota',
      ].filter((mode) => mode !== 'historical' || process.argv.includes('--historical'))) {
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
          taskIds.push(taskId);
          await prisma.claudeCodeSession.create({
            data: {
              id: taskId,
              agentId: randomUUID(),
              sandboxId: `offline-revocation-${taskId}`,
              goal: 'captured credential feedback replay',
              claudeTokenSource: source,
              claudeTokenIntegrationId: mode.startsWith('funded-legacy-') ? null : selected.id,
            },
          });
          let feedback: CodexCredentialFeedback[] | undefined;
          let output = captured;
          if (mode === 'structured') {
            output = 'Terminal display no longer contains the OAuth failure.';
            feedback = [
              { source: 'oauth', reason: 'usage_limit_reached' },
              { source: 'oauth', reason: 'oauth_refresh_invalid' },
              {
                source: 'funded_api_key',
                reason: 'You have no credits remaining.',
              },
            ];
          } else if (mode === 'initial') {
            output = 'Terminal snapshot';
            feedback = [
              { source: 'initial', reason: 'refresh_token_invalidated' },
              { source: 'funded_api_key', reason: 'no credits remaining' },
            ];
          } else if (mode === 'empty-feedback') feedback = [];
          else if (mode === 'structured-prose') {
            output = '[Codex] Error: invalid_grant';
            feedback = [];
          } else if (mode === 'quota') {
            output = 'CODEX_E2B_DONE';
            feedback = [
              {
                source: 'oauth',
                reason: 'Quota exceeded. Check your plan and billing details.',
              },
            ];
          } else if (mode === 'funded-only') {
            output = '401 token_revoked';
            feedback = [{ source: 'funded_api_key', reason: 'token_revoked' }];
          }
          if (mode === 'turn-failed') output = '[Codex] Turn failed: refresh_token_invalidated';
          else if (mode === 'bare-refresh') output = 'oauth_refresh_invalid';
          else if (mode === 'structured-reversed') {
            output = 'Terminal snapshot';
            feedback = [
              { source: 'oauth', reason: 'oauth_refresh_invalid' },
              { source: 'oauth', reason: 'usage_limit_reached' },
            ];
          } else if (mode === 'unknown-auth')
            output = 'Example invalid_grant: your session has ended';
          else if (mode === 'google-auth') output = 'Google OAuth refresh failed: invalid_grant';
          else if (mode === 'application-auth') output = 'HTTP401 token_revoked';
          else if (mode === 'command-auth') {
            output =
              '[Codex command output]\nHTTP401 token_revoked\n[Codex] Error: invalid_grant\n[Codex exit_code] 1';
          } else if (mode === 'agent-prose')
            output = '[Codex] Investigated invalid_grant and HTTP401 token_revoked';
          else if (mode === 'quota-auth')
            output =
              '[Codex] Error: usage_limit_reached\n[application] Google OAuth refresh failed: invalid_grant';
          if (mode === 'multiline-error')
            output = '[Codex] Error: OAuth request rejected\n{\n  "error": "invalid_grant"\n}';
          else if (mode === 'multiline-turn')
            output = '[Codex] Turn failed: OAuth request rejected\ninvalid_grant';
          else if (mode === 'multiline-refresh')
            output =
              '2026-10-15T00:00:00Z ERROR codex_login::auth: Failed to refresh token\n{ "error": "invalid_grant" }';
          else if (mode === 'multiline-unrelated')
            output =
              '[Codex] Error: connection failed\n[application] OAuth invalid_grant\n  token_revoked';
          else if (mode === 'multiline-command')
            output =
              '[Codex command output]\n[Codex] Error: OAuth request rejected\n{ "error": "invalid_grant" }\n[Codex exit_code] 1';
          else if (mode === 'oauth-printed-quota')
            output = '[Codex command output]\nusage_limit_reached\n[Codex exit_code] 0';
          else if (mode === 'funded-legacy-printed')
            output =
              '[Codex command output]\n[Codex] Error: no credits remaining\n[Codex exit_code] 0';
          else if (mode === 'funded-legacy-quota')
            output = '[Codex] I read the logs\nno credits remaining\nusage_limit_reached';
          else if (mode === 'funded-legacy-native')
            output = '[Codex] Error: provider rejected request\n{ "error": "insufficient_quota" }';
          else if (mode === 'fallback-printed-funding')
            output =
              '[Codex] Error: token_revoked\n[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n[Codex command output]\nno credits remaining\n[Codex exit_code] 0';
          else if (mode === 'quota-reset')
            output = '[Codex] Error: usage_limit_reached\n  try again at Oct 16th, 2099 1:00 AM';
          else if (mode === 'structured-multiline') {
            output = 'Terminal snapshot';
            feedback = [{ source: 'oauth', reason: 'OAuth failed\n{ "error": "invalid_grant" }' }];
          } else if (mode === 'historical') output = await historicalOutput();
          if (mode === 'command-fallback-routing')
            output =
              '[Codex command output]\n[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n[Codex exit_code] 0\n[Codex] Error: usage_limit_reached';
          else if (mode === 'same-error-quota-revoked')
            output = '[Codex] Error: usage_limit_reached invalid_grant';
          else if (mode === 'structured-same-error') {
            feedback = [{ source: 'oauth', reason: 'usage_limit_reached token_revoked' }];
          }
          if (mode === 'same-error-phrase')
            output = '[Codex] Error: usage_limit_reached OAuth access token has been revoked';
          else if (mode === 'structured-same-phrase') {
            feedback = [
              {
                source: 'oauth',
                reason: 'OAuth access token has been revoked; usage_limit_reached',
              },
            ];
          }
          if (mode === 'same-block-quota-revoked')
            output = '[Codex] Error: usage_limit_reached\n{ "error": "invalid_grant" }';
          else if (mode === 'distinct-block-quota-revoked')
            output = '[Codex] Error: usage_limit_reached\n[Codex] Error: invalid_grant';
          if (mode === 'native-payment-parity' || mode === 'funded-legacy-payment')
            output = '[Codex] Error: invalid_grant; out of credits';
          else if (mode === 'structured-payment-parity')
            feedback = [{ source: 'oauth', reason: 'invalid_grant; out of credits' }];
          if (mode === 'native-invalid-grant') output = '[Codex] Error: invalid_grant';
          else if (mode === 'native-disk-quota') output = '[Codex] Error: disk quota exceeded';
          else if (mode === 'native-rate-quota') output = '[Codex] Error: rate quota exceeded';
          else if (mode === 'native-bare-quota') output = '[Codex] Error: quota';
          const collision = quotaCollisions.get(mode);
          if (collision) {
            output = `[Codex] Error: ${collision.reason}`;
            feedback = collision.structured
              ? [{ source: 'oauth', reason: collision.reason }]
              : undefined;
          }
          const healthy = [
            'funded-only',
            'empty-feedback',
            'structured-prose',
            'unknown-auth',
            'google-auth',
            'application-auth',
            'command-auth',
            'agent-prose',
            'multiline-unrelated',
            'multiline-command',
            'oauth-printed-quota',
            'funded-legacy-printed',
            'funded-legacy-quota',
            'funded-legacy-native',
            'funded-legacy-payment',
            'native-disk-quota',
            'native-rate-quota',
            'native-bare-quota',
          ].includes(mode);
          const quota =
            collision !== undefined ||
            mode === 'quota' ||
            mode === 'quota-auth' ||
            mode === 'quota-reset' ||
            mode === 'command-fallback-routing' ||
            [
              'same-error-quota-revoked',
              'structured-same-error',
              'same-error-phrase',
              'structured-same-phrase',
              'same-block-quota-revoked',
              'native-payment-parity',
              'structured-payment-parity',
            ].includes(mode);
          const funded = [
            'plain',
            'structured',
            'initial',
            'funded-legacy-native',
            'historical',
            'funded-legacy-payment',
          ].includes(mode);
          await persistOutput(taskId, output, feedback);
          const actual = await prisma.integration.findUniqueOrThrow({
            where: { id: selected.id },
          });
          const connection = await prisma.computeAccountConnection.findUniqueOrThrow({
            where: {
              userId_provider_accountId: {
                userId,
                provider: 'codex',
                accountId,
              },
            },
          });
          if (quota) {
            assert.equal(actual.status, 'CONNECTED');
            assert.equal(connection.state, 'connected');
            assert.ok(
              actual.rateLimitedUntil && actual.rateLimitedUntil > new Date(),
              'temporary quota stays a cooldown'
            );
          } else if (healthy) {
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
          }
          if (funded) {
            const cooldown = await prisma.integration.findUnique({
              where: { userId_name_accountId: sharedWhere },
            });
            assert.ok(
              cooldown?.rateLimitedUntil && cooldown.rateLimitedUntil > new Date(),
              'funded exhaustion backs off the Azure Codex deployment'
            );
          }
          if (!funded) {
            assert.equal(
              await prisma.integration.findUnique({
                where: { userId_name_accountId: sharedWhere },
              }),
              null,
              'no funded quota event means no Azure Codex backoff'
            );
          }
          if (mode === 'quota-reset')
            assert.equal(actual.rateLimitedUntil?.toISOString(), '2099-10-16T01:00:00.000Z');
          if (healthy || quota) {
            assert.equal(actual.isActive, true);
            assert.equal(actual.failureReason, null);
            assert.equal(connection.lastErrorReason, null);
          }
          const untouched = await prisma.integration.findUniqueOrThrow({
            where: { id: other.id },
          });
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
    await prisma.claudeCodeSession.deleteMany({ where: { id: { in: taskIds } } });
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
