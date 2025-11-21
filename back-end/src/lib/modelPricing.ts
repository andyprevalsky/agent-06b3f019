/**
 * Model pricing helper
 * Fetches and caches model pricing from OpenRouter in Supabase
 * 
 * RULE: All prices are stored as integers (microdollars)
 * Conversion: $0.000001/token * 1,000,000 = 1 microdollar
 */

import { prisma } from './prisma';
import { ROSE_MODEL_POOLS, normalizeRoseAlias } from './roseModels';

interface ModelPricing {
  prompt: string; // Price per token in dollars (e.g., "0.000001")
  completion: string; // Price per token in dollars
}

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt: string;
    completion: string;
  };
}

/**
 * Fetch model pricing - checks Supabase cache first, then OpenRouter API
 */
export async function getModelPricing(modelId: string): Promise<ModelPricing | null> {
  const now = new Date();

  // Check Supabase cache first
  const cached = await prisma.modelPricingCache.findUnique({
    where: { modelId }
  });

  // If cache exists and hasn't expired, use it
  if (cached && cached.expiresAt > now) {
    console.log(`💾 Using cached pricing for ${modelId}`);
    return {
      prompt: (cached.tokenInPriceMicrodollars / 1_000_000).toString(),
      completion: (cached.tokenOutPriceMicrodollars / 1_000_000).toString(),
    };
  }

  // Cache miss or expired - fetch from OpenRouter
  console.log(`🔄 Fetching fresh pricing for ${modelId} from OpenRouter`);
  
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch models from OpenRouter: ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    const models: OpenRouterModel[] = data.data || [];
    
    const normalizedAlias = normalizeRoseAlias(modelId);
    const model = models.find(m => m.id === modelId);
    
    if (normalizedAlias) {
      const pool = ROSE_MODEL_POOLS[normalizedAlias];
      const pricingEntries = pool
        .map(id => models.find(m => m.id === id))
        .filter((m): m is OpenRouterModel & { pricing: { prompt: string; completion: string } } => !!m?.pricing);

      if (pricingEntries.length === 0) {
        console.error(`No pricing found for pool models of alias: ${modelId}`);
        return null;
      }

      const avgPrompt = pricingEntries.reduce((sum, entry) => sum + parseFloat(entry.pricing!.prompt), 0) / pricingEntries.length;
      const avgCompletion = pricingEntries.reduce((sum, entry) => sum + parseFloat(entry.pricing!.completion), 0) / pricingEntries.length;

      const pricing: ModelPricing = {
        prompt: avgPrompt.toString(),
        completion: avgCompletion.toString(),
      };

      await upsertPricing(modelId, pricing, now);
      return pricing;
    }

    if (!model?.pricing) {
      console.error(`No pricing found for model: ${modelId}`);
      return null;
    }

    const pricing: ModelPricing = {
      prompt: model.pricing.prompt,
      completion: model.pricing.completion,
    };

    await upsertPricing(modelId, pricing, now);
    return pricing;
  } catch (error) {
    console.error(`Error fetching model pricing for ${modelId}:`, error);
    return null;
  }
}

/**
 * Convert dollar price per token to microdollars (integer)
 * Example: "$0.000001" -> 1, "$0.000003" -> 3
 */
export function dollarsToMicrodollars(dollarsPerToken: string): number {
  return Math.round(parseFloat(dollarsPerToken) * 1_000_000);
}

async function upsertPricing(modelId: string, pricing: ModelPricing, now: Date) {
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await prisma.modelPricingCache.upsert({
    where: { modelId },
    update: {
      tokenInPriceMicrodollars: dollarsToMicrodollars(pricing.prompt),
      tokenOutPriceMicrodollars: dollarsToMicrodollars(pricing.completion),
      cachedAt: now,
      expiresAt,
    },
    create: {
      modelId,
      tokenInPriceMicrodollars: dollarsToMicrodollars(pricing.prompt),
      tokenOutPriceMicrodollars: dollarsToMicrodollars(pricing.completion),
      cachedAt: now,
      expiresAt,
    },
  });

  console.log(`✅ Cached pricing for ${modelId} (expires in 24h)`);
}

