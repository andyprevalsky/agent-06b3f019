/**
 * Test Rose pricing calculation with new pools
 * Run with: npx tsx scripts/test-rose-pricing.ts
 */

import { getModelPricing } from '../src/lib/modelPricing';

async function testRosePricing() {
  console.log('🧪 Testing Rose model pricing with new pools...\n');

  const models = [
    'rose-labs/rose-1-lite',
    'rose-labs/rose-1-ultra',
  ];

  for (const modelId of models) {
    console.log(`Testing: ${modelId}`);
    try {
      const pricing = await getModelPricing(modelId);
      if (pricing) {
        console.log(`  ✅ Prompt: $${pricing.prompt}/token`);
        console.log(`  ✅ Completion: $${pricing.completion}/token`);
        console.log('');
      } else {
        console.log(`  ❌ No pricing found`);
        console.log('');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
      console.log('');
    }
  }

  console.log('Note: Backend server must be running for this test');
  console.log('Or the OPENROUTER_API_KEY must be in .env');
}

testRosePricing();
