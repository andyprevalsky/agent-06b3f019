/**
 * Runtime handler for the Rose completions endpoint.
 *
 * This is the thin orchestration layer that routes incoming requests to the
 * right sub-flow:
 *   - Browser-use requests (task + browser_state, with claude / model_seed /
 *     trio-racing sub-modes)
 *   - Chat completions with claude_token passthrough (direct Anthropic call
 *     using a user's Claude subscription; falls back to racing on failure)
 *   - Direct model passthrough (for testing, bypasses racing)
 *   - model_preference / model_seed fast-path (bypasses racing)
 *   - Trio racing or waterfall streaming (default for streaming)
 *   - Non-streaming chain-of-thought completion
 *
 * Heavy provider / racing / streaming / transform logic lives in the service
 * modules this file imports. `handleCompletionsRequest` itself is just the
 * request-level state machine that picks the right sub-flow and threads the
 * shared context (auth, supabase client, request id, timings).
 */

// deno-lint-ignore-file no-explicit-any

import { createClient } from 'npm:@supabase/supabase-js@~2.39.3';

import { randomUUID } from '../../../providers/crypto.ts';
import { slog } from '../../../providers/logger.ts';
import {
  ANTHROPIC_MAX_ANYOF_BRANCHES,
  corsHeaders,
  getOpenRouterApiKey,
  getProdSupabaseServiceKey,
  getProdSupabaseUrl,
  MODEL_POOLS,
  WATERFALL_POOLS,
} from '../config.ts';
import type { BrowserUseRequest, ModelPreference } from '../types.ts';
import {
  filterPoolByFileSize,
  getMaxBase64FileSizeBytes,
  isBrowserUseRequest,
  truncateForLogging,
} from '../utils.ts';
import {
  getCachedLatencies,
  getConversationModel,
  logUsage,
  saveConversationModel,
  validateApiKey,
} from '../repo.ts';
import { countToolTypes, isAnthropicModel } from './anthropic.ts';
import { handleBrowserUseRequest } from './browser-use.ts';
import { tryClaudeTokenPassthrough } from './claude-token.ts';
import { runCompletionOrCot } from './cot.ts';
import { calculateCost, selectModel } from './cost.ts';
import { waterfallStream } from './racing.ts';
import { handleStreaming } from './streaming.ts';
import { runTrioRaceStream } from './trio-stream.ts';
import { getMessagesForModel } from './vision.ts';

/**
 * Main handler for the Rose completions endpoint.
 *
 * Receives a Fetch `Request`, dispatches to the appropriate sub-flow, and
 * returns a Fetch `Response`. Never throws — all errors are caught and
 * translated to JSON responses with the appropriate status code.
 */
