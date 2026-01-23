#!/usr/bin/env tsx
/**
 * Clear integrations table and all related tables, and reset onboarding flag
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Clearing integrations and related tables ===\n');

  // Delete all integrations (cascades to EmailIntegrationCredential)
  const integrations = await prisma.integration.deleteMany({});
  console.log(`Deleted ${integrations.count} integrations`);

  // Delete all browser state tables
  const cookies = await prisma.cookie.deleteMany({});
  console.log(`Deleted ${cookies.count} cookies`);

  const localStorage = await prisma.localStorageOrigin.deleteMany({});
  console.log(`Deleted ${localStorage.count} localStorage origins`);

  const indexedDB = await prisma.indexedDBOrigin.deleteMany({});
  console.log(`Deleted ${indexedDB.count} indexedDB origins`);

  const permissions = await prisma.browserPermission.deleteMany({});
  console.log(`Deleted ${permissions.count} browser permissions`);

  const cacheStorage = await prisma.cacheStorageOrigin.deleteMany({});
  console.log(`Deleted ${cacheStorage.count} cache storage origins`);

  // Delete browser contexts (cascades to BrowserSession)
  const contexts = await prisma.browserContext.deleteMany({});
  console.log(`Deleted ${contexts.count} browser contexts`);

  // Delete pending localStorage batches
  const pendingBatches = await prisma.pendingLocalStorageBatch.deleteMany({});
  console.log(`Deleted ${pendingBatches.count} pending localStorage batches`);

  // Reset onboarding flag for all users
  const users = await prisma.user.updateMany({
    data: { onboardingCompletedAt: null },
  });
  console.log(`\nReset onboarding flag for ${users.count} users`);

  console.log('\n=== Done ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
