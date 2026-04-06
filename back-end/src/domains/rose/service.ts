/**
 * Rose domain service — model selection, chat completions proxy, cost calculation.
 */

import {
  CEREBRAS_API_URL,
  CEREBRAS_API_KEY,
  OPENROUTER_API_KEY,
  BACKEND_URL,
  DEFAULT_CONTEXT_LENGTH,
} from './config';
import type {
  ModelSelection,
  ChatCompletionParams,
  CostResult,
  OpenRouterModelInfo,
} from './types';
import { ROSE_MODEL_POOLS, normalizeRoseAlias, isCerebrasPool } from '../../providers/roseModels';
import { createLogger } from '../../providers/logger';
import { logTruncate } from '../../utils/log';

const log = createLogger('Rose');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class UnknownModelError extends Error {
  constructor(requestedModel: string) {
    super(
      `Unknown model: ${requestedModel}. Use 'rose-labs/rose-1-lite', 'rose-labs/rose-1-ultra', or 'rose-labs/rose-hyper'`
    );
    this.name = 'UnknownModelError';
  }
}

export class UpstreamApiError extends Error {
  public statusCode: number;
  public details: string;
  constructor(provider: string, statusCode: number, details: string) {
    super(`${provider} API error`);
    this.name = 'UpstreamApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class NoPricingError extends Error {
  constructor() {
    super('No pricing information available for models in pool');
    this.name = 'NoPricingError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Randomly select a model from the pool.
 */
export function selectModel(requestedModel: string): ModelSelection {
  const normalized = normalizeRoseAlias(requestedModel) ?? requestedModel.toLowerCase();
  const pool = ROSE_MODEL_POOLS[normalized as keyof typeof ROSE_MODEL_POOLS];

  if (pool === undefined) {
    throw new UnknownModelError(requestedModel);
  }

  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  const isCerebras = isCerebrasPool(normalized);
  log.info(`Model selection: ${requestedModel} -> ${selectedModel}`, { cerebras: isCerebras });
  return { model: selectedModel, isCerebras };
}

/**
 * Round a per-token price up to the nearest five cents per million tokens.
 */
function roundUpToNearestFiveCents(perTokenPrice: number): number {
  const perMillionPrice = perTokenPrice * 1000000;
  const roundedPerMillion = Math.ceil(perMillionPrice / 0.05) * 0.05;
  return roundedPerMillion / 1000000;
}

// ---------------------------------------------------------------------------
// Chat completions — Cerebras path
// ---------------------------------------------------------------------------

interface CompletionResponseData {
  model?: string;
  [key: string]: unknown;
}

/**
 * Call Cerebras API for rose-hyper models.
 */
async function callCerebras(
  selectedModel: string,
  messages: ChatCompletionParams['messages'],
  temperature: number | undefined,
  max_tokens: number | undefined
): Promise<CompletionResponseData> {
  const cerebrasBody = { model: selectedModel, messages, temperature, max_tokens };

  log.info(`Calling Cerebras API`, { model: selectedModel });

  const cerebrasResponse = await fetch(CEREBRAS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CEREBRAS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cerebrasBody),
  });

  if (!cerebrasResponse.ok) {
    const errorText = await cerebrasResponse.text();
    log.error('Cerebras API error', {
      status: cerebrasResponse.status,
      details: logTruncate(errorText),
    });
    throw new UpstreamApiError('Cerebras', cerebrasResponse.status, logTruncate(errorText));
  }

  return (await cerebrasResponse.json()) as CompletionResponseData;
}

// ---------------------------------------------------------------------------
// Chat completions — OpenRouter path
// ---------------------------------------------------------------------------

/**
 * Call OpenRouter API for non-Cerebras Rose models.
 */
async function callOpenRouter(
  selectedModel: string,
  messages: ChatCompletionParams['messages'],
  temperature: number | undefined,
  max_tokens: number | undefined,
  otherParams: Record<string, unknown>
): Promise<CompletionResponseData> {
  const openrouterBody = {
    model: selectedModel,
    messages,
    temperature,
    max_tokens,
    ...otherParams,
    provider: { sort: 'throughput' },
  };

  const openrouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': BACKEND_URL,
      'X-Title': 'Rose AI Agent',
    },
    body: JSON.stringify(openrouterBody),
  });

  if (!openrouterResponse.ok) {
    const errorText = await openrouterResponse.text();
    log.error('OpenRouter API error', {
      status: openrouterResponse.status,
      details: logTruncate(errorText),
    });
    throw new UpstreamApiError('OpenRouter', openrouterResponse.status, logTruncate(errorText));
  }

  return (await openrouterResponse.json()) as CompletionResponseData;
}

// ---------------------------------------------------------------------------
// Chat completions — main entry point
// ---------------------------------------------------------------------------

/**
 * Proxy a chat completion request to the appropriate upstream provider.
 * Returns the response data with the model field masked to the requested model name.
 */
export async function chatCompletion(
  params: ChatCompletionParams
): Promise<CompletionResponseData> {
  const { model, messages, temperature, max_tokens, ...otherParams } = params;

  const selection = selectModel(model);
  let data: CompletionResponseData;

  if (selection.isCerebras) {
    data = await callCerebras(selection.model, messages, temperature, max_tokens);
  } else {
    data = await callOpenRouter(selection.model, messages, temperature, max_tokens, otherParams);
  }

  // Mask the actual model in the response - return the requested model name
  if (data.model !== undefined) {
    data.model = model;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/**
 * Calculate average cost for a Rose model pool.
 * Returns average of pool models rounded up to nearest $0.05, plus minimum context length.
 */
export async function calculateCost(modelName: string): Promise<CostResult> {
  let normalized = modelName.toLowerCase();
  if (normalized.startsWith('rose-labs/')) {
    normalized = normalized.replace('rose-labs/', '');
  }
  const pool = ROSE_MODEL_POOLS[normalized as keyof typeof ROSE_MODEL_POOLS];

  if (pool === undefined) {
    throw new UnknownModelError(modelName);
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': BACKEND_URL,
      'X-Title': 'Rose AI Agent',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API returned ${response.status}`);
  }

  const data = (await response.json()) as { data?: OpenRouterModelInfo[] };
  const allModels: OpenRouterModelInfo[] = data.data ?? [];

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

        totalPrompt += promptCost;
        totalCompletion += completionCost;
        validModels++;
      }
    }
  }

  if (validModels === 0) {
    throw new NoPricingError();
  }

  const avgPrompt = totalPrompt / validModels;
  const avgCompletion = totalCompletion / validModels;

  const roundedPrompt = roundUpToNearestFiveCents(avgPrompt);
  const roundedCompletion = roundUpToNearestFiveCents(avgCompletion);

  return {
    model: normalized,
    poolSize: pool.length,
    contextLength: minContextLength === Infinity ? DEFAULT_CONTEXT_LENGTH : minContextLength,
    pricing: {
      prompt: roundedPrompt.toString(),
      completion: roundedCompletion.toString(),
    },
  };
}
