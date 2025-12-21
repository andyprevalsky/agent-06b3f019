import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

// ============================================
// LATENCY RACING CONFIGURATION
// ============================================
const MAX_LATENCY_CAP_MS = 3000;    // Models with TTFT > 3s excluded entirely
const MAX_DELAY_CAP_MS = 1000;      // Max delay to equalize latencies (faster models excluded if need more delay)
const LATENCY_CACHE_TTL_MS = 60000; // 1 minute cache TTL
const TRIO_SIZE = 3;                // Race 3 models per request

// Model pools for Rose variants - sync with backend/src/routes/rose.ts
const MODEL_POOLS: Record<string, string[]> = {
  'rose-1-lite': [
    'moonshotai/kimi-k2-0905',
    'openai/gpt-5.2',
    'google/gemini-2.5-flash',
    'x-ai/grok-4-fast'
  ],
  'rose-1-ultra': [
    'openai/gpt-5.2',
    'anthropic/claude-sonnet-4.5',
    'moonshotai/kimi-k2-thinking',
    'google/gemini-3-pro-preview',
    'x-ai/grok-4.1-fast'
  ]
};

// Model preferences - hardcoded mappings for SMART/FAST/CHEAP
// FAST uses Cerebras for ultra-low latency inference
type ModelPreference = 'SMART' | 'FAST' | 'CHEAP';
const MODEL_PREFERENCES: Record<ModelPreference, { model: string; isCerebras: boolean }> = {
  'SMART': { model: 'openai/gpt-5.2', isCerebras: false },
  'FAST': { model: 'qwen-3-235b-a22b-instruct-2507', isCerebras: true },
  'CHEAP': { model: 'google/gemini-2.5-flash', isCerebras: false }
};

// Cerebras API base URL (OpenAI-compatible)
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// ============================================
// LATENCY CACHE FUNCTIONS
// ============================================

// Standard test prompt for latency probes - minimal tokens, consistent across all models
const LATENCY_PROBE_MESSAGES = [
  { role: "user", content: "Reply with just 'ok'" }
];
const LATENCY_PROBE_MAX_TOKENS = 16;

interface LatencyEntry {
  model: string;
  pool: string;
  latencyMs: number;
  measuredAt: Date;
}

// Get cached latencies for a pool (only entries < 1 min old)
// Returns both the latencies and whether any models are missing/stale
async function getCachedLatencies(supabase: any, pool: string, poolModels: string[]): Promise<{
  latencies: Map<string, number>;
  needsRefresh: boolean;
  missingModels: string[];
}> {
  const cutoff = new Date(Date.now() - LATENCY_CACHE_TTL_MS).toISOString();
  console.log(`📊 Fetching cached latencies for ${pool} (cutoff: ${cutoff})`);
  
  const { data, error } = await supabase
    .from('RoseModelLatency')
    .select('model, latencyMs, measuredAt')
    .eq('pool', pool)
    .gt('measuredAt', cutoff);
  
  const latencies = new Map<string, number>();
  if (error) {
    console.error('❌ Error fetching latency cache:', error);
    return { latencies, needsRefresh: true, missingModels: poolModels };
  }
  
  for (const entry of data || []) {
    latencies.set(entry.model, entry.latencyMs);
  }
  
  // Check which models are missing from cache
  const missingModels = poolModels.filter(model => !latencies.has(model));
  const needsRefresh = missingModels.length > 0;
  
  if (latencies.size === 0) {
    console.log(`📊 No cached latencies for ${pool} (cache empty or expired)`);
  } else {
    console.log(`📊 Cached latencies for ${pool}:`, Object.fromEntries(latencies));
    if (missingModels.length > 0) {
      console.log(`📊 Missing from cache: ${missingModels.join(', ')}`);
    }
  }
  
  return { latencies, needsRefresh, missingModels };
}

// Fire latency probes to specified models (runs in background, updates cache)
async function fireLatencyProbes(
  models: string[],
  pool: string,
  openRouterKey: string,
  supabaseUrl: string,
  supabase: any
): Promise<void> {
  console.log(`🔬 Firing latency probes for ${models.length} models: ${models.join(', ')}`);
  
  const probePromises = models.map(async (model) => {
    const startTime = Date.now();
    
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': supabaseUrl,
          'X-Title': 'Rose AI - Latency Probe'
        },
        body: JSON.stringify({
          model,
          messages: LATENCY_PROBE_MESSAGES,
          max_tokens: LATENCY_PROBE_MAX_TOKENS,
          stream: true
        })
      });
      
      if (!response.ok) {
        console.error(`❌ Probe failed for ${model}: ${response.status}`);
        return;
      }
      
      // Wait for FIRST DATA line, not just headers (matches racing behavior)
      const reader = response.body?.getReader();
      if (!reader) {
        console.error(`❌ Probe no body for ${model}`);
        return;
      }
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Check for actual data line (not just ": OPENROUTER PROCESSING" comment)
        if (buffer.includes('data:') && !buffer.includes('[DONE]')) {
          const lines = buffer.split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const ttftMs = Date.now() - startTime;
              console.log(`🔬 Probe result: ${model} = ${ttftMs}ms (first data)`);
              reader.cancel(); // Don't need the rest
              await updateLatencyCache(supabase, model, pool, ttftMs);
              return;
            }
          }
        }
      }
      
      console.error(`❌ Probe no data for ${model}`);
      
    } catch (error) {
      console.error(`❌ Probe error for ${model}:`, error);
    }
  });
  
  // Wait for all probes to complete
  await Promise.allSettled(probePromises);
  console.log(`🔬 All latency probes completed for ${pool}`);
}

