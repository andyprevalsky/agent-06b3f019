/**
 * Cost + model selection helpers
 *
 * calculateCost: returns cents billed for a single completion. Claude-mode
 * (passthrough via user's Claude Code subscription) always bills zero because
 * Rose doesn't pay the underlying provider in that path.
 *
 * selectModel: resolves a Rose pool name (e.g. `rose-1-lite`) into a concrete
 * model. Priority: model_preference > model_seed > random selection.
 *
 * getAnthropicModelName: maps OpenRouter-style Anthropic aliases to the model
 * id the native Anthropic Messages API expects.
 */

import {
  COST_PER_MILLION_INPUT,
  COST_PER_MILLION_OUTPUT,
  MODEL_POOLS,
  MODEL_PREFERENCES,
  type ModelPreferenceName,
} from '../config.ts';
import { slog } from '../utils.ts';

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** Billed cost in cents. claude mode → 0 (user's own Anthropic subscription). */
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  _model: string,
  mode?: string,
): number {
  if (mode === 'claude') return 0;
  const promptCost = (promptTokens / 1_000_000) * COST_PER_MILLION_INPUT;
  const completionCost = (completionTokens / 1_000_000) * COST_PER_MILLION_OUTPUT;
  return Math.ceil((promptCost + completionCost) * 100);
}

// ---------------------------------------------------------------------------
// Anthropic model-name mapping
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
  'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5',
  'anthropic/claude-sonnet-4': 'claude-sonnet-4-20250514',
  'anthropic/claude-opus-4': 'claude-opus-4-20250514',
  'anthropic/claude-opus-4.7': 'claude-opus-4-7',
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
};

/** Map a Rose/OpenRouter Anthropic alias to the native Messages API model id. */
export function getAnthropicModelName(openRouterModel: string): string {
  return ANTHROPIC_MODEL_MAP[openRouterModel] ||
    openRouterModel.replace('anthropic/', '');
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

export interface SelectedModel {
  model: string;
  isCerebras: boolean;
  poolName: string;
  poolSize: number;
}

function normalizeRoseModel(requestedModel: string): string {
  let n = requestedModel.toLowerCase();
  if (n.startsWith('rose-labs/')) n = n.replace('rose-labs/', '');
  return n;
}

function resolveByPreference(
  requestedModel: string,
  normalized: string,
  poolSize: number,
  modelPreference: ModelPreferenceName,
): SelectedModel {
  const preference = MODEL_PREFERENCES[modelPreference];
  if (!preference) {
    throw new Error(
      `Invalid model_preference: ${modelPreference}. Use 'SMART', 'FAST', or 'CHEAP'`,
    );
  }
  slog(
    'info',
    `Model selection (preference=${modelPreference}): ${requestedModel} → ${preference.model} (Cerebras: ${preference.isCerebras})`,
  );
  return {
    model: preference.model,
    isCerebras: preference.isCerebras,
    poolName: normalized,
    poolSize,
  };
}

function resolveBySeed(
  requestedModel: string,
  normalized: string,
  pool: string[],
  modelSeed: number,
): SelectedModel {
  if (modelSeed < 0 || modelSeed >= pool.length) {
    throw new Error(
      `model_seed ${modelSeed} out of range. Pool '${normalized}' has ${pool.length} models (valid range: 0-${
        pool.length - 1
      })`,
    );
  }
  const selectedModel = pool[modelSeed];
  slog(
    'info',
    `Model selection (seed=${modelSeed}): ${requestedModel} → ${selectedModel} (Cerebras: false)`,
  );
  return {
    model: selectedModel,
    isCerebras: false,
    poolName: normalized,
    poolSize: pool.length,
  };
}

/**
 * Resolve a Rose pool name into a concrete model.
 * Priority: modelPreference > modelSeed > random.
 */
export function selectModel(
  requestedModel: string,
  modelSeed?: number,
  modelPreference?: ModelPreferenceName,
): SelectedModel {
  const normalized = normalizeRoseModel(requestedModel);
  const pool = MODEL_POOLS[normalized as keyof typeof MODEL_POOLS];

  if (!pool) {
    throw new Error(
      `Unknown model: ${requestedModel}. Use 'rose-labs/rose-1-lite' or 'rose-labs/rose-1-ultra'`,
    );
  }

  if (modelPreference) {
    return resolveByPreference(requestedModel, normalized, pool.length, modelPreference);
  }
  if (modelSeed !== undefined) {
    return resolveBySeed(requestedModel, normalized, pool, modelSeed);
  }

  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  slog(
    'info',
    `Model selection: ${requestedModel} → ${selectedModel} (Cerebras: false)`,
  );
  return {
    model: selectedModel,
    isCerebras: false,
    poolName: normalized,
    poolSize: pool.length,
  };
}
