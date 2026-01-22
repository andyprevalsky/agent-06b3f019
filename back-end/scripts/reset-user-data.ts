#!/usr/bin/env tsx
/**
 * Reset user's onboarding, integrations, and cookie data
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const phone = '+19729777432';

  // Find the user
  const user = await prisma.user.findFirst({
    where: { phone },
  });

  if (!user) {
    console.log(`User with phone ${phone} not found`);
    return;
  }

  console.log(`Found user: ${user.id} (${user.phone})`);
  console.log(`Current onboardingCompletedAt: ${user.onboardingCompletedAt}`);

  // 1. Reset onboarding flag
  await prisma.user.update({
    where: { id: user.id },
    data: { onboardingCompletedAt: null },
  });
  console.log('✓ Reset onboardingCompletedAt to null');

  // 2. Delete integrations (and related email credentials via cascade)
  const deletedIntegrations = await prisma.integration.deleteMany({
    where: { userId: user.id },
  });
  console.log(`✓ Deleted ${deletedIntegrations.count} integrations`);

  // 3. Delete cookies
  const deletedCookies = await prisma.cookie.deleteMany({
    where: { userId: user.id },
  });
  console.log(`✓ Deleted ${deletedCookies.count} cookies`);

  // 4. Delete localStorage origins
  const deletedLocalStorage = await prisma.localStorageOrigin.deleteMany({
    where: { userId: user.id },
  });
  console.log(`✓ Deleted ${deletedLocalStorage.count} localStorage origins`);

  // 5. Delete pending localStorage batches
  const deletedBatches = await prisma.pendingLocalStorageBatch.deleteMany({
    where: { userId: user.id },
  });
  console.log(`✓ Deleted ${deletedBatches.count} pending localStorage batches`);

  console.log('\n✅ All data reset successfully!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
