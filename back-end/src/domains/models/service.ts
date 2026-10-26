// eslint-disable-next-line no-restricted-imports -- domain-specific model cache, single consumer
import NodeCache from 'node-cache';
import { POOL_REGISTRY, type PoolName } from '../../providers/rose/pools';
import type { OpenRouterModel, SortedModel } from './types';
import {
  OPENROUTER_API_KEY,
  BACKEND_URL,
  MODEL_CACHE_TTL,
  DEFAULT_CONTEXT_LENGTH,
  FALLBACK_PRICING,
  FEATURED_MODELS,
} from './config';
import { createLogger } from '../../providers/logger';
import { retryWithBackoff } from '../../providers/retry';

const log = createLogger('Models');

// ── Cache ──────────────────────────────────────────────────────────

const modelCache = new NodeCache({ stdTTL: MODEL_CACHE_TTL });
let inflightFetch: Promise<{ models: SortedModel[]; cached: boolean; count?: number }> | null =
  null;

export function clearCache(): void {
  modelCache.del('models');
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Round a per-token price up to the nearest five cents per million tokens.
 */
function roundUpToNearestFiveCents(perTokenPrice: number): number {
  const perMillionPrice = perTokenPrice * 1000000;
  const roundedPerMillion = Math.ceil(perMillionPrice / 0.05) * 0.05;
  return roundedPerMillion / 1000000;
}

/**
 * Calculate average pricing across a model pool from the full model list.
 */
function calculatePoolPricing(pool: readonly string[], allModels: OpenRouterModel[]) {
  let totalPrompt = 0;
  let totalCompletion = 0;
  let validModels = 0;
  let minContextLength = Infinity;

  for (const modelId of pool) {
    const modelInfo = allModels.find((m) => m.id === modelId);

    if (modelInfo !== undefined) {
      const contextLength = modelInfo.top_provider?.context_length ?? modelInfo.context_length;
      if (contextLength !== undefined && contextLength < minContextLength) {
        minContextLength = contextLength;
      }

      if (modelInfo.pricing !== undefined) {
        const promptCost = parseFloat(modelInfo.pricing.prompt ?? '0');
        const completionCost = parseFloat(modelInfo.pricing.completion ?? '0');

        if (Number.isFinite(promptCost) && Number.isFinite(completionCost)) {
          totalPrompt += promptCost;
          totalCompletion += completionCost;
          validModels++;
        }
      }
    }
  }

  return { totalPrompt, totalCompletion, validModels, minContextLength };
}

/**
 * Calculate Rose pricing and context length from model pool.
 */
async function calculateRoseMetadata(modelName: string, allModels: OpenRouterModel[]) {
  try {
    const spec = POOL_REGISTRY[modelName as PoolName];
    if (spec === undefined) {
      throw new Error(`Unknown Rose model: ${modelName}`);
    }
    const pool = spec.waterfall;

    const { totalPrompt, totalCompletion, validModels, minContextLength } = calculatePoolPricing(
      pool,
      allModels
    );

    if (validModels === 0) {
      throw new Error('No pricing information available for models in pool');
    }

    const avgPrompt = totalPrompt / validModels;
    const avgCompletion = totalCompletion / validModels;

    return {
      pricing: {
        prompt: roundUpToNearestFiveCents(avgPrompt).toString(),
        completion: roundUpToNearestFiveCents(avgCompletion).toString(),
      },
      contextLength: minContextLength === Infinity ? DEFAULT_CONTEXT_LENGTH : minContextLength,
    };
  } catch (error) {
    log.error(`Error calculating ${modelName} metadata`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      pricing: {
        prompt: FALLBACK_PRICING.prompt,
        completion: FALLBACK_PRICING.completion,
      },
      contextLength: DEFAULT_CONTEXT_LENGTH,
    };
  }
}

/**
 * Transform OpenRouterModel list into SortedModel list.
 */
function transformModels(models: OpenRouterModel[]): SortedModel[] {
  return models.map((model) => {
    const parts = model.id.split('/');
    const provider = parts[0] !== undefined && parts[0] !== '' ? parts[0] : 'unknown';
    const name = parts.slice(1).join('/') !== '' ? parts.slice(1).join('/') : model.id;

    return {
      id: model.id,
      name: name,
      provider: provider,
      description: model.description,
      contextLength: model.top_provider?.context_length ?? model.context_length,
      pricing: model.pricing,
    };
  });
}

/**
 * Sort models: Featured first (exact order), then rest alphabetically.
 */
function sortModels(models: OpenRouterModel[]): SortedModel[] {
  const transformed = transformModels(models);

  const featured: SortedModel[] = [];
  const others: SortedModel[] = [];

  for (const model of transformed) {
    const featuredIndex = FEATURED_MODELS.indexOf(model.id);
    if (featuredIndex !== -1) {
      featured.push(model);
    } else {
      others.push(model);
    }
  }

  featured.sort((a, b) => {
    const aIndex = FEATURED_MODELS.indexOf(a.id);
    const bIndex = FEATURED_MODELS.indexOf(b.id);
    return aIndex - bIndex;
  });

  others.sort((a, b) => {
    if (a.provider !== b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    return a.name.localeCompare(b.name);
  });

  return [...featured, ...others];
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Build the list of Rose synthetic models to inject at the top of the model list.
 */
async function buildRoseModels(allModels: OpenRouterModel[]): Promise<SortedModel[]> {
  const roseFastMetadata = await calculateRoseMetadata('rose-1-flash', allModels);
  const roseUltraMetadata = await calculateRoseMetadata('rose-1-ultra', allModels);

  return [
    {
      id: 'rose-labs/rose-1-flash',
      name: 'rose-fast',
      provider: 'rose-labs',
      description:
        'Rose-fast: Cerebras Qwen 3.8 27B for execute and browser, OpenRouter Qwen then Gemini 3.8 Flash fallback. Planner stays Ultra.',
      contextLength: roseFastMetadata.contextLength,
      pricing: roseFastMetadata.pricing,
    },
    {
      id: 'rose-labs/rose-1-ultra',
      name: 'rose-1-ultra',
      provider: 'rose-labs',
      description: 'Rose Labs ultra model for complex tasks (> 6s avg)',
      contextLength: roseUltraMetadata.contextLength,
      pricing: roseUltraMetadata.pricing,
    },
    {
      id: 'rose-labs/rose-local',
      name: 'rose-local',
      provider: 'rose-labs',
      description:
        'Local model inference on the configured Rose worker. No model API fees. Agent data still uses Rose cloud services. Speed and throughput depend on hardware; benchmarks pending.',
      contextLength: DEFAULT_CONTEXT_LENGTH,
      pricing: { prompt: '0', completion: '0' },
    },
  ];
}

/**
 * Fetch, filter, sort, and cache available models.
 * Returns `{ models, cached, count? }`.
 *
 * Uses request deduplication to prevent cache stampede: when the cache is cold,
 * only one fetch goes to OpenRouter while concurrent callers await the same promise.
 */
export async function listModels(): Promise<{
  models: SortedModel[];
  cached: boolean;
  count?: number;
}> {
  const cached = modelCache.get<SortedModel[]>('models');
  if (cached !== undefined) {
    return { models: cached, cached: true };
  }

  if (inflightFetch !== null) {
    return inflightFetch;
  }

  inflightFetch = fetchAndCacheModels();
  try {
    return await inflightFetch;
  } finally {
    inflightFetch = null;
  }
}

async function fetchAndCacheModels(): Promise<{
  models: SortedModel[];
  cached: boolean;
  count?: number;
}> {
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': BACKEND_URL,
          'X-Title': 'Rose AI Agent',
        },
      });
      if (!res.ok) {
        throw new Error(`OpenRouter API returned ${res.status}: ${res.statusText}`);
      }
      return res;
    },
    { maxRetries: 3, component: 'Models' }
  );

  const data = (await response.json()) as { data?: OpenRouterModel[] };
  const allModels: OpenRouterModel[] = data.data ?? [];

  const toolSupportedModels = allModels.filter(
    (model) => model.supported_parameters?.includes('tools') === true
  );

  const sortedModels = sortModels(toolSupportedModels);
  const roseModels = await buildRoseModels(allModels);
  const finalModels = [...roseModels, ...sortedModels];

  modelCache.set('models', finalModels);

  return { models: finalModels, cached: false, count: finalModels.length };
}
