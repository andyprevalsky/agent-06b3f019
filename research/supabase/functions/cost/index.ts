import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Model pools for Rose variants - sync with backend/src/routes/rose.ts
const MODEL_POOLS = {
  'rose-1-lite': [
    // 'openai/gpt-oss-120b', // Disabled - produces 120+ garbage tool calls disconnected from reasoning
    // 'qwen/qwen3-235b-a22b-thinking-2507', // Disabled - produces garbage tool calls disconnected from reasoning
    'moonshotai/kimi-k2-0905',
    // 'deepseek/deepseek-v3.2-exp', // Disabled - produces garbage tool calls disconnected from reasoning
    'openai/gpt-5.2',
    'mistralai/mistral-medium-3.1',
    'google/gemini-2.5-flash',
    'nousresearch/hermes-4-405b',
    'minimax/minimax-m2',
    'x-ai/grok-4-fast'
  ],
  'rose-1-ultra': [
    'anthropic/claude-opus-4-5-20251101',
    'openai/gpt-5.2',
    'google/gemini-3-pro-preview',
    'moonshotai/kimi-k2.5'
  ],
  // Browser automation pool - specialized models for web interaction
  // browser-use has fixed pricing, yutori/n1 uses OpenRouter
  'rose-1-browser-use': [
    'browser-use',              // Fixed: $0.10 input, $0.40 output per 1M tokens
    'yutori/n1',                // Via OpenRouter
  ]
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Extract model name from query parameter
    const url = new URL(req.url);
    let modelName = url.searchParams.get('model');
    
    if (!modelName) {
      return new Response(JSON.stringify({ 
        error: 'Missing required query parameter: model' 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    
    modelName = modelName.toLowerCase();
    
    // Normalize: 'rose-labs/rose-1-lite' → 'rose-1-lite'
    if (modelName.startsWith('rose-labs/')) {
      modelName = modelName.replace('rose-labs/', '');
    }
    
    const pool = MODEL_POOLS[modelName as keyof typeof MODEL_POOLS];

    if (!pool) {
      return new Response(JSON.stringify({
        error: `Model not found: ${modelName}`
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 404,
      });
    }

    // Fixed pricing for models not on OpenRouter (per token)
    // browser-use: $0.10 input, $0.40 output per 1M tokens
    const FIXED_PRICING: Record<string, { prompt: number; completion: number; contextLength: number }> = {
      'browser-use': {
        prompt: 0.10 / 1000000,      // $0.10 per 1M tokens -> per token
        completion: 0.40 / 1000000,  // $0.40 per 1M tokens -> per token
        contextLength: 128000,       // 128k context
      },
      'moonshotai/kimi-k2.5': {
        prompt: 0.60 / 1000000,      // $0.60 per 1M tokens -> per token
        completion: 3.00 / 1000000,  // $3.00 per 1M tokens -> per token
        contextLength: 128000,       // 128k context
      },
    };

    // Fetch all OpenRouter models
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
        'HTTP-Referer': Deno.env.get('SUPABASE_URL') || 'https://rose-benchmark.supabase.co',
        'X-Title': 'Rose Benchmark Suite'
      }
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API returned ${response.status}`);
    }

    const data = await response.json() as any;
    const allModels = data.data || [];

    // Calculate average pricing and minimum context length
    let totalPrompt = 0;
    let totalCompletion = 0;
    let validModels = 0;
    let minContextLength = Infinity;

    for (const modelId of pool) {
      // Check for fixed pricing first (models not on OpenRouter)
      const fixedPricing = FIXED_PRICING[modelId];
      if (fixedPricing) {
        if (fixedPricing.contextLength < minContextLength) {
          minContextLength = fixedPricing.contextLength;
        }
        totalPrompt += fixedPricing.prompt;
        totalCompletion += fixedPricing.completion;
        validModels++;
        continue;
      }

      // Fall back to OpenRouter pricing
      const modelInfo = allModels.find((m: any) => m.id === modelId);

      if (modelInfo) {
        // Track minimum context length for all models
        const contextLength = modelInfo.top_provider?.context_length || modelInfo.context_length;
        if (contextLength && contextLength < minContextLength) {
          minContextLength = contextLength;
        }

        // Track pricing only for models that have it
        if (modelInfo.pricing) {
          // OpenRouter returns price per token, accumulate as-is
          const promptCost = parseFloat(modelInfo.pricing.prompt || '0');
          const completionCost = parseFloat(modelInfo.pricing.completion || '0');

          totalPrompt += promptCost;
          totalCompletion += completionCost;
          validModels++;
        }
      }
    }

    if (validModels === 0) {
      return new Response(JSON.stringify({ 
        error: 'No pricing information available for models in pool' 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      });
    }

    // Calculate averages (per token)
    const avgPrompt = totalPrompt / validModels;
    const avgCompletion = totalCompletion / validModels;

    // Convert to per-million tokens, round up to nearest $0.05, return as number
    const roundUpToNearestFiveCents = (perTokenPrice: number) => {
      const perMillionPrice = perTokenPrice * 1000000;
      const roundedPerMillion = Math.ceil(perMillionPrice / 0.05) * 0.05;
      return roundedPerMillion; // Return per-million price directly
    };

    const costPerMillionInputTokens = roundUpToNearestFiveCents(avgPrompt);
    const costPerMillionOutputTokens = roundUpToNearestFiveCents(avgCompletion);

    return new Response(JSON.stringify({
      model: modelName,
      contextLength: minContextLength === Infinity ? 200000 : minContextLength,
      pricing: {
        costPerMillionInputTokens,
        costPerMillionOutputTokens
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error('Cost calculation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      error: 'Failed to calculate cost',
      details: errorMessage 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

