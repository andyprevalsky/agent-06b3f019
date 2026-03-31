/**
 * Rose domain types — interfaces and type aliases.
 */

export interface ModelSelection {
  model: string;
  isCerebras: boolean;
}

export interface ChatCompletionParams {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface CostResult {
  model: string;
  poolSize: number;
  contextLength: number;
  pricing: {
    prompt: string;
    completion: string;
  };
}

/**
 * Shape of an OpenRouter model object returned from their /models API.
 * Used in cost calculation to look up pricing and context length.
 */
export interface OpenRouterModelInfo {
  id: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  top_provider?: {
    context_length?: number;
  };
}
