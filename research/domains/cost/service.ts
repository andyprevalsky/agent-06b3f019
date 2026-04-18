/**
 * Cost domain service: business logic.
 *
 * Layer: service
 * May import from: own types, own config, own repo.
 */

import {
  DEFAULT_MIN_CONTEXT,
  FIXED_PRICING,
  MODEL_POOLS,
  PRICE_ROUNDING_STEP_USD,
} from './config.ts';
import { type FetchFn, fetchOpenRouterModels } from './repo.ts';
import type { AggregatedPricing, CostResponse, OpenRouterModel } from './types.ts';

/** Typed error surface for the service layer. */
export class CostError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CostError';
  }
}

/** Parse and normalize a model name from the request URL query string. */
export function parseModelName(url: URL): string | null {
  const raw = url.searchParams.get('model');
  if (!raw) return null;
  let name = raw.toLowerCase();
  if (name.startsWith('rose-labs/')) {
    name = name.replace('rose-labs/', '');
  }
  return name;
}

/** Round a per-token price up to the nearest $0.05 per million tokens. */
export function roundUpToNearestFiveCents(perTokenPrice: number): number {
  const perMillionPrice = perTokenPrice * 1_000_000;
  return Math.ceil(perMillionPrice / PRICE_ROUNDING_STEP_USD) * PRICE_ROUNDING_STEP_USD;
}

/** Accumulator for pool pricing aggregation. */
interface PoolAccumulator {
  totalPrompt: number;
  totalCompletion: number;
  validModels: number;
  minContext: number;
}

/** Fold a single model (fixed pricing) into the accumulator. */
function accumulateFixedModel(
  acc: PoolAccumulator,
  modelId: string,
): boolean {
  const fixed = FIXED_PRICING[modelId];
  if (!fixed) return false;
  if (fixed.contextLength < acc.minContext) acc.minContext = fixed.contextLength;
  acc.totalPrompt += fixed.prompt;
  acc.totalCompletion += fixed.completion;
  acc.validModels++;
  return true;
}

/** Fold a single model (OpenRouter catalog entry) into the accumulator. */
function accumulateCatalogModel(
  acc: PoolAccumulator,
  modelId: string,
  catalog: OpenRouterModel[],
): void {
  const info = catalog.find((m) => m.id === modelId);
  if (!info) return;

  const ctx = info.top_provider?.context_length ?? info.context_length;
  if (ctx !== undefined && ctx < acc.minContext) acc.minContext = ctx;

  if (info.pricing) {
    const promptPrice = parseFloat(info.pricing.prompt ?? '0');
    const completionPrice = parseFloat(info.pricing.completion ?? '0');
    acc.totalPrompt += Number.isFinite(promptPrice) ? promptPrice : 0;
    acc.totalCompletion += Number.isFinite(completionPrice) ? completionPrice : 0;
    acc.validModels++;
  }
}

/** Aggregate pricing across a model pool, blending fixed and OpenRouter prices. */
export function aggregatePricing(
  pool: string[],
  catalog: OpenRouterModel[],
): AggregatedPricing | null {
  const acc: PoolAccumulator = {
    totalPrompt: 0,
    totalCompletion: 0,
    validModels: 0,
    minContext: Infinity,
  };

  for (const modelId of pool) {
    if (accumulateFixedModel(acc, modelId)) continue;
    accumulateCatalogModel(acc, modelId, catalog);
  }

  if (acc.validModels === 0) return null;

  return {
    avgPrompt: acc.totalPrompt / acc.validModels,
    avgCompletion: acc.totalCompletion / acc.validModels,
    minContext: acc.minContext === Infinity ? DEFAULT_MIN_CONTEXT : acc.minContext,
  };
}

/**
 * End-to-end cost computation for a normalized model name.
 * Throws CostError on unknown model / missing pricing.
 *
 * `fetchFn` is injected so tests can stub out the OpenRouter catalog call.
 */
export async function computeCost(
  modelName: string,
  fetchFn?: FetchFn,
): Promise<CostResponse> {
  // Underlying-model lookup: when racing falls back to a specific provider (e.g.
  // `google/gemini-3-flash-preview`), the worker asks for pricing by that raw id
  // instead of the Rose variant. Resolve it directly from FIXED_PRICING so the
  // pricing activity doesn't 404 and burn retries.
  const fixed = FIXED_PRICING[modelName];
  if (fixed) {
    return {
      model: modelName,
      contextLength: fixed.contextLength,
      pricing: {
        costPerMillionInputTokens: roundUpToNearestFiveCents(fixed.prompt),
        costPerMillionOutputTokens: roundUpToNearestFiveCents(fixed.completion),
      },
    };
  }

  const pool = MODEL_POOLS[modelName];
  if (!pool) {
    throw new CostError(`Model not found: ${modelName}`, 404);
  }

  // Skip OpenRouter fetch if every pool model has fixed pricing.
  const needsCatalog = pool.some((id) => !FIXED_PRICING[id]);
  const catalog = needsCatalog ? await fetchOpenRouterModels(fetchFn) : [];

  const pricing = aggregatePricing(pool, catalog);
  if (!pricing) {
    throw new CostError('No pricing information available for models in pool', 500);
  }

  return {
    model: modelName,
    contextLength: pricing.minContext,
    pricing: {
      costPerMillionInputTokens: roundUpToNearestFiveCents(pricing.avgPrompt),
      costPerMillionOutputTokens: roundUpToNearestFiveCents(pricing.avgCompletion),
    },
  };
}
