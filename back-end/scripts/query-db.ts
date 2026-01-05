#!/usr/bin/env tsx
/**
 * Example: Query the database directly
 * Usage: npx tsx scripts/query-db.ts
 *
 * Modify the query below as needed for debugging/inspection.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Example: Find blueprints with feedback metadata
  const blueprints = await prisma.goalBlueprint.findMany({
    where: { metadata: { not: null } },
    select: { id: true, title: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  console.log('Results:', JSON.stringify(blueprints, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
