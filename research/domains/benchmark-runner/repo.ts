/**
 * Repo layer for the benchmark-runner domain.
 *
 * Layer boundaries (import rules):
 *   - May import from own types and own config.
 *   - This is the sole consumer of the external model API (HTTP fetch).
 *   - Typed args in, typed results out. No business logic.
 */

import type { ModelCallResult } from './types.ts';
import {
  COMPLETION_TOKEN_COST_USD,
  DEFAULT_COT_STEPS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  PROMPT_TOKEN_COST_USD,
  ROSE_MODEL_ID,
} from './config.ts';

export interface ModelCallParams {
  url: string;
  apiKey: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  cotSteps?: number;
}

/**
 * Call the configured chat-completions endpoint with the given prompt and
 * return the model response along with an approximate cost in cents.
 */
export async function callModel(params: ModelCallParams): Promise<ModelCallResult> {
  const { url, apiKey, prompt, temperature, maxTokens, cotSteps } = params;

  const requestBody = {
    model: ROSE_MODEL_ID,
    messages: [{ role: 'user', content: prompt }],
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    cot_steps: cotSteps ?? DEFAULT_COT_STEPS,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const modelResponse: string = data.choices?.[0]?.message?.content ?? '';

  const promptTokens: number = data.usage?.prompt_tokens ?? 0;
  const completionTokens: number = data.usage?.completion_tokens ?? 0;
  const costCents = Math.ceil(
    (promptTokens * PROMPT_TOKEN_COST_USD + completionTokens * COMPLETION_TOKEN_COST_USD) * 100,
  );

  return {
    response: modelResponse,
    cost: costCents,
  };
}
