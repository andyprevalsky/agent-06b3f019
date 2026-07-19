#!/usr/bin/env tsx

import { runSyncStep, syncUserRecord } from '../../../scripts/seed-local-helpers';

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

async function main(): Promise<void> {
  await testProductionColumnCompatibility();
  await testSyncFailureIsFatal();
  await testMissingOptionalUser();
  console.log('PASS seed-local user compatibility');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
