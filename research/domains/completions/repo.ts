/**
 * Completions Domain Repository
 *
 * Supabase data access for the Rose completions edge function. All database
 * reads and writes live here so the service + runtime layers can depend on
 * typed helpers instead of raw `supabase.from(...)` chains.
 *
 * Tables touched:
 *   - RoseApiKey           (read)  : API key lookup for request auth
 *   - RoseApiKeyLog        (write) : per-request usage log
 *   - RoseModelLatency     (rw)    : TTFT cache used by racing
 *   - RoseConversationModel (rw)   : conversation-pinned winner model
 */

import { randomUUID } from '../../providers/crypto.ts';
import { LATENCY_CACHE_TTL_MS, LOSER_LATENCY_INCREMENT_MS } from './config.ts';
import { slog } from '../../providers/logger.ts';
import type { SupabaseClient } from './types.ts';

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

/** Look up an API key row and return the owning user id, or null if absent. */
export async function validateApiKey(
  apiKey: string,
  supabase: SupabaseClient,
): Promise<{ apiKeyId: string; userId: string } | null> {
  slog('info', 'Validating API key:', { data: apiKey.substring(0, 8) + '...' });

  const { data, error } = await supabase
    .from('RoseApiKey')
    .select('id, userId')
    .eq('apiKey', apiKey)
    .single();

  if (error || !data) {
    slog('error', 'API key validation failed:', {
      data: error?.message || 'No data found',
    });
    return null;
  }

  slog('info', 'API key validated for userId:', { data: data.userId });
  return { apiKeyId: data.id, userId: data.userId };
}

// ---------------------------------------------------------------------------
// Usage logging
// ---------------------------------------------------------------------------

export async function logUsage(
  supabase: SupabaseClient,
  apiKeyId: string,
  userId: string,
  input: unknown,
  output: unknown,
  costCents: number,
  cotSteps: number,
): Promise<void> {
  const { error } = await supabase
    .from('RoseApiKeyLog')
    .insert({
      id: randomUUID(),
      apiKeyId,
      userId,
      input,
      output,
      costCents,
      cotSteps,
    });

  if (error) {
    slog('error', 'Failed to log usage:', { data: error });
  }
}

// ---------------------------------------------------------------------------
// Latency cache
// ---------------------------------------------------------------------------

export interface CachedLatencyResult {
  latencies: Map<string, number>;
  needsRefresh: boolean;
  missingModels: string[];
}

/** Fetch cached latencies for a pool (ignoring entries older than TTL). */
export async function getCachedLatencies(
  supabase: SupabaseClient,
  pool: string,
  poolModels: string[],
): Promise<CachedLatencyResult> {
  const cutoff = new Date(Date.now() - LATENCY_CACHE_TTL_MS).toISOString();
  slog('info', `Fetching cached latencies for ${pool} (cutoff: ${cutoff})`);

  const { data, error } = await supabase
    .from('RoseModelLatency')
    .select('model, latencyMs, measuredAt')
    .eq('pool', pool)
    .gt('measuredAt', cutoff);

  const latencies = new Map<string, number>();
  if (error) {
    slog('error', 'Error fetching latency cache:', { data: error });
    return { latencies, needsRefresh: true, missingModels: poolModels };
  }

  for (const entry of (data as Array<{ model: string; latencyMs: number }> | null) || []) {
    latencies.set(entry.model, entry.latencyMs);
  }

  const missingModels = poolModels.filter((model) => !latencies.has(model));
  const needsRefresh = missingModels.length > 0;

  if (latencies.size === 0) {
    slog('info', `No cached latencies for ${pool} (cache empty or expired)`);
  } else {
    slog('info', `Cached latencies for ${pool}:`, {
      data: Object.fromEntries(latencies),
    });
    if (missingModels.length > 0) {
      slog('info', `Missing from cache: ${missingModels.join(', ')}`);
    }
  }

  return { latencies, needsRefresh, missingModels };
}

