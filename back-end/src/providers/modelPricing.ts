/**
 * Model pricing helper
 * Fetches and caches model pricing from OpenRouter in Supabase
 *
 * RULE: All prices are stored as integers (microdollars)
 * Conversion: $0.000001/token * 1,000,000 = 1 microdollar
 */

import { prisma } from './database';
import { createLogger } from './logger';
import { POOL_REGISTRY, poolForModel } from './rose/pools';

const log = createLogger('ModelPricing');

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

// In-process cache layered in front of the DB cache. Prices change ~daily and
// are read on every agent create; caching here removes one Postgres roundtrip
// per spawn during sub-agent fan-outs.
const memoryCache = new Map<string, { pricing: ModelPricing; expiresAt: number }>();

// The `-openai` suffix means the DIRECT OpenAI API (GPT_API_KEY ->
// api.openai.com), so these are OpenAI's own list prices — NOT OpenRouter's
// `openai/*` rates, which are a different commercial route and genuinely
// cheaper (sol is $2.50/$15 per M on OpenRouter vs $5/$30 direct). Keep these
// independent of `_PROVIDER_PRICING` in agents/providers/rose/pricing.py;
// only the OpenRouter waterfall should track that table.
// Short-context rates only: OpenAI applies a 2x input / 1.5x output multiplier
// above 272k input tokens, which this flat table does not model.
const FIXED_MODEL_PRICING: Record<string, ModelPricing> = {
  // $2.50/$15 per M. The long-standing $1.75/$14 was stale for the direct
  // route too, under-reporting funded API usage by ~30%.
  'gpt-5.4-openai': {
    prompt: (2.5 / 1_000_000).toString(),
    completion: (15.0 / 1_000_000).toString(),
  },
  'gpt-5.5-openai': {
    prompt: (5.0 / 1_000_000).toString(),
    completion: (30.0 / 1_000_000).toString(),
  },
  // Luna and Terra were stale for the direct route too (previously $1/$6 and
  // $2.50/$15). Sol below is the ONLY model in this set whose direct rate
  // genuinely differs from OpenRouter's ($5/$30 vs $2.50/$15); 5.4, 5.5, terra
  // and luna happen to price the same on both routes.
  'gpt-5.6-luna-openai': {
    prompt: (0.2 / 1_000_000).toString(),
    completion: (1.2 / 1_000_000).toString(),
  },
  'gpt-5.6-terra-openai': {
    prompt: (2.0 / 1_000_000).toString(),
    completion: (12.0 / 1_000_000).toString(),
  },
  'gpt-5.6-sol-openai': {
    prompt: (5.0 / 1_000_000).toString(),
    completion: (30.0 / 1_000_000).toString(),
  },
};

/**
 * Fetch model pricing - checks in-process cache, then Supabase cache, then OpenRouter API
 */
export async function getModelPricing(modelId: string): Promise<ModelPricing | null> {
  if (poolForModel(modelId) === 'rose-local' || modelId.toLowerCase().startsWith('local/')) {
    return { prompt: '0', completion: '0' };
  }
  const fixed = FIXED_MODEL_PRICING[modelId.toLowerCase()];
  if (fixed) return fixed;

  const nowMs = Date.now();
  const memHit = memoryCache.get(modelId);
  if (memHit && memHit.expiresAt > nowMs) {
    return memHit.pricing;
  }

  const now = new Date();

  // Check Supabase cache next
  const cached = await prisma.modelPricingCache.findUnique({
    where: { modelId },
  });

  // If cache exists and hasn't expired, use it
  if (cached && cached.expiresAt > now) {
    log.info(`Using cached pricing for ${modelId}`);
    const pricing = {
      prompt: (cached.tokenInPriceMicrodollars / 1_000_000).toString(),
      completion: (cached.tokenOutPriceMicrodollars / 1_000_000).toString(),
    };
    memoryCache.set(modelId, { pricing, expiresAt: cached.expiresAt.getTime() });
    return pricing;
  }

  // Cache miss or expired - fetch from OpenRouter
  log.info(`Fetching fresh pricing for ${modelId} from OpenRouter`);

  /* c8 ignore start -- OpenRouter API fetch depends on external API key and response shape */
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
    });

    if (!response.ok) {
      log.error(`Failed to fetch models from OpenRouter: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { data: OpenRouterModel[] };
    const models: OpenRouterModel[] = data.data || [];

    const poolName = poolForModel(modelId);
    const model = models.find((m) => m.id === modelId);

    if (poolName) {
      const pool = POOL_REGISTRY[poolName].waterfall;
      const pricingEntries = pool
        .map((id) => models.find((m) => m.id === id))
        .filter(
          (m): m is OpenRouterModel & { pricing: { prompt: string; completion: string } } =>
            !!m?.pricing
        );

      if (pricingEntries.length === 0) {
        log.error(`No pricing found for pool models of alias: ${modelId}`);
        return null;
      }

      const avgPrompt =
        pricingEntries.reduce((sum, entry) => sum + parseFloat(entry.pricing!.prompt), 0) /
        pricingEntries.length;
      const avgCompletion =
        pricingEntries.reduce((sum, entry) => sum + parseFloat(entry.pricing!.completion), 0) /
        pricingEntries.length;

      const pricing: ModelPricing = {
        prompt: avgPrompt.toString(),
        completion: avgCompletion.toString(),
      };

      await upsertPricing(modelId, pricing, now);
      return pricing;
    }

    if (!model?.pricing) {
      log.error(`No pricing found for model: ${modelId}`);
      return null;
    }

    const pricing: ModelPricing = {
      prompt: model.pricing.prompt,
      completion: model.pricing.completion,
    };

    await upsertPricing(modelId, pricing, now);
    return pricing;
  } catch (error) {
    log.error(`Error fetching model pricing for ${modelId}`, { error: String(error) });
    return null;
  }
  /* c8 ignore stop */
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

  memoryCache.set(modelId, { pricing, expiresAt: expiresAt.getTime() });
  log.info(`Cached pricing for ${modelId} (expires in 24h)`);
}

/** Test-only: clear the in-process pricing cache. */
export function _clearPricingMemoryCache() {
  memoryCache.clear();
}
