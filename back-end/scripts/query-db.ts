#!/usr/bin/env tsx
/**
 * Reset onboarding flag and integrations for a user
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find Andy Prevalsky (the test user)
  const targetUser = await prisma.user.findFirst({
    where: {
      OR: [
        { name: 'Andy Prevalsky' },
        { phone: { contains: '19729777432' } },
      ],
    },
    select: { userId: true, name: true },
  });

  if (!targetUser) {
    console.log('No user found');
    return;
  }

  console.log(`=== Resetting for user: ${targetUser.userId} (${targetUser.name || 'no name'}) ===`);

  // 1. Reset onboarding flag
  await prisma.user.update({
    where: { userId: targetUser.userId },
    data: { onboardingCompletedAt: null },
  });
  console.log(`✓ Reset onboardingCompletedAt to null`);

  // 2. Delete EmailIntegrationCredentials first (due to foreign key)
  const deletedCreds = await prisma.emailIntegrationCredential.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedCreds.count} EmailIntegrationCredential records`);

  // 3. Delete Integrations
  const deletedIntegrations = await prisma.integration.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedIntegrations.count} Integration records`);

  // 4. Delete BrowserContext and related BrowserSessions (cascade)
  const deletedBrowserContexts = await prisma.browserContext.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedBrowserContexts.count} BrowserContext records`);

  // 5. Delete LocalStorageOrigin
  const deletedLocalStorage = await prisma.localStorageOrigin.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedLocalStorage.count} LocalStorageOrigin records`);

  // 6. Delete IndexedDBOrigin
  const deletedIndexedDB = await prisma.indexedDBOrigin.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedIndexedDB.count} IndexedDBOrigin records`);

  // 7. Delete BrowserPermission
  const deletedPermissions = await prisma.browserPermission.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedPermissions.count} BrowserPermission records`);

  // 8. Delete CacheStorageOrigin
  const deletedCacheStorage = await prisma.cacheStorageOrigin.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedCacheStorage.count} CacheStorageOrigin records`);

  // 9. Delete Cookies
  const deletedCookies = await prisma.cookie.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedCookies.count} Cookie records`);

  // 10. Delete BrowserPassword
  const deletedPasswords = await prisma.browserPassword.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedPasswords.count} BrowserPassword records`);

  // 11. Delete PendingLocalStorageBatch
  const deletedPendingBatches = await prisma.pendingLocalStorageBatch.deleteMany({
    where: { userId: targetUser.userId },
  });
  console.log(`✓ Deleted ${deletedPendingBatches.count} PendingLocalStorageBatch records`);

  // 12. Delete Messages (through agents)
  const userAgents = await prisma.agent.findMany({
    where: { userId: targetUser.userId },
    select: { id: true },
  });
  const agentIds = userAgents.map((a) => a.id);
  const deletedMessages = await prisma.message.deleteMany({
    where: { agentId: { in: agentIds } },
  });
  console.log(`✓ Deleted ${deletedMessages.count} Message records`);

  console.log('\n=== Reset complete ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
