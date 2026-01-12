#!/usr/bin/env tsx
/**
 * Reset onboarding flag for a user
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find users with onboarding completed
  const users = await prisma.user.findMany({
    where: { onboardingCompletedAt: { not: null } },
    select: { id: true, userId: true, name: true, phone: true, onboardingCompletedAt: true },
  });

  console.log('Users with onboarding completed:');
  console.log(JSON.stringify(users, null, 2));

  if (users.length > 0) {
    // Reset the first user's onboarding (or specify which one)
    const targetUser = users[0];
    console.log(`\nResetting onboarding for user: ${targetUser.name || targetUser.userId}`);

    const updated = await prisma.user.update({
      where: { id: targetUser.id },
      data: { onboardingCompletedAt: null },
    });

    console.log('Updated user:');
    console.log(JSON.stringify(updated, null, 2));
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
