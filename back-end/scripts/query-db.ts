#!/usr/bin/env tsx
/**
 * Query for users with Claude integrations
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find integrations with claude_code
  const integrations = await prisma.integration.findMany({
    where: { name: 'claude_code' },
    select: {
      id: true,
      userId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    take: 10,
  });

  console.log(`Found ${integrations.length} claude_code integrations:`);
  for (const i of integrations) {
    console.log(`  id=${i.id} user=${i.userId} status=${i.status} updated=${i.updatedAt}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
