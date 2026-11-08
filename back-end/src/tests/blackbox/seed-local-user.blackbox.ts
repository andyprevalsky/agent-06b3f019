#!/usr/bin/env tsx

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  runSyncStep,
  syncUserRecord,
  syncWaitlistAccounts,
  uniqueConflictWhere,
} from '../../../scripts/seed-local-helpers';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function testProductionColumnCompatibility(): Promise<void> {
  const user = {
    id: 'user-row',
    userId: 'seed-user',
    name: 'Seed User',
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: 'United States',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    inviteCode: null,
    inviteCodeUses: 0,
    usedInviteCode: null,
    encryptedPaymentInformation: null,
    phone: null,
    isAnonymous: false,
    onboardingCompletedAt: null,
    imessageBridgeLastSeenAt: null,
    systemName: null,
    profilePicture: null,
    customSystemPrompt: null,
    voicePreferenceId: null,
  };
  let upserted = false;
  const { imessageBridgeLastSeenAt, ...productionUser } = user;
  void imessageBridgeLastSeenAt;
  const remote = {
    findUnique: async (args: { where: { userId: string }; select?: Record<string, boolean> }) => {
      if (!args.select || args.select.imessageBridgeLastSeenAt) {
        throw new Error('The column `User.imessageBridgeLastSeenAt` does not exist');
      }
      return productionUser;
    },
  };
  const local = {
    upsert: async () => {
      upserted = true;
    },
  };

  const count = await syncUserRecord(remote, local, user.userId);

  assert(count === 1, `expected one synced user, got ${count}`);
  assert(upserted, 'expected the production user to be upserted locally');
}

async function testSyncFailureIsFatal(): Promise<void> {
  let rejected = false;
  try {
    await runSyncStep('User', async () => {
      throw new Error('remote schema mismatch');
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('remote schema mismatch');
  }
  assert(rejected, 'expected a failed table sync to reject the overall sync');
}

async function testMissingOptionalUser(): Promise<void> {
  let upserted = false;
  const count = await syncUserRecord(
    { findUnique: async () => null },
    {
      upsert: async () => {
        upserted = true;
      },
    },
    'synthetic-pool-user'
  );

  assert(count === 0, `expected no synced user, got ${count}`);
  assert(!upserted, 'expected no local upsert for a missing optional user');
}

async function testScopedUsersPreserveLocalIdentity(): Promise<void> {
  const existing = {
    id: 'local-user-row',
    userId: 'seed-user',
    phone: '+15555550123',
    usedInviteCode: null,
  };
  const remote = {
    ...existing,
    id: 'remote-user-row',
    usedInviteCode: 42,
  };
  let stored = existing;

  await syncWaitlistAccounts(
    {
      findMany: async () => [remote],
    },
    {
      upsert: async ({ where, create, update }) => {
        if (where.userId !== stored.userId && create.userId === stored.userId) {
          throw new Error('Unique constraint failed on the fields: (`userId`)');
        }
        stored = { ...stored, ...update };
      },
    },
    [remote.phone]
  );

  assert(stored.id === existing.id, 'expected the local primary key to be preserved');
  assert(stored.usedInviteCode === 42, 'expected remote account fields to be refreshed');
}

async function testSingleFieldUniqueConflictUsesScalarWhere(): Promise<void> {
  const phone = '+19729777432';
  const where = uniqueConflictWhere(['phone'], { phone, name: 'Andy' });
  assert(
    where.phone === phone,
    `single-field unique must be a scalar where, got ${JSON.stringify(where)}`
  );
  assert(
    typeof where.phone !== 'object' || where.phone === null,
    'Waitlist.phone P2002 recovery must not wrap the scalar as { phone: { phone } }'
  );

  const compound = uniqueConflictWhere(['userId', 'rpId'], {
    userId: 'user-1',
    rpId: 'rp.example',
  });
  assert(
    JSON.stringify(compound) ===
      JSON.stringify({ userId_rpId: { userId: 'user-1', rpId: 'rp.example' } }),
    `compound unique must keep the joined Prisma where, got ${JSON.stringify(compound)}`
  );
}

function openOrder(mode: 'eager' | 'ordered'): {
  probedAtSecondOpen: boolean;
  probedAfter: boolean;
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SSL_CERT_FILE;
  delete env.SSL_CERT_DIR;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(__dirname, '../fixtures/prisma-open-order.child.ts'), mode],
    { env, encoding: 'utf8', timeout: 60_000 }
  );
  assert(
    child.status === 0,
    `prisma open-order child (${mode}) exited ${child.status}: ${child.stderr}`
  );
  return JSON.parse(child.stdout.trim().split('\n').pop() ?? '');
}

// The seed segfaulted (rc 139) right after its banner: the engine's first TLS connector setenv()s
// SSL_CERT_FILE/SSL_CERT_DIR on an engine thread while a second, already-constructed client read
// process.env on the main thread. The seed now opens its local client only after remote connects.
async function testLocalClientOpensAfterEngineTlsProbe(): Promise<void> {
  if (process.platform !== 'linux') {
    console.log('SKIP prisma open order: the OpenSSL engine probe is Linux-only');
    return;
  }
  const eager = openOrder('eager');
  assert(
    eager.probedAfter,
    'expected the engine to write SSL_CERT_FILE on its first TLS connector'
  );
  assert(
    !eager.probedAtSecondOpen,
    'control: a client constructed before the first connect must precede the engine probe'
  );
  const ordered = openOrder('ordered');
  assert(
    ordered.probedAtSecondOpen,
    'connectThenOpen must construct the second client only after the engine probe has run'
  );
  const seed = readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  assert(
    !/const local = new PrismaClient/.test(seed) &&
      /local = await connectThenOpen\(\s*remote,/.test(seed),
    'seed-local must open its local client through connectThenOpen(remote, ...)'
  );
  assert(
    /async function ensureSeedUserExists\(\): Promise<void> \{\s*await openLocalClient\(\);/.test(
      seed
    ),
    "the seed's first read must open the local client before using it"
  );
}

async function main(): Promise<void> {
  await testLocalClientOpensAfterEngineTlsProbe();
  await testProductionColumnCompatibility();
  await testSyncFailureIsFatal();
  await testMissingOptionalUser();
  await testScopedUsersPreserveLocalIdentity();
  await testSingleFieldUniqueConflictUsesScalarWhere();
  console.log('PASS seed-local user compatibility');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