// Update latency cache for a model (upsert)
// Ignores outlier latencies (> 10s) which are likely timeouts or errors
async function updateLatencyCache(supabase: any, model: string, pool: string, latencyMs: number): Promise<void> {
  // Ignore outliers - latencies > 10s are likely timeouts or cold starts
  const MAX_VALID_LATENCY_MS = 10000;
  if (latencyMs > MAX_VALID_LATENCY_MS) {
    console.warn(`⚠️ Ignoring outlier latency for ${model}: ${latencyMs}ms > ${MAX_VALID_LATENCY_MS}ms`);
    return;
  }
  
  // Generate a UUID for the id field
  const id = crypto.randomUUID();
  
  const { error } = await supabase
    .from('RoseModelLatency')
    .upsert({
      id,
      model,
      pool,
      latencyMs,
      measuredAt: new Date().toISOString()
    }, {
      onConflict: 'model,pool'
    });
  
  if (error) {
    console.error(`❌ Error updating latency cache for ${model}:`, error);
  } else {
    console.log(`⏱️ Updated latency cache: ${model} = ${latencyMs}ms`);
  }
}

// Increment loser's cached latency by 80ms (reduces sandbagging, gives them better chance next race)
// Uses atomic SQL increment via RPC to avoid race conditions
const LOSER_LATENCY_INCREMENT_MS = 80;

async function incrementLoserLatency(supabase: any, model: string, pool: string): Promise<void> {
  // Use raw SQL for atomic increment - Supabase doesn't have direct increment API
  // We'll use UPDATE with latencyMs = latencyMs + 10
  const { error } = await supabase.rpc('increment_loser_latency', {
    p_model: model,
    p_pool: pool,
    p_increment: LOSER_LATENCY_INCREMENT_MS
  });
  
  if (error) {
    // Fallback: if RPC doesn't exist, do manual increment (less atomic but works)
    console.warn(`⚠️ RPC increment failed for ${model}, trying manual update:`, error.message);
    
    // Fetch current value
    const { data } = await supabase
      .from('RoseModelLatency')
      .select('latencyMs')
      .eq('model', model)
      .eq('pool', pool)
      .single();
    
    if (data) {
      const newLatency = data.latencyMs + LOSER_LATENCY_INCREMENT_MS;
      await supabase
        .from('RoseModelLatency')
        .update({ latencyMs: newLatency, measuredAt: new Date().toISOString() })
        .eq('model', model)
        .eq('pool', pool);
      console.log(`📉 Loser ${model}: latency incremented ${data.latencyMs} → ${newLatency}ms (less sandbagging)`);
    }
  } else {
    console.log(`📉 Loser ${model}: latency incremented by ${LOSER_LATENCY_INCREMENT_MS}ms (atomic)`);
  }
}

// ============================================
// CONVERSATION MODEL TRACKING
// ============================================

// Get existing model selection for a conversation
async function getConversationModel(supabase: any, conversationId: string): Promise<string | null> {
  console.log(`🔍 Looking up model for conversation: ${conversationId}`);
  
  const { data, error } = await supabase
    .from('RoseConversationModel')
    .select('model')
    .eq('conversationId', conversationId)
    .maybeSingle();  // Use maybeSingle to avoid error when no rows found
  
  if (error) {
    console.error(`❌ Error looking up conversation model:`, error);
    return null;
  }
  
  if (!data) {
    console.log(`📝 No existing model for conversation ${conversationId}`);
    return null;
  }
  
  console.log(`🔗 Found existing model for conversation ${conversationId}: ${data.model}`);
  return data.model;
}

// Save model selection for a conversation
async function saveConversationModel(supabase: any, conversationId: string, model: string, pool: string): Promise<void> {
  console.log(`💾 Saving model ${model} for conversation ${conversationId}`);
  
  // Generate a UUID for the id field
  const id = crypto.randomUUID();
  
  const { error } = await supabase
    .from('RoseConversationModel')
    .upsert({
      id,
      conversationId,
      model,
      pool,
      createdAt: new Date().toISOString()
    }, {
      onConflict: 'conversationId'
    });
  
  if (error) {
    console.error(`❌ Error saving conversation model:`, error);
  } else {
    console.log(`✅ Saved model for conversation ${conversationId}: ${model}`);
  }
}

// ============================================
// TRIO RACING LOGIC
// ============================================

interface RacingModel {
  model: string;
  latencyMs: number;
  delayMs: number;
}