export async function handleCompletionsRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Extract request ID from header (sent by agent) or generate one
  const requestId = req.headers.get('x-request-id') || randomUUID().slice(0, 8);
  const agentId = req.headers.get('x-agent-id') || undefined;
  const callSite = req.headers.get('x-call-site') || undefined;
  slog('info', 'REQUEST START', { request_id: requestId, agent_id: agentId, call_site: callSite });

  try {
    // Extract API key from header
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      slog('info', `[${requestId}] Missing x-api-key header`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      return new Response(JSON.stringify({ error: 'Missing x-api-key header' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    // Initialize Supabase client (prod endpoint; getters fall back to hardcoded
    // prod values when PROD_* env vars are unset so local dev still works).
    const supabaseUrl = getProdSupabaseUrl();
    const supabase = createClient(supabaseUrl, getProdSupabaseServiceKey());

    // Validate API key
    slog('info', `[${requestId}] Validating API key...`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    const authInfo = await validateApiKey(apiKey, supabase);
    if (!authInfo) {
      slog('info', `[${requestId}] Invalid API key`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }
    slog('info', `[${requestId}] API key validated for userId: ${authInfo.userId}`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });

    // Parse request body (raw first for browser-use detection)
    const rawBody = await req.json();

    // ============================================
    // HANDLE BROWSER-USE REQUESTS (EARLY)
    // Browser-use has different format: task + browser_state instead of messages
    // ============================================
    if (isBrowserUseRequest(rawBody)) {
      return handleBrowserUseRequest({
        rawBody: rawBody as BrowserUseRequest,
        requestId,
        agentId,
        callSite,
        authInfo,
        supabase,
        supabaseUrl,
      });
    }

    // ============================================
    // STANDARD CHAT COMPLETION FORMAT
    // ============================================
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
      reasoning, // OpenRouter reasoning config: { max_tokens: number }
      model_seed, // Optional: index into model pool for testing
      model_preference, // Optional: 'SMART' | 'FAST' | 'CHEAP' for hardcoded model selection
      conversation_id, // Optional: ensures same model used for entire conversation
      claude_token, // Optional: user's Claude OAuth token for direct Anthropic call (skips racing, $0 cost)
      skip_cache, // Optional: disable prompt caching (saves 1.25x write cost for single-use calls)
      ...otherParams
    } = rawBody;

    const cotSteps = cot_steps || 1;
    const maxTokens = max_tokens;
    const messages = originalMessages;

    // Log incoming messages for debugging
    slog(
      'info',
      `[${requestId}] Chat completion request for model: ${model}${
        skip_cache ? ' (skip_cache)' : ''
      }`,
      { request_id: requestId, agent_id: agentId, call_site: callSite },
    );
    slog('info', `[${requestId}] Received ${messages?.length || 0} messages:`, {
      data: JSON.stringify(truncateForLogging(messages), null, 2),
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });

    // Default reasoning tokens to 256 if reasoning is enabled but no max_tokens specified
    const DEFAULT_REASONING_TOKENS = 256;
    let cappedReasoning = reasoning;
    if (reasoning && !reasoning.max_tokens) {
      cappedReasoning = { ...reasoning, max_tokens: DEFAULT_REASONING_TOKENS };
      slog('info', `Setting default reasoning tokens: ${DEFAULT_REASONING_TOKENS}`);
    }

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing required field: model' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid required field: messages' }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        },
      );
    }

    // Normalize pool name
    let poolName = model.toLowerCase();
    if (poolName.startsWith('rose-labs/')) {
      poolName = poolName.replace('rose-labs/', '');
    }

    // ============================================
    // CLAUDE TOKEN PASSTHROUGH: Direct Anthropic call using user's Claude subscription ($0 cost)
    // If it fails, fall through to normal racing.
    // ============================================
    let claudeTokenError: string | undefined; // Set when claude_token call fails, threaded to racing response
    const isClaudeTokenPool = poolName === 'rose-1-ultra' || poolName === 'rose-ultra' ||
      poolName === 'rose-1-lite' || poolName === 'rose-lite';
    if (claude_token && isClaudeTokenPool) {
      const result = await tryClaudeTokenPassthrough({
        requestId,
        agentId,
        callSite,
        claude_token,
        poolName,
        model,
        messages,
        temperature,
        maxTokens,
        seed,
        stream,
        tools,
        tool_choice,
        response_format,
        cappedReasoning,
        skip_cache,
        supabase,
        supabaseUrl,
      });
      if (result.response) return result.response;
      claudeTokenError = result.claudeTokenError;
      // Fall through to normal racing path
    }

    // Check if it's a direct model passthrough (for testing)
    const DIRECT_MODEL_PREFIXES = [
      'openai/',
      'google/',
      'anthropic/',
      'deepseek/',
      'qwen/',
      'x-ai/',
      'meta/',
      'moonshotai/',
    ];
    const isDirectModel = DIRECT_MODEL_PREFIXES.some((prefix) =>
      model.toLowerCase().startsWith(prefix)
    );

    const pool = MODEL_POOLS[poolName];
    if (!pool && !isDirectModel) {
      return new Response(
        JSON.stringify({
          error: `Unknown model: ${model}. Use 'rose-labs/rose-1-lite' or 'rose-labs/rose-1-ultra'`,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        },
      );
    }

    // Handle direct model passthrough (bypass racing)
    if (isDirectModel) {
      slog('info', `Direct model passthrough: ${model}`);
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
          getOpenRouterApiKey(),
          supabaseUrl,
          model,
          false, // isCerebras
          'direct',
          1,
        );
      }
      // Non-streaming direct passthrough - handle here instead of falling through
      // Transform messages for vision models
      const modelMessages = getMessagesForModel(messages, model);

      const requestBody: any = {
        model,
        messages: modelMessages,
        temperature,
        max_tokens: maxTokens,
        seed,
        tools,
        tool_choice,
      };

      if (response_format) {
        requestBody.response_format = response_format;
      }

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getOpenRouterApiKey()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': supabaseUrl,
          'X-Title': 'Rose Direct Passthrough',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        slog('error', 'OpenRouter API error:', { data: [response.status, errorText] });
        return new Response(
          JSON.stringify({
            error: 'OpenRouter API error',
            status: response.status,
            details: errorText,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: response.status,
          },
        );
      }

      const finalResponse = await response.json();
      finalResponse.requested_model = model;
      finalResponse.actual_model = model;
      finalResponse.pool_name = 'direct';
      finalResponse.pool_size = 1;

      return new Response(JSON.stringify(finalResponse), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
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
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Invalid model',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
          },
        );
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
          getOpenRouterApiKey(),
          supabaseUrl,
          model,
          selection.isCerebras,
          selection.poolName,
          selection.poolSize,
          undefined,
          undefined,
          undefined, // claudeAuth, skipCache, stallConfig
          claudeTokenError,
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
    let shouldRepinConversationModel = false;
    if (conversation_id && !selectedModel) {
      const existingModel = await getConversationModel(supabase, conversation_id);
      if (existingModel && pool.includes(existingModel)) {
        slog('info', `Using existing model for conversation: ${existingModel}`);

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
            getOpenRouterApiKey(),
            supabaseUrl,
            model,
            false, // Not Cerebras
            poolName,
            pool.length,
            undefined,
            undefined,
            undefined, // claudeAuth, skipCache, stallConfig
            claudeTokenError,
          );
        }

        selectedModel = existingModel;
        selectedIsCerebras = false;
      } else if (existingModel) {
        slog('warn', `Pinned model ${existingModel} no longer in pool ${poolName}, reselecting`);
        shouldRepinConversationModel = true;
      }
    }

    // Handle streaming with trio racing or waterfall
    if (stream && !selectedModel) {
      const openRouterKey = getOpenRouterApiKey();

      // ===== SHARED POOL FILTERING =====
      // Apply filters before both waterfall and racing paths

      // Filter out Anthropic models if schema has 9+ tool types (Anthropic limit is 8 anyOf branches)
      let effectivePool = pool;
      if (response_format) {
        const toolCount = countToolTypes(response_format);
        if (toolCount >= ANTHROPIC_MAX_ANYOF_BRANCHES + 1) {
          const anthropicModels = pool.filter((m) => isAnthropicModel(m));
          if (anthropicModels.length > 0) {
            slog(
              'info',
              `Schema has ${toolCount} tool types (limit: ${ANTHROPIC_MAX_ANYOF_BRANCHES}), excluding Anthropic models: ${
                anthropicModels.join(', ')
              }`,
            );
            effectivePool = pool.filter((m) => !isAnthropicModel(m));
          }
        }
      }

      // Filter out models that can't handle file attachments based on size
      const maxFileSize = getMaxBase64FileSizeBytes(messages);
      if (maxFileSize > 0) {
        const { filtered, excluded } = filterPoolByFileSize(effectivePool, maxFileSize);
        effectivePool = filtered;
        if (excluded.length > 0) {
          const sizeMb = (maxFileSize / 1024 / 1024).toFixed(2);
          slog('info', `File size ${sizeMb}MB, excluded models: ${excluded.join(', ')}`);
        }
      }

      if (effectivePool.length === 0) {
        return new Response(
          JSON.stringify({ error: 'No eligible models in pool after filtering' }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          },
        );
      }

      // ===== WATERFALL MODE =====
      // For pools configured for waterfall (sequential fallback), skip trio racing entirely.
      // This sends input tokens to only ONE model per request (saves cost vs racing 3 models).
      if (WATERFALL_POOLS.has(poolName)) {
        slog('info', `Waterfall mode for pool: ${poolName} (${effectivePool.length} models)`);
        return await waterfallStream(
          effectivePool,
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
          poolName,
          effectivePool.length,
          conversation_id,
          supabase,
          claudeTokenError,
        );
      }

      // ===== TRIO RACING MODE =====
      // Get cached latencies for this pool
      const cacheStartTime = Date.now();
      const { latencies: cachedLatencies, needsRefresh, missingModels } = await getCachedLatencies(
        supabase,
        poolName,
        pool,
      );
      slog('info', `TIMING: cache_lookup=${Date.now() - cacheStartTime}ms`);

      return await runTrioRaceStream({
        effectivePool,
        pool,
        poolName,
        messages,
        temperature,
        maxTokens,
        seed,
        tools,
        tool_choice,
        response_format,
        reasoning,
        cappedReasoning,
        openRouterKey,
        supabaseUrl,
        model,
        conversation_id,
        supabase,
        cachedLatencies,
        needsRefresh,
        missingModels,
        claudeTokenError,
      });
    }

    // For non-streaming, use selected model or pick random from pool
    const actualModel = selectedModel || pool[Math.floor(Math.random() * pool.length)];
    const isCerebras = selectedIsCerebras;

    // Persist reselected model after stale pin was detected
    if (conversation_id && shouldRepinConversationModel && !selectedModel) {
      await saveConversationModel(supabase, conversation_id, actualModel, poolName);
    }

    // Handle CoT steps (non-streaming)
    const cotResult = await runCompletionOrCot({
      actualModel,
      isCerebras,
      messages,
      temperature,
      maxTokens,
      seed,
      tools,
      tool_choice,
      response_format,
      otherParams,
      cotSteps,
      supabaseUrl,
    });
    if (cotResult.errorResponse) return cotResult.errorResponse;
    const finalResponse = cotResult.finalResponse;
    const totalPromptTokens = cotResult.totalPromptTokens || 0;
    const totalCompletionTokens = cotResult.totalCompletionTokens || 0;

    // Include actual selected model for debugging (unmasked)
    // The requested model alias is preserved in a separate field
    finalResponse.requested_model = model;
    finalResponse.actual_model = actualModel;
    finalResponse.pool_name = poolName;
    finalResponse.pool_size = pool.length;
    finalResponse.request_id = requestId;
    if (claudeTokenError) finalResponse.claude_token_error = claudeTokenError;

    // Calculate cost
    const costCents = calculateCost(totalPromptTokens, totalCompletionTokens, actualModel);

    // Log usage
    await logUsage(
      supabase,
      authInfo.apiKeyId,
      authInfo.userId,
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        seed,
        tools,
        tool_choice,
        cot_steps: cotSteps,
      },
      finalResponse,
      costCents,
      cotSteps,
    );

    // Return response
    slog(
      'info',
      `[${requestId}] Chat completion success: model=${actualModel}, tokens=${
        totalPromptTokens + totalCompletionTokens
      }`,
      { request_id: requestId, agent_id: agentId, call_site: callSite },
    );
    slog('info', `[${requestId}] ========== REQUEST END (success) ==========\n`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    return new Response(JSON.stringify(finalResponse), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    slog('error', `[${requestId}] Rose completions endpoint error:`, {
      data: error,
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    slog('info', `[${requestId}] ========== REQUEST END (error) ==========\n`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: errorMessage,
        request_id: requestId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    );
  }
}
