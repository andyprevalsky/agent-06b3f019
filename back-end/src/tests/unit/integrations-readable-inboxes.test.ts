import assert from 'node:assert/strict';
import { mock } from 'node:test';

type Query = {
  where: { userId: string; provider?: string; state?: unknown; integration?: unknown };
};
const queries: Query[] = [];
const prisma = {
  integration: {
    findMany: async (query: Query) => {
      queries.push(query);
      return [
        {
          name: 'gmail',
          status: 'CONNECTED',
          emailCredentials: [
            {
              email: `${query.where.userId}@example.test`,
              scopes: [],
              state: 'active',
              lastErrorReason: null,
            },
          ],
        },
      ];
    },
  },
  emailIntegrationCredential: {
    findMany: async (query: Query) => {
      queries.push(query);
      assert.equal(query.where.provider, 'GMAIL');
      assert.deepEqual(query.where.integration, { name: 'gmail', status: 'CONNECTED' });
      assert.deepEqual(query.where.state, { not: 'needs_reconnect' });
      return query.where.userId === 'empty'
        ? []
        : [
            {
              email: `${query.where.userId}@example.test`,
              accessToken: 'private-access',
              refreshToken: 'private-refresh',
            },
          ];
    },
  },
  // No minted inboxes: readableInboxEmails lists only the user's own inboxes.
  mintedAccount: { findMany: async () => [] },
};

async function main() {
  await mock.module('../../providers/database', {
    namedExports: {
      prisma,
      runTransactionWithRetry: async () => {
        throw new Error('unexpected transaction');
      },
    },
  });
  // Actual repository, shared predicate and scope-health modules load together.
  const { findIntegrationsByUser } =
    await import('../../domains/integrations/repo.integrationsList');
  const first = await findIntegrationsByUser('first');
  const other = await findIntegrationsByUser('other');
  const empty = await findIntegrationsByUser('empty');
  assert.deepEqual(first[0].readableInboxEmails, ['first@example.test']);
  assert.deepEqual(other[0].readableInboxEmails, ['other@example.test']);
  assert.deepEqual(empty[0].readableInboxEmails, []);
  assert.equal(queries.length, 6, 'one integration and one selector query per request');
  assert.equal(
    first[0].emailCredentials[0].state,
    'needs_reconnect',
    'per-account scope health remains independent'
  );
  assert(!JSON.stringify(first).includes('private-access'));
  assert(!JSON.stringify(first).includes('private-refresh'));
  assert(!JSON.stringify(first).includes('other@example.test'));
  process.stdout.write('actual integration repo/shared predicate module controls passed\n');
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
