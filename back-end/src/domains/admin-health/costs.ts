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
}

const anthropic = (
  inputDollarsPerMillion: number,
  outputDollarsPerMillion: number
): ModelRates => ({
  inputDollarsPerMillion,
  outputDollarsPerMillion,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
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
});

const openRouter = (
  inputDollarsPerMillion: number,
  outputDollarsPerMillion: number
): ModelRates => ({
  inputDollarsPerMillion,
  outputDollarsPerMillion,
  cacheReadMultiplier: 0.25,
  cacheWriteMultiplier: 1,
});

const uncached = (inputDollarsPerMillion: number, outputDollarsPerMillion: number): ModelRates => ({
  inputDollarsPerMillion,
  outputDollarsPerMillion,
  cacheReadMultiplier: 1,
  cacheWriteMultiplier: 1,
});

const SONNET_5_PRICE_CHANGE_AT = Date.parse('2026-09-01T00:00:00.000Z');

// Current public API-equivalent rates in USD per million tokens. Historical
// periods intentionally use today's rates so the trend reflects usage mix,
// rather than combining usage changes with old provider price changes.
const MODEL_RATES: Record<string, ModelRates> = {
  'claude-fable-5': anthropic(10, 50),
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
  'gpt-5.6-sol': openAi(5, 30, 1.25),
  'gpt-5.6-terra': openAi(2.5, 15, 1.25),
  'gpt-5.6-luna': openAi(1, 6, 1.25),
  'gpt-5.5': openAi(5, 30),
  'gpt-5.4': openAi(1.75, 14),
  'google/gemini-3-flash-preview': openRouter(0.5, 3),
  'google/gemini-3.5-flash': openRouter(1.5, 9),
  'google/gemini-3.1-pro-preview': openRouter(2, 12),
  'moonshotai/kimi-k2.5': openRouter(0.38, 1.72),
  'moonshotai/kimi-k2.7-code': openRouter(0.74, 3.5),
  'zai-glm-4.7': uncached(2.25, 2.75),
  // Pool identifiers appear in some older usage rows before actual-model
  // provenance was recorded. Use the mean of their waterfall provider rates.
  'rose-labs/rose-1-lite': openRouter(1.12, 6.25),
  'rose-labs/rose-1-ultra': openRouter(3.5, 18.5),
  'rose-labs/rose-1-browser-use': openRouter(5, 27.5),
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
  if (normalized.startsWith('anthropic/')) return normalized.slice('anthropic/'.length);
  if (normalized.startsWith('openai/')) return normalized.slice('openai/'.length);
  if (normalized.endsWith('-openai')) return normalized.slice(0, -'-openai'.length);
  return normalized;
}

function apiEquivalentLlmDollars(usage: RootAgentRunUsageRecord, pricedAt: number): number {
  if (usage.fromFastCache) return 0;
  const rates = currentModelRates(normalizeModel(usage.model), pricedAt);
  if (rates === undefined) return usage.costCents / 100;
  const input =
    usage.tokensIn +
    usage.cacheReadInputTokens * rates.cacheReadMultiplier +
    usage.cacheCreationInputTokens * rates.cacheWriteMultiplier;
  return (
    (input * rates.inputDollarsPerMillion + usage.tokensOut * rates.outputDollarsPerMillion) /
    1_000_000
  );
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
    };
  }
  const includedTaskIds = new Set(runs.map((run) => run.taskId));
  let serviceDollars = 0;
  let apiLlmDollars = 0;
  for (const usage of usageRows) {
    if (!includedTaskIds.has(usage.taskId)) continue;
    if (usage.kind.toLowerCase() === 'llm') {
      apiLlmDollars += apiEquivalentLlmDollars(usage, pricedAt);
    } else serviceDollars += usage.costCents / 100;
  }
  const taskCount = runs.length;
  return {
    zeroLlmCostDollars: roundedDollars(serviceDollars / taskCount),
    apiRateDollars: roundedDollars((serviceDollars + apiLlmDollars) / taskCount),
    computeTokenRateDollars: roundedDollars((serviceDollars + apiLlmDollars / 20) / taskCount),
    sampleSize: taskCount,
  };
}
