#!/usr/bin/env tsx
/**
 * Enable pooling on Andy's claude_code integration
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find Andy's claude_code integration
  const integration = await prisma.integration.findFirst({
    where: {
      userId: '1f85ff25-6e29-4c1b-8739-f917bd101a30',
      name: 'claude_code',
    },
    select: { id: true, userId: true, status: true, poolingEnabled: true },
  });

  if (!integration) {
    console.log('No claude_code integration found for Andy');
    return;
  }

  console.log(`Found integration: ${integration.id}`);
  console.log(`Current poolingEnabled: ${integration.poolingEnabled}`);

  const updated = await prisma.integration.update({
    where: { id: integration.id },
    data: { poolingEnabled: true },
    select: { id: true, poolingEnabled: true },
  });

  console.log(`Updated poolingEnabled: ${updated.poolingEnabled}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
