#!/usr/bin/env ts-node
/**
 * Clear all blueprints from the database
 * Usage: npm run clear:blueprints
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clearBlueprints() {
  try {
    console.log('🗑️  Clearing all blueprints from database...');
    
    const result = await prisma.goalBlueprint.deleteMany({});
    
    console.log(`✅ Deleted ${result.count} blueprint(s)`);
    
  } catch (error) {
    console.error('❌ Error clearing blueprints:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

clearBlueprints();

