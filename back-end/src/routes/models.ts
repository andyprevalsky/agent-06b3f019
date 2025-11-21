import { Router, Request, Response } from 'express';
import NodeCache from 'node-cache';
import { ROSE_MODEL_POOLS } from '../lib/roseModels';

const router = Router();
// Cache models for 1 hour (3600 seconds)
const modelCache = new NodeCache({ stdTTL: 3600 });

interface OpenRouterModel {
  id: string;
  name: string;
  created: number;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
}

interface SortedModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  contextLength?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

/**
 * DELETE /api/models/cache - Clear model cache (useful for testing)
 */
router.delete('/cache', (req: Request, res: Response) => {
  modelCache.del('models');
  res.json({ message: 'Model cache cleared' });
});

/**
 * Helper function to calculate Rose pricing and context length from model pool
 */
async function calculateRoseMetadata(modelName: string, allModels: OpenRouterModel[]) {
  try {
    const pool = ROSE_MODEL_POOLS[modelName as keyof typeof ROSE_MODEL_POOLS];
    if (!pool) {
      throw new Error(`Unknown Rose model: ${modelName}`);
    }

    // Calculate average pricing and minimum context length
    let totalPrompt = 0;
    let totalCompletion = 0;
    let validModels = 0;
    let minContextLength = Infinity;

    for (const modelId of pool) {
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
      throw new Error('No pricing information available for models in pool');
    }

    // Calculate averages (per token)
    const avgPrompt = totalPrompt / validModels;
    const avgCompletion = totalCompletion / validModels;
    
    // Convert to per-million tokens for rounding, then back to per-token
    const roundUpToNearestFiveCents = (perTokenPrice: number) => {
      const perMillionPrice = perTokenPrice * 1000000;
      const roundedPerMillion = Math.ceil(perMillionPrice / 0.05) * 0.05;
      return roundedPerMillion / 1000000;
    };

    return {
      pricing: {
        prompt: roundUpToNearestFiveCents(avgPrompt).toString(),
        completion: roundUpToNearestFiveCents(avgCompletion).toString()
      },
      contextLength: minContextLength === Infinity ? 200000 : minContextLength
    };
  } catch (error) {
    console.error(`Error calculating ${modelName} metadata:`, error);
    // Return fallback values
    return {
      pricing: {
        prompt: '0.05',
        completion: '0.10'
      },
      contextLength: 200000
    };
  }
}

/**
 * GET /api/models - Get available OpenRouter models
 * Returns cached list of models sorted by provider and capability
 * Filters to only models that support tool use
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // Check cache first
    const cached = modelCache.get<SortedModel[]>('models');
    if (cached) {
      return res.json({ models: cached, cached: true });
    }

    // Fetch from OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.BACKEND_URL || 'https://navi-j9a9.onrender.com',
        'X-Title': 'Navi AI Agent'
      }
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { data?: OpenRouterModel[] };
    const allModels: OpenRouterModel[] = data.data || [];

    // Filter to only models that support tool use
    const toolSupportedModels = allModels.filter(model => 
      model.supported_parameters?.includes('tools')
    );

    // Transform and sort models
    const sortedModels = sortModels(toolSupportedModels);

    // Calculate metadata for Rose models dynamically (pricing + context length)
    const roseFastMetadata = await calculateRoseMetadata('rose-1-fast', allModels);
    const roseUltraMetadata = await calculateRoseMetadata('rose-1-ultra', allModels);

    // Inject Rose models at the beginning
  const roseModels: SortedModel[] = [
    {
      id: 'rose-labs/rose-1-fast',
      name: 'rose-1-fast',
      provider: 'rose-labs',
      description: 'Rose Labs fast model optimized for low latency (< 6s avg)',
      contextLength: roseFastMetadata.contextLength,
      pricing: roseFastMetadata.pricing
    },
    {
      id: 'rose-labs/rose-1-ultra',
      name: 'rose-1-ultra',
      provider: 'rose-labs',
      description: 'Rose Labs ultra model for complex tasks (> 6s avg)',
      contextLength: roseUltraMetadata.contextLength,
      pricing: roseUltraMetadata.pricing
    }
  ];

    const finalModels = [...roseModels, ...sortedModels];

    // Cache the results
    modelCache.set('models', finalModels);

    res.json({ models: finalModels, cached: false, count: finalModels.length });
  } catch (error) {
    console.error('Models endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to fetch models',
      details: errorMessage,
      hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY
    });
  }
});

/**
 * Sort models: Featured first (exact order), then rest alphabetically
 */
function sortModels(models: OpenRouterModel[]): SortedModel[] {
  // Transform models
  const transformed: SortedModel[] = models.map(model => {
    const parts = model.id.split('/');
    const provider = parts[0] || 'unknown';
    const name = parts.slice(1).join('/') || model.id;

    return {
      id: model.id,
      name: name,
      provider: provider,
      description: model.description,
      contextLength: model.top_provider?.context_length || model.context_length,
      pricing: model.pricing
    };
  });

  // Define featured models (exact order matters)
  const featuredModels = [
    'google/gemini-2.5-flash',  // DEFAULT - Fast & capable - 1M context
    'anthropic/claude-sonnet-4.5',  // Claude Sonnet 4.5
    'openai/gpt-5-codex',  // GPT-5 Codex
    'xai/grok-4-fast',  // Grok 4 Fast
    'openai/gpt-oss-20b',
    'z-ai/glm-4.6',  // Newest GLM - 200K context

  ];

  // Separate featured and non-featured
  const featured: SortedModel[] = [];
  const others: SortedModel[] = [];

  // Group models
  transformed.forEach(model => {
    const featuredIndex = featuredModels.indexOf(model.id);
    if (featuredIndex !== -1) {
      featured.push(model);
    } else {
      others.push(model);
    }
  });

  // Sort featured by defined order
  featured.sort((a, b) => {
    const aIndex = featuredModels.indexOf(a.id);
    const bIndex = featuredModels.indexOf(b.id);
    return aIndex - bIndex;
  });

  // Sort others alphabetically by provider, then name
  others.sort((a, b) => {
    if (a.provider !== b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    return a.name.localeCompare(b.name);
  });

  // Return featured first, then others
  return [...featured, ...others];
}

export default router;