/**
 * Upsert a latency measurement. Ignores outliers (>10s normal, >60s for
 * browser-use) so a slow cold-start never poisons the cache.
 */
export async function updateLatencyCache(
  supabase: SupabaseClient,
  model: string,
  pool: string,
  latencyMs: number,
): Promise<void> {
  const maxValid = pool === 'rose-1-browser-use' ? 60000 : 10000;
  if (latencyMs > maxValid) {
    slog(
      'warn',
      `Ignoring outlier latency for ${model}: ${latencyMs}ms > ${maxValid}ms`,
    );
    return;
  }

  const id = randomUUID();

  const { error } = await supabase
    .from('RoseModelLatency')
    .upsert({
      id,
      model,
      pool,
      latencyMs,
      measuredAt: new Date().toISOString(),
    }, { onConflict: 'model,pool' });

  if (error) {
    slog('error', `Error updating latency cache for ${model}:`, { data: error });
  } else {
    slog('info', `Updated latency cache: ${model} = ${latencyMs}ms`);
  }
}

async function manualLatencyBump(
  supabase: SupabaseClient,
  model: string,
  pool: string,
): Promise<void> {
  const { data } = await supabase
    .from('RoseModelLatency')
    .select('latencyMs')
    .eq('model', model)
    .eq('pool', pool)
    .single();

  if (!data) return;

  const currentLatency = (data as { latencyMs: number }).latencyMs;
  const newLatency = currentLatency + LOSER_LATENCY_INCREMENT_MS;
  await supabase
    .from('RoseModelLatency')
    .update({ latencyMs: newLatency, measuredAt: new Date().toISOString() })
    .eq('model', model)
    .eq('pool', pool);

  slog(
    'info',
    `Loser ${model}: latency incremented ${currentLatency} → ${newLatency}ms (less sandbagging)`,
  );
}

/** Atomically bump a loser's cached latency via RPC, with manual fallback. */
export async function incrementLoserLatency(
  supabase: SupabaseClient,
  model: string,
  pool: string,
): Promise<void> {
  const { error } = await supabase.rpc('increment_loser_latency', {
    p_model: model,
    p_pool: pool,
    p_increment: LOSER_LATENCY_INCREMENT_MS,
  });

  if (error) {
    slog('warn', `RPC increment failed for ${model}, trying manual update:`, {
      data: error.message,
    });
    await manualLatencyBump(supabase, model, pool);
    return;
  }

  slog(
    'info',
    `Loser ${model}: latency incremented by ${LOSER_LATENCY_INCREMENT_MS}ms (atomic)`,
  );
}

// ---------------------------------------------------------------------------
// Conversation-model pinning
// ---------------------------------------------------------------------------

/** Return the previously pinned model for a conversation, or null. */
export async function getConversationModel(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  slog('info', `Looking up model for conversation: ${conversationId}`);

  const { data, error } = await supabase
    .from('RoseConversationModel')
    .select('model')
    .eq('conversationId', conversationId)
    .maybeSingle();

  if (error) {
    slog('error', `Error looking up conversation model:`, { data: error });
    return null;
  }

  if (!data) {
    slog('info', `No existing model for conversation ${conversationId}`);
    return null;
  }

  const model = (data as { model: string }).model;
  slog('info', `Found existing model for conversation ${conversationId}: ${model}`);
  return model;
}

/** Upsert the winning model for a conversation so future turns pin to it. */
export async function saveConversationModel(
  supabase: SupabaseClient,
  conversationId: string,
  model: string,
  pool: string,
): Promise<void> {
  slog('info', `Saving model ${model} for conversation ${conversationId}`);

  const id = randomUUID();

  const { error } = await supabase
    .from('RoseConversationModel')
    .upsert({
      id,
      conversationId,
      model,
      pool,
      createdAt: new Date().toISOString(),
    }, { onConflict: 'conversationId' });

  if (error) {
    slog('error', `Error saving conversation model:`, { data: error });
  } else {
    slog('info', `Saved model for conversation ${conversationId}: ${model}`);
  }
}
