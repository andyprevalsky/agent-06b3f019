/**
 * Rose-Bench Repo
 *
 * Data access layer for the benchmark runner.
 * - External model HTTP call (single fetch per question)
 * - Supabase insert of benchmark run record
 *
 * Repo rules: typed args in, typed results out. No business logic.
 */

import type {
  CreateSupabaseClientFn,
  FetchFn,
  ModelConfig,
  QuestionResult,
  SupabaseClientLike,
} from './types.ts';
import { getSupabaseServiceRoleKey, getSupabaseUrl } from './config.ts';

export interface ModelCallArgs {
  url: string;
  headers: Record<string, string>;
  modelConfig: ModelConfig;
  prompt: string;
  /** Injectable fetch; defaults to global fetch in production. */
  fetchFn?: FetchFn;
}

export interface ModelCallResponse {
  content: string;
}

/**
 * Calls an OpenAI-chat-completions-compatible endpoint and returns the first
 * message's text content. Throws on non-2xx.
 */
export async function callModelEndpoint(
  args: ModelCallArgs,
): Promise<ModelCallResponse> {
  const fetchImpl = args.fetchFn ?? fetch;
  const response = await fetchImpl(args.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...args.headers,
    },
    body: JSON.stringify({
      model: args.modelConfig.model,
      messages: [{
        role: 'user',
        content: args.prompt,
      }],
      temperature: args.modelConfig.temperature,
      max_tokens: args.modelConfig.maxTokens,
      seed: args.modelConfig.seed,
      cot_steps: args.modelConfig.cotSteps,
    }),
  });

  if (!response.ok) {
    throw new Error(`Model API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return { content };
}

export interface BenchmarkRunRecord {
  benchmarkName: string;
  modelConfig: ModelConfig;
  results: QuestionResult[];
  aggregateScore: number;
  totalCostCents: number;
  sampledQuestions: number;
  durationSeconds: number;
}

/**
 * Attempts to persist a benchmark run via Supabase. Returns a structured
 * status so the caller can log but never throw.
 */
export async function insertBenchmarkRun(
  createClient: CreateSupabaseClientFn,
  record: BenchmarkRunRecord,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseServiceKey = getSupabaseServiceRoleKey();
  if (!supabaseUrl || !supabaseServiceKey) {
    return { ok: false, reason: 'missing-supabase-credentials' };
  }

  const supabase: SupabaseClientLike = createClient(
    supabaseUrl,
    supabaseServiceKey,
  );

  const { error } = await supabase
    .from('BenchmarkRun')
    .insert({
      userId: 'anonymous', // TODO(#auth): Get actual user if authenticated
      benchmarkName: record.benchmarkName,
      modelConfig: record.modelConfig,
      results: record.results,
      aggregateScore: record.aggregateScore,
      totalCostCents: record.totalCostCents,
      sampledQuestions: record.sampledQuestions,
      durationSeconds: record.durationSeconds,
    });

  if (error) {
    const message = typeof error?.message === 'string' ? error.message : 'unknown-supabase-error';
    return { ok: false, reason: message };
  }

  return { ok: true };
}
