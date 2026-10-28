import type {
  AdminHealthTaskCostPerTask,
  RootAgentRunRecord,
  RootAgentRunUsageRecord,
} from './types';

interface ModelRates {
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
  /** OpenAI-compatible prompt totals include cache tokens; Anthropic input totals exclude them. */
  inputIncludesCacheTokens: boolean;
}

const anthropic = (
  inputDollarsPerMillion: number,
  outputDollarsPerMillion: number
): ModelRates => ({
  inputDollarsPerMillion,
  outputDollarsPerMillion,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  inputIncludesCacheTokens: false,
});

const openAi = (
  inputDollarsPerMillion: number,
  outputDollarsPerMillion: number,
  cacheWriteMultiplier = 1
): ModelRates => ({
  inputDollarsPerMillion,
  outputDollarsPerMillion,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier,
  inputIncludesCacheTokens: true,
});

const openRouter = (
  inputDollarsPerMillion: number,
  outputDollarsPerMillion: number
): ModelRates => ({
  inputDollarsPerMillion,
  outputDollarsPerMillion,
  cacheReadMultiplier: 0.25,
  cacheWriteMultiplier: 1,
  inputIncludesCacheTokens: true,
});

const uncached = (inputDollarsPerMillion: number, outputDollarsPerMillion: number): ModelRates => ({
  inputDollarsPerMillion,
  outputDollarsPerMillion,
  cacheReadMultiplier: 1,
  cacheWriteMultiplier: 1,
  inputIncludesCacheTokens: false,
});

const SONNET_5_PRICE_CHANGE_AT = Date.parse('2026-09-01T00:00:00.000Z');

