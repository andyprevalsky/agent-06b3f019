import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function showBlueprint() {
  try {
    // Fetch all blueprints
    const blueprints = await prisma.goalBlueprint.findMany({
      orderBy: { createdAt: 'desc' },
    });

    if (blueprints.length === 0) {
      console.log('No blueprints found in database');
      return;
    }

    console.log(`\n📋 Found ${blueprints.length} blueprint(s)\n`);
    console.log('='.repeat(80));

    for (const bp of blueprints) {
      console.log(`\n🎯 Blueprint ID: ${bp.id}`);
      console.log(`   User ID: ${bp.userId}`);
      console.log(`   Title: ${bp.title}`);
      console.log(`   Created: ${bp.createdAt}`);
      console.log(`   Updated: ${bp.updatedAt}`);
      console.log(`   Has Embedding: ${bp.embedding ? 'Yes' : 'No'}`);
      
      console.log('\n📦 Blueprint Data:');
      console.log('-'.repeat(80));
      
      const blueprintData = bp.blueprint as any;
      
      if (typeof blueprintData === 'object' && blueprintData !== null) {
        // Pretty print the blueprint JSON
        console.log(JSON.stringify(blueprintData, null, 2));
      } else {
        console.log(blueprintData);
      }
      
      console.log('\n' + '='.repeat(80));
    }

    console.log('\n✅ Done\n');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

showBlueprint();

