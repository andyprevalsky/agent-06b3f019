#!/usr/bin/env ts-node
/**
 * Clear all blueprints from the database
 * Usage: npm run clear:blueprints
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function clearBlueprints() {
  try {
    console.log('🗑️  Clearing blueprints without feedback from database...');

    const result = await prisma.goalBlueprint.deleteMany({
      where: {
        metadata: { equals: Prisma.DbNull },
      },
    });

    console.log(`✅ Deleted ${result.count} blueprint(s) (preserved blueprints with feedback)`);
    
  } catch (error) {
    console.error('❌ Error clearing blueprints:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

clearBlueprints();

