/**
 * Cost domain types.
 *
 * Layer: types
 * May import from: external packages only.
 */

/** Pricing info returned by OpenRouter's /models endpoint. */
export interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
}

/** A single model entry from OpenRouter's /models response. */
export interface OpenRouterModel {
  id: string;
  context_length?: number;
  top_provider?: { context_length?: number };
  pricing?: OpenRouterPricing;
}

/** Resolved per-token pricing for a single model (fixed-pricing table entry). */
export interface ResolvedPricing {
  prompt: number;
  completion: number;
  contextLength: number;
}

/** Aggregated pricing across a model pool. */
export interface AggregatedPricing {
  avgPrompt: number;
  avgCompletion: number;
  minContext: number;
}

/** Public response payload for a successful GET /cost call. */
export interface CostResponse {
  model: string;
  contextLength: number;
  pricing: {
    costPerMillionInputTokens: number;
    costPerMillionOutputTokens: number;
  };
}
