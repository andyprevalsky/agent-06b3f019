import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';

const router = Router();

// Model pools for Rose variants
export const MODEL_POOLS = {
  'rose-ultra': [
    'anthropic/claude-sonnet-4.5',
    'openai/gpt-5'
  ],
  '★-rose': [
    'moonshotai/kimi-k2-thinking',
    'anthropic/claude-sonnet-4.5',
    'deepseek/deepseek-chat-v3.1',
    'google/gemini-2.5-flash'
  ]
};

// Randomly select a model from the pool
function selectModel(requestedModel: string): string {
  // Normalize: 'rose-labs/rose' → 'rose', 'rose-labs/rose-ultra' → 'rose-ultra'
  let normalized = requestedModel.toLowerCase();
  if (normalized.startsWith('rose-labs/')) {
    normalized = normalized.replace('rose-labs/', '');
  }
  
  const pool = MODEL_POOLS[normalized as keyof typeof MODEL_POOLS];
  
  if (!pool) {
    throw new Error(`Unknown model: ${requestedModel}. Use 'rose-labs/★-rose' or 'rose-labs/rose-ultra'`);
  }
  
  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  console.log(`🎲 Model selection: ${requestedModel} → ${selectedModel}`);
  return selectedModel;
}

/**
 * POST /v1/chat/completions
 * OpenRouter-compatible chat completions endpoint
 */
router.post('/chat/completions', async (req: AuthRequest, res: Response) => {
  try {
    const { model, messages, temperature, max_tokens, ...otherParams } = req.body;

    // Validate request
    if (!model) {
      return res.status(400).json({ error: 'Missing required field: model' });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid required field: messages' });
    }

    // Select actual model from pool
    let actualModel: string;
    try {
      actualModel = selectModel(model);
    } catch (error) {
      return res.status(400).json({ 
        error: error instanceof Error ? error.message : 'Invalid model' 
      });
    }

    // Prepare request to OpenRouter
    const openrouterBody = {
      model: actualModel,
      messages,
      temperature,
      max_tokens,
      ...otherParams
    };

    // Call OpenRouter API
    const openrouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.BACKEND_URL || 'https://navi-j9a9.onrender.com',
        'X-Title': 'Navi AI Agent'
      },
      body: JSON.stringify(openrouterBody)
    });

    if (!openrouterResponse.ok) {
      const errorText = await openrouterResponse.text();
      console.error('OpenRouter API error:', openrouterResponse.status, errorText);
      return res.status(openrouterResponse.status).json({ 
        error: 'OpenRouter API error',
        details: errorText 
      });
    }

    const data = await openrouterResponse.json() as any;

    // Mask the actual model in the response - return the requested model name
    if (data.model) {
      data.model = model;  // Replace actual model with the requested Rose variant
    }

    // Return the response (with masked model)
    res.json(data);
  } catch (error) {
    console.error('Rose endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Internal server error',
      details: errorMessage 
    });
  }
});

/**
 * GET /v1/cost/:modelName
 * Calculate average cost for Rose model pools
 * Returns average of pool models rounded up to nearest $0.05
 * Also returns minimum context length from all models in pool
 */
router.get('/cost/:modelName', async (req: AuthRequest, res: Response) => {
  try {
    // Normalize: 'rose-labs/rose' → 'rose', 'rose-labs/rose-ultra' → 'rose-ultra'
    let modelName = req.params.modelName.toLowerCase();
    if (modelName.startsWith('rose-labs/')) {
      modelName = modelName.replace('rose-labs/', '');
    }
    const pool = MODEL_POOLS[modelName as keyof typeof MODEL_POOLS];

    if (!pool) {
      return res.status(404).json({ 
        error: `Model not found: ${modelName}` 
      });
    }

    // Fetch all OpenRouter models
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.BACKEND_URL || 'https://navi-j9a9.onrender.com',
        'X-Title': 'Navi AI Agent'
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
      return res.status(500).json({ 
        error: 'No pricing information available for models in pool' 
      });
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

    const roundedPrompt = roundUpToNearestFiveCents(avgPrompt);
    const roundedCompletion = roundUpToNearestFiveCents(avgCompletion);

    res.json({
      model: modelName,
      poolSize: pool.length,
      contextLength: minContextLength === Infinity ? 200000 : minContextLength,
      pricing: {
        prompt: roundedPrompt.toString(),
        completion: roundedCompletion.toString()
      }
    });
  } catch (error) {
    console.error('Cost calculation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to calculate cost',
      details: errorMessage 
    });
  }
});

export default router;