// Select a random trio from the pool, calculate delays based on cached latencies
// 
// Strategy: 
// 1. First, exclude models with latency > 3s (hard cap)
// 2. Group remaining models by latency bands (within 1000ms of each other)
// 3. Prefer the fastest band, randomly select trio from that band
// 4. Add delays to fast models so they finish at same time as the slowest in the trio
function selectRacingTrio(
  pool: string[],
  cachedLatencies: Map<string, number>
): RacingModel[] {
  const DEFAULT_LATENCY_MS = 500;
  
  // Get all models with their latencies
  const modelsWithLatency = pool.map(model => ({
    model,
    latencyMs: cachedLatencies.get(model) || DEFAULT_LATENCY_MS
  }));
  
  // Filter out models exceeding hard latency cap (3s)
  const underHardCap = modelsWithLatency.filter(m => {
    if (m.latencyMs > MAX_LATENCY_CAP_MS) {
      console.warn(`⚠️ Excluding ${m.model} - latency ${m.latencyMs}ms exceeds ${MAX_LATENCY_CAP_MS}ms cap`);
      return false;
    }
    return true;
  });
  
  if (underHardCap.length === 0) {
    console.warn('⚠️ No eligible models after 3s cap, using full pool with fastest models');
    const sorted = modelsWithLatency.sort((a, b) => a.latencyMs - b.latencyMs);
    return sorted.slice(0, TRIO_SIZE).map(m => ({ ...m, delayMs: 0 }));
  }
  
  // Sort by latency (fastest first)
  underHardCap.sort((a, b) => a.latencyMs - b.latencyMs);
  
  // Find models within MAX_DELAY_CAP_MS of the fastest model
  // This ensures no model needs more than 1s delay
  const fastestLatency = underHardCap[0].latencyMs;
  const withinDelayCap = underHardCap.filter(m => 
    (m.latencyMs - fastestLatency) <= MAX_DELAY_CAP_MS
  );
  
  // Log what we excluded due to delay cap
  const excludedByDelay = underHardCap.filter(m => 
    (m.latencyMs - fastestLatency) > MAX_DELAY_CAP_MS
  );
  for (const m of excludedByDelay) {
    console.warn(`⚠️ Excluding ${m.model} - latency ${m.latencyMs}ms is ${m.latencyMs - fastestLatency}ms slower than fastest (${fastestLatency}ms), exceeds ${MAX_DELAY_CAP_MS}ms delay cap`);
  }
  
  // ALWAYS include the fastest model, then randomly select the rest
  // This ensures we don't accidentally exclude a fast model for complex payloads
  const fastestModel = withinDelayCap[0];  // Already sorted, index 0 is fastest
  const otherModels = withinDelayCap.slice(1);
  
  // Shuffle the rest and pick TRIO_SIZE - 1
  const shuffledOthers = [...otherModels].sort(() => Math.random() - 0.5);
  const randomOthers = shuffledOthers.slice(0, Math.min(TRIO_SIZE - 1, shuffledOthers.length));
  
  // Combine: fastest + random others
  const selectedModels = [fastestModel, ...randomOthers];
  console.log(`🏁 Trio: fastest=${fastestModel.model}, others=[${randomOthers.map(m => m.model).join(', ')}]`);
  
  // Find the slowest model in the selected trio
  const slowestInTrio = Math.max(...selectedModels.map(m => m.latencyMs));
  
  // Calculate delays: fast models wait so all finish ~simultaneously
  const racingModels: RacingModel[] = selectedModels.map(m => ({
    model: m.model,
    latencyMs: m.latencyMs,
    delayMs: slowestInTrio - m.latencyMs
  }));
  
  console.log(`🏁 Racing trio (target finish ~${slowestInTrio}ms):`, 
    racingModels.map(m => `${m.model} (${m.latencyMs}ms + ${m.delayMs}ms delay = ${m.latencyMs + m.delayMs}ms)`));
  
  return racingModels;
}

