import { Router, Request, Response } from 'express';
import NodeCache from 'node-cache';

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
 * GET /api/models - Get available OpenRouter models
 * Returns cached list of models sorted by provider and capability
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
    const models: OpenRouterModel[] = data.data || [];

    // Transform and sort models
    const sortedModels = sortModels(models);

    // Cache the results
    modelCache.set('models', sortedModels);

    res.json({ models: sortedModels, cached: false, count: sortedModels.length });
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
    'anthropic/claude-sonnet-4.5',
    'openai/gpt-5',
    'deepseek/deepseek-chat-v3.1',  // Closest to v3.1
    'openai/gpt-4.1',
    'x-ai/grok-4',
    'google/gemini-2.5-flash',
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

