/**
 * Clear Rose model pricing cache to force recalculation with new pool composition
 * Run with: npx tsx scripts/clear-rose-pricing-cache.ts
 */

import { prisma } from '../src/lib/prisma';

async function clearRosePricingCache() {
  console.log('🧹 Clearing Rose model pricing cache...\n');

  try {
    // Delete cache entries for rose-labs aliases
    const deleted = await prisma.modelPricingCache.deleteMany({
      where: {
        modelId: {
          in: [
            'rose-labs/rose-1-lite',
            'rose-labs/rose-1-ultra',
            'rose-1-lite',
            'rose-1-ultra',
          ]
        }
      }
    });

    console.log(`✅ Deleted ${deleted.count} cache entries`);
    console.log('');
    console.log('Cache cleared for:');
    console.log('  • rose-labs/rose-1-lite');
    console.log('  • rose-labs/rose-1-ultra');
    console.log('  • rose-1-lite');
    console.log('  • rose-1-ultra');
    console.log('');
    console.log('Next time these models are used, pricing will be recalculated');
    console.log('from the updated model pools in roseModels.ts');

  } catch (error) {
    console.error('❌ Error clearing cache:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

clearRosePricingCache();

