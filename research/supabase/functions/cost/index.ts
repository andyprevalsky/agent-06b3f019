import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';

/** Pricing info returned by OpenRouter's /models endpoint. */
interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
}

/** A single model entry from OpenRouter's /models response. */
interface OpenRouterModel {
  id: string;
  context_length?: number;
  top_provider?: { context_length?: number };
  pricing?: OpenRouterPricing;
}

/** Resolved per-token pricing for a single model. */
interface ResolvedPricing {
  prompt: number;
  completion: number;
  contextLength: number;
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Model pools for Rose variants - sync with research/supabase/functions/completions/index.ts
const MODEL_POOLS: Record<string, string[]> = {
  'rose-1-lite': [
    'google/gemini-3-flash-preview',
    'moonshotai/kimi-k2.5',
  ],
  'rose-1-ultra': [
    // 'anthropic/claude-opus-4.6',  // Disabled: Anthropic API credits depleted
    'openai/gpt-5.2',
    'google/gemini-3-pro-preview',
    'moonshotai/kimi-k2.5',
  ],
  // Browser automation pool - specialized models for web interaction
  // browser-use has fixed pricing, yutori/n1 uses OpenRouter
  'rose-1-browser-use': [
    'browser-use', // Fixed: $0.10 input, $0.40 output per 1M tokens
    'yutori/n1', // Via OpenRouter
    'openai/gpt-5.2', // Via OpenRouter
  ],
};

// Fixed pricing for models not on OpenRouter (per token).
// browser-use: $0.10 input, $0.40 output per 1M tokens
const FIXED_PRICING: Record<string, ResolvedPricing> = {
  'browser-use': {
    prompt: 0.10 / 1_000_000,
    completion: 0.40 / 1_000_000,
    contextLength: 128_000,
  },
  'moonshotai/kimi-k2.5': {
    prompt: 0.60 / 1_000_000,
    completion: 3.00 / 1_000_000,
    contextLength: 128_000,
  },
};

/** Round a per-token price up to the nearest $0.05 per million tokens. */
function roundUpToNearestFiveCents(perTokenPrice: number): number {
  const perMillionPrice = perTokenPrice * 1_000_000;
  return Math.ceil(perMillionPrice / 0.05) * 0.05;
}

/** Build a JSON error response with CORS headers. */
function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status },
  );
}

/** Build a JSON success response with CORS headers. */
function jsonOk(body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify(body),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
  );
}

/** Fetch model catalog from OpenRouter. */
async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
      'HTTP-Referer': Deno.env.get('SUPABASE_URL') ?? 'https://rose-benchmark.supabase.co',
      'X-Title': 'Rose Benchmark Suite',
    },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter API returned ${response.status}`);
  }
  const data = (await response.json()) as { data?: OpenRouterModel[] };
  return data.data ?? [];
}

/** Aggregate pricing across a model pool, blending fixed and OpenRouter prices. */
function aggregatePricing(
  pool: string[],
  catalog: OpenRouterModel[],
): { avgPrompt: number; avgCompletion: number; minContext: number } | null {
  let totalPrompt = 0;
  let totalCompletion = 0;
  let validModels = 0;
  let minContext = Infinity;

  for (const modelId of pool) {
    const fixed = FIXED_PRICING[modelId];
    if (fixed) {
      if (fixed.contextLength < minContext) minContext = fixed.contextLength;
      totalPrompt += fixed.prompt;
      totalCompletion += fixed.completion;
      validModels++;
      continue;
    }

    const info = catalog.find((m) => m.id === modelId);
    if (!info) continue;

    const ctx = info.top_provider?.context_length ?? info.context_length;
    if (ctx !== undefined && ctx < minContext) minContext = ctx;

    if (info.pricing) {
      totalPrompt += parseFloat(info.pricing.prompt ?? '0');
      totalCompletion += parseFloat(info.pricing.completion ?? '0');
      validModels++;
    }
  }

  if (validModels === 0) return null;

  return {
    avgPrompt: totalPrompt / validModels,
    avgCompletion: totalCompletion / validModels,
    minContext: minContext === Infinity ? 200_000 : minContext,
  };
}

/** Parse and normalize the model name from the request URL. */
function parseModelName(url: URL): string | null {
  const raw = url.searchParams.get('model');
  if (!raw) return null;
  let name = raw.toLowerCase();
  if (name.startsWith('rose-labs/')) {
    name = name.replace('rose-labs/', '');
  }
  return name;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const modelName = parseModelName(new URL(req.url));
    if (!modelName) {
      return jsonError('Missing required query parameter: model', 400);
    }

    const pool = MODEL_POOLS[modelName];
    if (!pool) {
      return jsonError(`Model not found: ${modelName}`, 404);
    }

    const catalog = await fetchOpenRouterModels();
    const pricing = aggregatePricing(pool, catalog);
    if (!pricing) {
      return jsonError('No pricing information available for models in pool', 500);
    }

    return jsonOk({
      model: modelName,
      contextLength: pricing.minContext,
      pricing: {
        costPerMillionInputTokens: roundUpToNearestFiveCents(pricing.avgPrompt),
        costPerMillionOutputTokens: roundUpToNearestFiveCents(pricing.avgCompletion),
      },
    });
  } catch (error) {
    // deno-lint-ignore no-console
    console.error('Cost calculation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Failed to calculate cost', details: errorMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    );
  }
});