// Current public API-equivalent rates in USD per million tokens. Historical
// periods intentionally use today's rates so the trend reflects usage mix,
// rather than combining usage changes with old provider price changes.
const MODEL_RATES: Record<string, ModelRates> = {
  'claude-fable-5': anthropic(10, 50),
  'claude-fable-5-1': anthropic(10, 50),
  'claude-opus-5-5': anthropic(4, 20),
  'claude-opus-4.8': anthropic(5, 25),
  'claude-opus-4-8': anthropic(5, 25),
  'claude-opus-4.7': anthropic(5, 25),
  'claude-opus-4-7': anthropic(5, 25),
  'claude-opus-4.6': anthropic(5, 25),
  'claude-opus-4-6': anthropic(5, 25),
  'claude-opus-4.5': anthropic(5, 25),
  'claude-opus-4-5': anthropic(5, 25),
  'claude-sonnet-4.6': anthropic(3, 15),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-haiku-4.5': anthropic(1, 5),
  'claude-haiku-4-5': anthropic(1, 5),
  // Bare / `-openai` ids are the DIRECT OpenAI API route (our funded
  // GPT_API_KEY), so these carry OpenAI's own list prices. The OpenRouter
  // route is keyed separately under `openai/*` below — normalizeModel keeps
  // that prefix so the two cannot collapse onto one rate. Only `sol` actually
  // differs between the routes today ($5/$30 direct vs $2.50/$15 OpenRouter),
  // but the split is kept for all of them so a future divergence is expressible
  // rather than silently mis-billed.
  'gpt-5.6-sol': openAi(5, 30, 1.25),
  'gpt-5.6-terra': openAi(2, 12, 1.25),
  'gpt-5.6-luna': openAi(0.2, 1.2, 1.25),
  'gpt-5.5': openAi(5, 30),
  // The long-standing $1.75/$14 was stale for both routes.
  'gpt-5.4': openAi(2.5, 15),
  // OpenRouter-routed OpenAI models (waterfall). Same cache semantics as the
  // direct route (inclusive prompt totals, 0.1x read, 1.25x write) but
  // OpenRouter's cheaper per-token rates.
  'openai/gpt-5.6-sol': openAi(2.5, 15, 1.25),
  'openai/gpt-5.6-terra': openAi(2, 12, 1.25),
  'openai/gpt-5.6-luna': openAi(0.2, 1.2, 1.25),
  'openai/gpt-5.5': openAi(5, 30),
  'openai/gpt-5.4': openAi(2.5, 15),
  'google/gemini-3-flash-preview': openRouter(0.5, 3),
  'google/gemini-3.1-flash-lite': openRouter(0.25, 1.5),
  'google/gemini-3.5-flash': openRouter(1.5, 9),
  'google/gemini-3.5-flash-lite': openRouter(0.3, 2.5),
  'google/gemini-3.6-flash': openRouter(0.75, 3.75),
  'google/gemini-3.7-flash': openRouter(0.75, 3.75),
  'google/gemini-3.8-flash': openRouter(0.75, 3.75),
  'qwen/qwen3.8-27b': openRouter(0.15, 0.8),
  // Cerebras direct hop. Official list 2026-09-25: $0.99 / $1.49 per million.
  'qwen-3.8-27b': uncached(0.99, 1.49),
  'z-ai/glm-5.3-flash': openRouter(0.045, 0.14),
  'google/gemini-3.1-pro-preview': openRouter(2, 12),
  'moonshotai/kimi-k2.5': openRouter(0.57, 2.85),
  'moonshotai/kimi-k2.7-code': openRouter(0.71, 3.5),
  'moonshotai/kimi-k3': openRouter(3, 15),
  'openai/gpt-6-luna': openAi(0.1, 0.5, 1.25),
  'openai/gpt-6-sol': openAi(2, 10, 1.25),
  // Same OpenRouter rate as agents/providers/rose/pricing.py.
  'openai/gpt-6.1-sol': openAi(2, 10, 1.25),
  // Historical Cerebras chat primary (archived 2026-08-20). Keep for ledger rows.
  'zai-glm-4.7': uncached(2.25, 2.75),
  'z-ai/glm-4.7': openRouter(0.4, 1.75),
  // Historical Cerebras chat primary (chat-dead 2026-09-09: listed on /models
  // but chat/completions 404s). Keep for ledger rows.
  'gemma-4-31b': uncached(0.99, 1.49),
  'google/gemma-4-31b-it': openRouter(0.09, 0.34),
  // Current chat/SMS Cerebras primary (2026-09-09). Public Cerebras list
  // $0.35/$0.75 per M (ComputePrices 2026-09-07).
  'gpt-oss-120b': uncached(0.35, 0.75),
  'openai/gpt-oss-120b': openRouter(0.15, 0.6),
  'google/gemini-2.5-flash-lite': openRouter(0.1, 0.4),
  // Pool identifiers appear in some older usage rows before actual-model
  // provenance was recorded. Use the mean of their waterfall provider rates
  // (kept in sync with POOL_REGISTRY + agents/providers/rose/pricing.py).
  // mini waterfall mean: haiku ($1/$5) + glm-5.3-flash ($0.045/$0.14)
  'rose-labs/rose-1-mini': openRouter(0.5225, 2.57),
  // flash/browser mean: qwen3.8-27b ($0.15/$0.80) + gemini-3.8-flash ($0.75/$3.75)
  'rose-labs/rose-1-flash': openRouter(0.45, 2.275),
  // Historical lite pool id (renamed to flash). Keep the pre-bench rate for ledger rows.
  'rose-labs/rose-1-lite': openRouter(0.425, 2.125),
  // ultra waterfall mean: gpt-6-sol ($2/$10) + kimi-k3 ($3/$15)
  'rose-labs/rose-1-ultra': openRouter(2.5, 12.5),
  'rose-labs/rose-1-browser-use': openRouter(0.45, 2.275),
  // Open-weights-only pool; its waterfall is the single kimi-k3 layer.
  'rose-labs/rose-1-oss': openRouter(3, 15),
};

function currentModelRates(model: string, now = Date.now()): ModelRates | undefined {
  if (model === 'claude-sonnet-5') {
    return now < SONNET_5_PRICE_CHANGE_AT ? anthropic(2, 10) : anthropic(3, 15);
  }
  return MODEL_RATES[model];
}

