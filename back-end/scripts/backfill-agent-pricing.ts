/**
 * Backfill pricing for existing agents
 * Run with: tsx scripts/backfill-agent-pricing.ts
 */

import { PrismaClient } from '@prisma/client';
import { getModelPricing, dollarsToMicrodollars } from '../src/lib/modelPricing';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function backfillPricing() {
  console.log('🔄 Starting agent pricing backfill...\n');

  // Get all agents without pricing
  const agents = await prisma.agent.findMany({
    where: {
      OR: [
        { tokenInPriceMicrodollars: null },
        { tokenOutPriceMicrodollars: null },
      ]
    },
    select: {
      id: true,
      model: true,
      goal: true,
    }
  });

  console.log(`📊 Found ${agents.length} agents without pricing\n`);

  let successCount = 0;
  let failCount = 0;
  const modelPricingCache = new Map<string, { in: number, out: number } | null>();

  for (const agent of agents) {
    // Check cache first
    let cachedPricing = modelPricingCache.get(agent.model);
    
    if (cachedPricing === undefined) {
      // Not in cache, fetch it
      const pricing = await getModelPricing(agent.model);
      
      if (pricing) {
        cachedPricing = {
          in: dollarsToMicrodollars(pricing.prompt),
          out: dollarsToMicrodollars(pricing.completion),
        };
        modelPricingCache.set(agent.model, cachedPricing);
      } else {
        modelPricingCache.set(agent.model, null);
        cachedPricing = null;
      }
    }

    if (cachedPricing) {
      // Update agent with pricing
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          tokenInPriceMicrodollars: cachedPricing.in,
          tokenOutPriceMicrodollars: cachedPricing.out,
        }
      });

      console.log(`✅ ${agent.id.substring(0, 8)} (${agent.model}) - in: ${cachedPricing.in} µ$/token, out: ${cachedPricing.out} µ$/token`);
      successCount++;
    } else {
      console.log(`❌ ${agent.id.substring(0, 8)} (${agent.model}) - pricing not found`);
      failCount++;
    }
  }

  console.log(`\n✅ Backfill complete:`);
  console.log(`   - ${successCount} agents updated`);
  console.log(`   - ${failCount} agents skipped (no pricing available)`);

  await prisma.$disconnect();
}

backfillPricing()
  .catch((error) => {
    console.error('Error during backfill:', error);
    process.exit(1);
  });

