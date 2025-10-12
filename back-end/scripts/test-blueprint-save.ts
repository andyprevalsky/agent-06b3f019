#!/usr/bin/env ts-node
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check existing blueprints
  const existing = await prisma.goalBlueprint.findMany({
    select: {
      id: true,
      title: true,
      embedding: true,
    }
  });
  
  console.log('\n📊 Existing Blueprints:');
  existing.forEach(bp => {
    const hasEmbedding = bp.embedding !== null;
    const embeddingLength = hasEmbedding && Array.isArray(bp.embedding) ? (bp.embedding as any[]).length : 0;
    console.log(`  - "${bp.title}"`);
    console.log(`    Has embedding: ${hasEmbedding ? 'YES ✅' : 'NO ❌'}`);
    if (hasEmbedding) {
      console.log(`    Embedding length: ${embeddingLength}`);
    }
  });
  
  await prisma.$disconnect();
}

main();