// Race multiple models and return the first response
// Uses AbortController to cancel losing requests and save API costs
async function raceModels(
  racingModels: RacingModel[],
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any,
  reasoning: any,
  openRouterKey: string,
  supabaseUrl: string,
  supabase: any,
  pool: string,
  timings: { [key: string]: number }  // Track timing breakdown
): Promise<{ model: string; reader: ReadableStreamDefaultReader<Uint8Array>; ttftMs: number; firstData: string }> {
  
  console.log(`🏁 Starting race with ${racingModels.length} models:`, racingModels.map(m => `${m.model} (delay: ${m.delayMs}ms)`));
  const raceInternalStart = Date.now();
  timings.race_internal_start = 0;
  
  // Create AbortController for each model to cancel losers
  const controllers = racingModels.map(() => new AbortController());
  let winnerIndex = -1;
  
  // Create race promises that resolve on success and never reject (errors become null)
  const racePromises = racingModels.map(async ({ model, delayMs }, index): Promise<{ model: string; reader: ReadableStreamDefaultReader<Uint8Array>; ttftMs: number; index: number; firstData: string } | null> => {
    const modelKey = model.split('/').pop() || model;
    try {
      // Apply delay to equalize finish times
      if (delayMs > 0) {
        console.log(`⏳ ${model} waiting ${delayMs}ms before firing...`);
        timings[`${modelKey}_delay_start`] = Date.now() - raceInternalStart;
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delayMs);
          // If aborted during delay, reject immediately
          controllers[index].signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            reject(new DOMException('Aborted during delay', 'AbortError'));
          });
        });
        timings[`${modelKey}_delay_end`] = Date.now() - raceInternalStart;
      }
      
      // Check if already aborted before firing
      if (controllers[index].signal.aborted) {
        console.log(`🛑 ${model} aborted before firing`);
        return null;
      }
      
      const startTime = Date.now();
      timings[`${modelKey}_fire`] = Date.now() - raceInternalStart;
      console.log(`🚀 ${model} firing request at t=${timings[`${modelKey}_fire`]}ms...`);
      
      const body: any = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        seed,
        tools,
        tool_choice: toolChoice,
        stream: true
      };
      
      if (responseFormat) {
        body.response_format = responseFormat;
      }
      if (reasoning) {
        body.reasoning = reasoning;
      }
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': supabaseUrl,
          'X-Title': 'Rose AI - Trio Racing'
        },
        body: JSON.stringify(body),
        signal: controllers[index].signal  // Enable abort
      });
      
      const headersTime = Date.now() - startTime;
      timings[`${modelKey}_headers`] = Date.now() - raceInternalStart;
      console.log(`📨 ${model} headers in ${headersTime}ms at t=${timings[`${modelKey}_headers`]}ms (status: ${response.status})`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ ${model} failed: ${response.status} - ${errorText.slice(0, 100)}`);
        return null;
      }
      
      // CRITICAL: Wait for FIRST ACTUAL DATA, not just headers!
      // This prevents slow models from winning just because their headers arrive first
      const reader = response.body?.getReader();
      if (!reader) {
        console.error(`❌ ${model} no response body`);
        return null;
      }
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      // Read until we get a real data line (not just ": OPENROUTER PROCESSING")
      while (true) {
        // Check if aborted while waiting for content
        if (controllers[index].signal.aborted) {
          console.log(`🛑 ${model} aborted while waiting for content`);
          reader.cancel();
          return null;
        }
        
        const { done, value } = await reader.read();
        if (done) {
          console.error(`❌ ${model} stream ended before data`);
          return null;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        for (const line of lines) {
          // Look for actual data line (not processing comments)
          if (line.startsWith('data:') && !line.includes('[DONE]')) {
            const ttftMs = Date.now() - startTime;
            timings[`${modelKey}_ttft`] = ttftMs;
            timings[`${modelKey}_first_data`] = Date.now() - raceInternalStart;
            console.log(`✅ ${model} FIRST DATA in ${ttftMs}ms at t=${timings[`${modelKey}_first_data`]}ms`);
            
            // Return the reader (not response) since we've already started reading
            // Also return the buffer with data we've read so far
            return { model, reader, ttftMs, index, firstData: buffer };
          }
        }
        
        // Keep incomplete line in buffer
        buffer = lines[lines.length - 1] || '';
      }
    } catch (error) {
      // Don't log abort errors - they're expected for losers
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.log(`🛑 ${model} aborted (race lost)`);
        return null;
      }
      console.error(`❌ ${model} error:`, error);
      return null;
    }
  });
  
  // Use Promise.race with a filter for successful responses
  // We need custom logic since Promise.race doesn't skip null values
  const winner = await new Promise<{ model: string; reader: ReadableStreamDefaultReader<Uint8Array>; ttftMs: number; firstData: string }>((resolve, reject) => {
    let resolved = false;
    let completed = 0;
    
    racePromises.forEach(async (promise) => {
      try {
        const result = await promise;
        completed++;
        
        if (result && !resolved) {
          resolved = true;
          winnerIndex = result.index;
          console.log(`🏆 Winner: ${result.model} (TTFT: ${result.ttftMs}ms)`);
          
          // ABORT ALL OTHER REQUESTS to save API costs!
          // Also increment losers' cached latency (fire-and-forget, doesn't block response)
          controllers.forEach((controller, i) => {
            if (i !== winnerIndex) {
              console.log(`🛑 Aborting loser: ${racingModels[i].model}`);
              controller.abort();
              
              // Increment loser's latency by 10ms (reduces sandbagging, gives them better chance next race)
              incrementLoserLatency(supabase, racingModels[i].model, pool)
                .catch(e => console.error(`⚠️ Failed to increment loser latency:`, e));
            }
          });
          
          // Update cache for winning model with actual race TTFT (keeps cache fresh)
          updateLatencyCache(supabase, result.model, pool, result.ttftMs)
            .then(() => console.log(`📝 Cache updated for winner: ${result.model} = ${result.ttftMs}ms`))
            .catch(e => console.error(`⚠️ Failed to update winner cache:`, e));
          
          resolve({ model: result.model, reader: result.reader, ttftMs: result.ttftMs, firstData: result.firstData });
        } else if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      } catch (e) {
        completed++;
        if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      }
    });
  });
  
  return winner;
}

// Transform JSON schema to be Cerebras-compatible
// Cerebras requires: additionalProperties: false for all objects with required arrays
// See: https://inference-docs.cerebras.ai/capabilities/structured-outputs
function transformSchemaForCerebras(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const transformed = { ...schema };

  // If it's an object type with properties, add additionalProperties: false
  if (transformed.type === 'object' && transformed.properties) {
    transformed.additionalProperties = false;
    
    // Cerebras requires all properties to be in required array
    if (!transformed.required) {
      transformed.required = Object.keys(transformed.properties);
    }
    
    // Recursively transform nested properties
    for (const key of Object.keys(transformed.properties)) {
      transformed.properties[key] = transformSchemaForCerebras(transformed.properties[key]);
    }
  }

  // Handle $defs (definitions)
  if (transformed.$defs) {
    for (const key of Object.keys(transformed.$defs)) {
      transformed.$defs[key] = transformSchemaForCerebras(transformed.$defs[key]);
    }
  }

  // Handle array items
  if (transformed.type === 'array' && transformed.items) {
    transformed.items = transformSchemaForCerebras(transformed.items);
  }

  // Handle anyOf/oneOf/allOf
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (transformed[keyword] && Array.isArray(transformed[keyword])) {
      transformed[keyword] = transformed[keyword].map((item: any) => transformSchemaForCerebras(item));
    }
  }

  return transformed;
}

// Select a model from the pool (by preference, seed index, or random)
// Priority: modelPreference > modelSeed > random
function selectModel(
  requestedModel: string, 
  modelSeed?: number,
  modelPreference?: ModelPreference
): { model: string; isCerebras: boolean; poolName: string; poolSize: number } {
  let normalized = requestedModel.toLowerCase();
  if (normalized.startsWith('rose-labs/')) {
    normalized = normalized.replace('rose-labs/', '');
  }
  
  const pool = MODEL_POOLS[normalized as keyof typeof MODEL_POOLS];
  
  if (!pool) {
    throw new Error(`Unknown model: ${requestedModel}. Use 'rose-labs/rose-1-lite' or 'rose-labs/rose-1-ultra'`);
  }
  
  // If model_preference is provided, use hardcoded mapping (highest priority)
  if (modelPreference) {
    const preference = MODEL_PREFERENCES[modelPreference];
    if (!preference) {
      throw new Error(`Invalid model_preference: ${modelPreference}. Use 'SMART', 'FAST', or 'CHEAP'`);
    }
    console.log(`⚡ Model selection (preference=${modelPreference}): ${requestedModel} → ${preference.model} (Cerebras: ${preference.isCerebras})`);
    return { model: preference.model, isCerebras: preference.isCerebras, poolName: normalized, poolSize: pool.length };
  }
  
  // If model_seed is provided, use it to select a specific model
  if (modelSeed !== undefined) {
    if (modelSeed < 0 || modelSeed >= pool.length) {
      throw new Error(`model_seed ${modelSeed} out of range. Pool '${normalized}' has ${pool.length} models (valid range: 0-${pool.length - 1})`);
    }
    const selectedModel = pool[modelSeed];
    console.log(`🎯 Model selection (seed=${modelSeed}): ${requestedModel} → ${selectedModel} (Cerebras: false)`);
    return { model: selectedModel, isCerebras: false, poolName: normalized, poolSize: pool.length };
  }
  
  // Random selection from pool
  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  console.log(`🎲 Model selection: ${requestedModel} → ${selectedModel} (Cerebras: false)`);
  return { model: selectedModel, isCerebras: false, poolName: normalized, poolSize: pool.length };
}

// Validate API key and return user info
async function validateApiKey(apiKey: string, supabase: any): Promise<{ apiKeyId: string, userId: string } | null> {
  console.log('🔍 Validating API key:', apiKey.substring(0, 8) + '...');
  
  const { data, error } = await supabase
    .from('RoseApiKey')
    .select('id, userId')
    .eq('apiKey', apiKey)
    .single();
  
  if (error || !data) {
    console.error('❌ API key validation failed:', error?.message || 'No data found');
    console.error('   Error details:', error);
    return null;
  }
  
  console.log('✓ API key validated for userId:', data.userId);
  return { apiKeyId: data.id, userId: data.userId };
}

// Calculate cost based on token usage
function calculateCost(promptTokens: number, completionTokens: number, model: string): number {
  // Simplified cost calculation - in production, fetch actual pricing
  const costPerMillionPrompt = 50; // $0.50 per million
  const costPerMillionCompletion = 150; // $1.50 per million
  
  const promptCost = (promptTokens / 1000000) * costPerMillionPrompt;
  const completionCost = (completionTokens / 1000000) * costPerMillionCompletion;
  
  return Math.ceil((promptCost + completionCost) * 100); // Return in cents
}

// Log usage to database
async function logUsage(supabase: any, apiKeyId: string, userId: string, input: any, output: any, costCents: number, cotSteps: number) {
  const { error } = await supabase
    .from('RoseApiKeyLog')
    .insert({
      apiKeyId,
      userId,
      input,
      output,
      costCents,
      cotSteps
    });
  
  if (error) {
    console.error('Failed to log usage:', error);
  }
}

// Handle streaming response
async function handleStreaming(
  actualModel: string,
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any,  // Added: response_format for structured outputs
  reasoning: { max_tokens?: number } | undefined,  // Added: reasoning config for OpenRouter
  openRouterKey: string,
  supabaseUrl: string,
  requestedModel: string,
  isCerebras: boolean,
  poolName: string,     // Added: for debugging
  poolSize: number      // Added: for debugging
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let response: globalThis.Response;
        
        if (isCerebras) {
          // Call Cerebras API directly for rose-hyper
          const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY');
          console.log(`⚡ Streaming from Cerebras API with model: ${actualModel}`);
          
          // Build Cerebras streaming request - supports tools with gpt-oss-120b
          const cerebrasStreamBody: any = {
            model: actualModel,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: true
          };
          
          // Add tools for streaming (gpt-oss-120b supports this)
          if (tools && tools.length > 0) {
            cerebrasStreamBody.tools = tools;
          }
          if (toolChoice) {
            cerebrasStreamBody.tool_choice = toolChoice;
          }
          
          // Add response_format with schema transformation for Cerebras
          if (responseFormat) {
            if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
              const transformedSchema = transformSchemaForCerebras(responseFormat.json_schema.schema);
              cerebrasStreamBody.response_format = {
                type: 'json_schema',
                json_schema: {
                  name: responseFormat.json_schema.name || 'response',
                  strict: true,
                  schema: transformedSchema
                }
              };
            } else {
              cerebrasStreamBody.response_format = responseFormat;
            }
          }
          
          response = await fetch(CEREBRAS_API_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cerebrasKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(cerebrasStreamBody)
          });
        } else {
          // Call OpenRouter API for other Rose models
          const openRouterBody: any = {
            model: actualModel,
            messages,
            temperature,
            max_tokens: maxTokens,
            seed,
            tools,
            tool_choice: toolChoice,
            stream: true
          };
          
          // Add response_format for structured outputs
          if (responseFormat) {
            openRouterBody.response_format = responseFormat;
          }
          
          // Add reasoning config for reasoning models (Gemini, Anthropic, etc.)
          if (reasoning) {
            openRouterBody.reasoning = reasoning;
            console.log(`🧠 Streaming with reasoning config:`, reasoning);
          }
          
          response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openRouterKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': supabaseUrl,
              'X-Title': 'Rose Benchmark Suite'
            },
            body: JSON.stringify(openRouterBody)
          });
        }

        if (!response.ok) {
          const provider = isCerebras ? 'Cerebras' : 'OpenRouter';
          // Read error body for better debugging
          const errorText = await response.text();
          console.error(`${provider} streaming error:`, response.status, errorText);
          throw new Error(`${provider} API error: ${response.status} - ${errorText.slice(0, 200)}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                continue;
              }
              
              try {
                const parsed = JSON.parse(data);
                // Include metadata for debugging
                parsed.requested_model = requestedModel;
                parsed.actual_model = actualModel;
                parsed.pool_name = poolName;
                parsed.pool_size = poolSize;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              } catch (e) {
                console.error('Error parsing streaming data:', e);
              }
            }
          }
        }
      } catch (error) {
        console.error('Streaming error:', error);
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Main handler
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Extract API key from header
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing x-api-key header' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Validate API key
    const authInfo = await validateApiKey(apiKey, supabase);
    if (!authInfo) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Parse request body
    const { 
      model, 
      messages: originalMessages, 
      temperature, 
      max_tokens, 
      seed,
      stream = false,
      tools,
      tool_choice,
      cot_steps,
      response_format,
      reasoning,  // OpenRouter reasoning config: { max_tokens: number }
      model_seed,  // Optional: index into model pool for testing
      model_preference,  // Optional: 'SMART' | 'FAST' | 'CHEAP' for hardcoded model selection
      conversation_id,  // Optional: ensures same model used for entire conversation
      ...otherParams
    } = await req.json();
    
    const cotSteps = cot_steps || 1;
    const maxTokens = max_tokens;
    let messages = originalMessages;
    
    // Default reasoning tokens to 256 if reasoning is enabled but no max_tokens specified
    const DEFAULT_REASONING_TOKENS = 256;
    let cappedReasoning = reasoning;
    if (reasoning && !reasoning.max_tokens) {
      cappedReasoning = { ...reasoning, max_tokens: DEFAULT_REASONING_TOKENS };
      console.log(`🧠 Setting default reasoning tokens: ${DEFAULT_REASONING_TOKENS}`);
    }

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing required field: model' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing or invalid required field: messages' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    // Normalize pool name
    let poolName = model.toLowerCase();
    if (poolName.startsWith('rose-labs/')) {
      poolName = poolName.replace('rose-labs/', '');
    }
    
    // Check if it's a direct model passthrough (for testing)
    const DIRECT_MODEL_PREFIXES = ['openai/', 'google/', 'anthropic/', 'deepseek/', 'qwen/', 'x-ai/', 'meta/', 'moonshotai/'];
    const isDirectModel = DIRECT_MODEL_PREFIXES.some(prefix => model.toLowerCase().startsWith(prefix));
    
    const pool = MODEL_POOLS[poolName];
    if (!pool && !isDirectModel) {
      return new Response(JSON.stringify({ 
        error: `Unknown model: ${model}. Use 'rose-labs/rose-1-lite' or 'rose-labs/rose-1-ultra'` 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    
    // Handle direct model passthrough (bypass racing)
    if (isDirectModel) {
      console.log(`🔧 Direct model passthrough: ${model}`);
      if (stream) {
        return await handleStreaming(
          model,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          cappedReasoning,
          Deno.env.get('OPENROUTER_API_KEY')!,
          supabaseUrl,
          model,
          false,  // isCerebras
          'direct',
          1
        );
      }
      // Non-streaming direct passthrough handled below
    }

    // Track selected model for non-streaming fallback
    let selectedModel: string | null = null;
    let selectedIsCerebras = false;

    // Check for model_preference or model_seed (bypass racing)
    if (model_preference || model_seed !== undefined) {
      // Use legacy single-model selection
      let selection: { model: string; isCerebras: boolean; poolName: string; poolSize: number };
      try {
        selection = selectModel(model, model_seed, model_preference as ModelPreference | undefined);
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Invalid model' 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }

      if (stream) {
        return await handleStreaming(
          selection.model,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          cappedReasoning,
          Deno.env.get('OPENROUTER_API_KEY')!,
          supabaseUrl,
          model,
          selection.isCerebras,
          selection.poolName,
          selection.poolSize
        );
      }
      
      // Non-streaming with legacy selection
      selectedModel = selection.model;
      selectedIsCerebras = selection.isCerebras;
    }

    // ============================================
    // TRIO RACING MODE (default for streaming)
    // ============================================
    
    // Check if conversation already has a model selected
    if (conversation_id && !selectedModel) {
      const existingModel = await getConversationModel(supabase, conversation_id);
      if (existingModel) {
        console.log(`🔗 Using existing model for conversation: ${existingModel}`);
        
        if (stream) {
          return await handleStreaming(
            existingModel,
            messages,
            temperature,
            maxTokens,
            seed,
            tools,
            tool_choice,
            response_format,
            reasoning,
            Deno.env.get('OPENROUTER_API_KEY')!,
            supabaseUrl,
            model,
            false, // Not Cerebras
            poolName,
            pool.length
          );
        }
        
        selectedModel = existingModel;
        selectedIsCerebras = false;
      }
    }

    // Handle streaming with trio racing
    if (stream && !selectedModel) {
      const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')!;
      
      // ===== TIMING INSTRUMENTATION =====
      const timings: { [key: string]: number } = {};
      const raceStartTime = Date.now();
      timings.race_start = 0;
      
      // Get cached latencies for this pool
      const cacheStartTime = Date.now();
      const { latencies: cachedLatencies, needsRefresh, missingModels } = await getCachedLatencies(supabase, poolName, pool);
      timings.cache_lookup_ms = Date.now() - cacheStartTime;
      console.log(`⏱️ TIMING: cache_lookup=${timings.cache_lookup_ms}ms`);
      
      // If cache is stale/missing, fire latency probes in PARALLEL with the race
      // Probes use a standard test prompt, not the user's messages
      let probePromise: Promise<void> | null = null;
      if (needsRefresh && missingModels.length > 0) {
        console.log(`🔬 Cache needs refresh, firing probes in parallel for: ${missingModels.join(', ')}`);
        // Fire probes in background - don't await, let them run alongside the race
        probePromise = fireLatencyProbes(missingModels, poolName, openRouterKey, supabaseUrl, supabase);
        timings.probes_fired = missingModels.length;
      } else {
        timings.probes_fired = 0;
      }
      
      // Select racing trio with delays (using current cached values, even if stale)
      const trioSelectStart = Date.now();
      const racingTrio = selectRacingTrio(pool, cachedLatencies);
      timings.trio_select_ms = Date.now() - trioSelectStart;
      console.log(`⏱️ TIMING: trio_select=${timings.trio_select_ms}ms`);
      
      if (racingTrio.length === 0) {
        return new Response(JSON.stringify({ error: 'No eligible models in pool' }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }
      
      // If only one model eligible, skip racing
      if (racingTrio.length === 1) {
        const singleModel = racingTrio[0].model;
        console.log(`🎯 Single model eligible, skipping race: ${singleModel}`);
        
        if (conversation_id) {
          await saveConversationModel(supabase, conversation_id, singleModel, poolName);
        }
        
        return await handleStreaming(
          singleModel,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          reasoning,
          openRouterKey,
          supabaseUrl,
          model,
          false,
          poolName,
          pool.length
        );
      }
      
      // Race the trio!
      try {
        const raceCallStart = Date.now();
        timings.race_call_start_ms = raceCallStart - raceStartTime;
        console.log(`⏱️ TIMING: race_call_start=${timings.race_call_start_ms}ms (time before raceModels)`);
        
        const { model: winningModel, reader: winningReader, ttftMs, firstData } = await raceModels(
          racingTrio,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          reasoning,
          openRouterKey,
          supabaseUrl,
          supabase,
          poolName,
          timings
        );
        
        timings.race_complete_ms = Date.now() - raceStartTime;
        timings.race_duration_ms = Date.now() - raceCallStart;
        console.log(`⏱️ TIMING: race_complete=${timings.race_complete_ms}ms, race_duration=${timings.race_duration_ms}ms`);
        
        // Save winning model for conversation
        if (conversation_id) {
          await saveConversationModel(supabase, conversation_id, winningModel, poolName);
        }
        
        // Stream the winning response to client
        const encoder = new TextEncoder();
        const modelsRaced = racingTrio.length;
        const streamStartTime = Date.now();
        timings.stream_start_ms = streamStartTime - raceStartTime;
        console.log(`⏱️ TIMING: stream_start=${timings.stream_start_ms}ms`);
        
        const stream = new ReadableStream({
          async start(controller) {
            try {
              // Use the reader we already have from the race (can't call getReader twice!)
              const reader = winningReader;
              const decoder = new TextDecoder();
              // Start with the buffer we already read during racing
              let buffer = firstData;
              let firstEnqueueTime: number | null = null;
              
              // Process the firstData buffer immediately
              console.log(`⏱️ TIMING: processing firstData buffer (${firstData.length} chars)`);
              
              // Helper to process buffer lines
              const processBuffer = () => {
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                return lines;
              };
              
              // Helper to process a single line
              const processLine = (line: string) => {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data === '[DONE]') {
                    return;
                  }
                  
                  try {
                    const parsed = JSON.parse(data);
                    // Include metadata
                    parsed.requested_model = model;
                    parsed.actual_model = winningModel;
                    parsed.pool_name = poolName;
                    parsed.pool_size = pool.length;
                    parsed.racing_ttft_ms = ttftMs;
                    parsed.models_raced = modelsRaced;
                    
                    // Track first enqueue timing
                    if (firstEnqueueTime === null) {
                      firstEnqueueTime = Date.now() - streamStartTime;
                      timings.first_enqueue_to_client_ms = firstEnqueueTime;
                      console.log(`⏱️ TIMING: first_enqueue_to_client=${firstEnqueueTime}ms`);
                    }
                    parsed.timings = timings;
                    
                    // Adjust usage to reflect TRUE cost (all racing models consumed input tokens)
                    if (parsed.usage && parsed.usage.prompt_tokens) {
                      const winnerPromptTokens = parsed.usage.prompt_tokens;
                      const winnerCompletionTokens = parsed.usage.completion_tokens || 0;
                      parsed.usage.prompt_tokens = winnerPromptTokens * modelsRaced;
                      parsed.usage.total_tokens = parsed.usage.prompt_tokens + winnerCompletionTokens;
                      parsed.usage.winner_prompt_tokens = winnerPromptTokens;
                      parsed.usage.winner_completion_tokens = winnerCompletionTokens;
                      console.log(`📊 Usage adjusted: ${winnerPromptTokens} input × ${modelsRaced} models = ${parsed.usage.prompt_tokens} total input tokens`);
                    }
                    
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                  } catch (e) {
                    controller.enqueue(encoder.encode(`${line}\n`));
                  }
                }
              };
              
              // Process any complete lines already in firstData buffer
              let lines = processBuffer();
              for (const line of lines) {
                processLine(line);
              }
              
              // Continue reading from the stream
              while (true) {
                const { done, value } = await reader.read();
                
                if (done) {
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  controller.close();
                  break;
                }

                buffer += decoder.decode(value, { stream: true });
                lines = processBuffer();
                
                for (const line of lines) {
                  processLine(line);
                }
              }
            } catch (error) {
              console.error('Streaming race winner error:', error);
              controller.error(error);
            }
          }
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
        
      } catch (error) {
        console.error('❌ Trio racing failed:', error);
        
        // Fallback to random model
        const fallbackModel = pool[Math.floor(Math.random() * pool.length)];
        console.log(`🔄 Falling back to random model: ${fallbackModel}`);
        
        return await handleStreaming(
          fallbackModel,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          cappedReasoning,
          Deno.env.get('OPENROUTER_API_KEY')!,
          supabaseUrl,
          model,
          false,
          poolName,
          pool.length
        );
      }
    }
    
    // For non-streaming, use selected model or pick random from pool
    const actualModel = selectedModel || pool[Math.floor(Math.random() * pool.length)];
    const isCerebras = selectedIsCerebras;

    // Handle CoT steps (non-streaming)
    let finalResponse: any;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Helper function to make API call to appropriate provider
    async function makeApiCall(body: any): Promise<globalThis.Response> {
      if (isCerebras) {
        console.log(`⚡ Calling Cerebras API with model: ${actualModel}`);
        
        // Build Cerebras request body - Cerebras is OpenAI-compatible but doesn't support some params
        // See: https://inference-docs.cerebras.ai/resources/openai
        const cerebrasBody: any = {
          model: body.model,
          messages: body.messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          seed: body.seed,
        };
        
        // Add tools if provided - Cerebras supports tool calling
        // See: https://inference-docs.cerebras.ai/capabilities/tool-use
        if (body.tools && body.tools.length > 0) {
          cerebrasBody.tools = body.tools;
          // Note: parallel_tool_calls is NOT supported by Cerebras - causes 400 error
        }
        if (body.tool_choice) {
          cerebrasBody.tool_choice = body.tool_choice;
        }
        
        // Add response_format if provided - Cerebras supports structured outputs
        // See: https://inference-docs.cerebras.ai/capabilities/structured-outputs
        // Important: Cerebras requires additionalProperties: false for all objects with required
        if (body.response_format) {
          // Transform schema to be Cerebras-compatible
          if (body.response_format.type === 'json_schema' && body.response_format.json_schema?.schema) {
            const transformedSchema = transformSchemaForCerebras(body.response_format.json_schema.schema);
            cerebrasBody.response_format = {
              type: 'json_schema',
              json_schema: {
                name: body.response_format.json_schema.name || 'response',
                strict: true,
                schema: transformedSchema
              }
            };
          } else {
            cerebrasBody.response_format = body.response_format;
          }
        }
        
        console.log(`📤 Cerebras request body:`, JSON.stringify(cerebrasBody, null, 2));
        
        return await fetch(CEREBRAS_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('CEREBRAS_API_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(cerebrasBody)
        });
      } else {
        return await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose Benchmark Suite'
          },
          body: JSON.stringify(body)
        });
      }
    }

    if (cotSteps === 1) {
      // Direct answer (no CoT)
      const requestBody: any = {
        model: actualModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        seed,
        tools,
        tool_choice,
      };
      
      // Add response_format if provided
      if (response_format) {
        requestBody.response_format = response_format;
      }
      
      // Add other params only for non-Cerebras (some params like parallel_tool_calls cause 400 on Cerebras)
      if (!isCerebras) {
        Object.assign(requestBody, otherParams);
      }

      const apiResponse = await makeApiCall(requestBody);

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        const provider = isCerebras ? 'Cerebras' : 'OpenRouter';
        console.error(`${provider} API error:`, apiResponse.status, errorText);
        console.error(`Request body was:`, JSON.stringify(requestBody, null, 2));
        
        // Try to parse error for more details
        let errorDetails = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetails = JSON.stringify(errorJson, null, 2);
          console.error(`${provider} error details:`, errorJson);
        } catch (e) {
          // errorText is not JSON, keep as-is
        }
        
        return new Response(JSON.stringify({ 
          error: `${provider} API error`,
          status: apiResponse.status,
          details: errorDetails 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: apiResponse.status,
        });
      }

      finalResponse = await apiResponse.json();
      totalPromptTokens = finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens = finalResponse.usage?.completion_tokens || 0;

    } else {
      // Multi-step CoT (tool calls not supported with CoT currently)
      const thinkingMessages = [...messages];
      const intermediateResponses = [];
      const provider = isCerebras ? 'Cerebras' : 'OpenRouter';

      // Thinking steps (N-1 steps)
      for (let i = 0; i < cotSteps - 1; i++) {
        const thinkingPrompt = {
          role: "system",
          content: `Think step by step. You have ${cotSteps - 1} thinking steps before giving your final answer. This is thinking step ${i + 1}. Show your reasoning.`
        };

        const stepMessages = [...thinkingMessages, thinkingPrompt];

        const stepResponse = await makeApiCall({
          model: actualModel,
          messages: stepMessages,
          temperature,
          max_tokens: maxTokens,
          seed,
        });

        if (!stepResponse.ok) {
          const errorText = await stepResponse.text();
          console.error(`${provider} API error in CoT step:`, stepResponse.status, errorText);
          return new Response(JSON.stringify({ 
            error: `${provider} API error in CoT step`,
            details: errorText 
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: stepResponse.status,
          });
        }

        const stepData = await stepResponse.json();
        intermediateResponses.push(stepData);
        
        // Add assistant's thinking to context
        if (stepData.choices?.[0]?.message) {
          thinkingMessages.push(stepData.choices[0].message);
        }

        totalPromptTokens += stepData.usage?.prompt_tokens || 0;
        totalCompletionTokens += stepData.usage?.completion_tokens || 0;
      }

      // Final answer step
      const finalPrompt = {
        role: "system",
        content: "Based on your thinking above, now provide your final answer."
      };
      const finalMessages = [...thinkingMessages, finalPrompt];

      const finalApiResponse = await makeApiCall({
        model: actualModel,
        messages: finalMessages,
        temperature,
        max_tokens: maxTokens,
        seed,
      });

      if (!finalApiResponse.ok) {
        const errorText = await finalApiResponse.text();
        console.error(`${provider} API error in final step:`, finalApiResponse.status, errorText);
        return new Response(JSON.stringify({ 
          error: `${provider} API error in final step`,
          details: errorText 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: finalApiResponse.status,
        });
      }

      finalResponse = await finalApiResponse.json();
      totalPromptTokens += finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens += finalResponse.usage?.completion_tokens || 0;
    }

    // Include actual selected model for debugging (unmasked)
    // The requested model alias is preserved in a separate field
    finalResponse.requested_model = model;
    finalResponse.actual_model = actualModel;
    finalResponse.pool_name = poolName;
    finalResponse.pool_size = pool.length;

    // Calculate cost
    const costCents = calculateCost(totalPromptTokens, totalCompletionTokens, actualModel);

    // Log usage
    await logUsage(supabase, authInfo.apiKeyId, authInfo.userId, { 
      model, 
      messages, 
      temperature,
      max_tokens: maxTokens,
      seed,
      tools,
      tool_choice,
      cot_steps: cotSteps 
    }, finalResponse, costCents, cotSteps);

    // Return response
    return new Response(JSON.stringify(finalResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error('Rose completions endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: errorMessage 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