function normalizeModel(model: string): string {
  const normalized = model
    .toLowerCase()
    .trim()
    .replace(/-(claude|gpt)$/, '');
  // Anthropic's OpenRouter and direct rates are identical, so collapsing that
  // prefix is lossless. OpenAI's are NOT — gpt-5.6-sol is $2.50/$15 per M via
  // OpenRouter and $5/$30 direct — so `openai/*` keeps its prefix and is
  // priced separately. Collapsing it billed every waterfall call at the direct
  // rate (2x over) and every direct call at the OpenRouter rate, depending on
  // which value happened to be in the table.
  if (normalized.startsWith('anthropic/')) return normalized.slice('anthropic/'.length);
  if (normalized.endsWith('-openai')) return normalized.slice(0, -'-openai'.length);
  return normalized;
}

interface LlmCostSample {
  dollars: number;
  /** Tokens we could neither reprice nor back onto a recorded cost. */
  unpricedTokens: number;
}

function totalTokens(usage: RootAgentRunUsageRecord): number {
  return (
    usage.tokensIn + usage.cacheReadInputTokens + usage.cacheCreationInputTokens + usage.tokensOut
  );
}

function apiEquivalentLlmDollars(usage: RootAgentRunUsageRecord, pricedAt: number): LlmCostSample {
  if (usage.fromFastCache) return { dollars: 0, unpricedTokens: 0 };
  const rates = currentModelRates(normalizeModel(usage.model), pricedAt);
  if (rates === undefined) {
    // Unknown model: fall back to whatever the row actually cost. When there is no
    // recorded cost either, the tokens are genuinely unpriceable — surface them as
    // coverage loss instead of silently averaging them in as $0.
    if (usage.costCents > 0) return { dollars: usage.costCents / 100, unpricedTokens: 0 };
    return { dollars: 0, unpricedTokens: totalTokens(usage) };
  }
  const uncachedInputTokens = rates.inputIncludesCacheTokens
    ? Math.max(0, usage.tokensIn - usage.cacheReadInputTokens - usage.cacheCreationInputTokens)
    : usage.tokensIn;
  const input =
    uncachedInputTokens +
    usage.cacheReadInputTokens * rates.cacheReadMultiplier +
    usage.cacheCreationInputTokens * rates.cacheWriteMultiplier;
  return {
    dollars:
      (input * rates.inputDollarsPerMillion + usage.tokensOut * rates.outputDollarsPerMillion) /
      1_000_000,
    unpricedTokens: 0,
  };
}

function roundedDollars(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Average cost for the supplied real root runs. Rows owned by any other agent ID
 * are ignored, which is the boundary that excludes spawned child agents.
 */
export function calculateTaskCostPerTask(
  runs: Array<Pick<RootAgentRunRecord, 'taskId'>>,
  usageRows: RootAgentRunUsageRecord[],
  pricedAt = Date.now()
): AdminHealthTaskCostPerTask {
  if (runs.length === 0) {
    return {
      zeroLlmCostDollars: null,
      apiRateDollars: null,
      computeTokenRateDollars: null,
      sampleSize: 0,
      unpricedUsageTokens: 0,
    };
  }
  const includedTaskIds = new Set(runs.map((run) => run.taskId));
  let serviceDollars = 0;
  let apiLlmDollars = 0;
  let unpricedUsageTokens = 0;
  for (const usage of usageRows) {
    if (!includedTaskIds.has(usage.taskId)) continue;
    if (usage.kind.toLowerCase() === 'llm') {
      const sample = apiEquivalentLlmDollars(usage, pricedAt);
      apiLlmDollars += sample.dollars;
      unpricedUsageTokens += sample.unpricedTokens;
    } else serviceDollars += usage.costCents / 100;
  }
  // The denominator is the number of DISTINCT tasks the numerator draws from. With
  // today's callers this always equals runs.length (runs arrive Map-deduped by id,
  // and taskId is that key), so this is a defensive invariant — not a metric change.
  const taskCount = includedTaskIds.size;
  return {
    zeroLlmCostDollars: roundedDollars(serviceDollars / taskCount),
    apiRateDollars: roundedDollars((serviceDollars + apiLlmDollars) / taskCount),
    computeTokenRateDollars: roundedDollars((serviceDollars + apiLlmDollars / 20) / taskCount),
    sampleSize: taskCount,
    unpricedUsageTokens,
  };
}
