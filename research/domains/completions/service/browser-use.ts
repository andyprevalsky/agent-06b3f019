/**
 * Browser-use sub-flow for the Rose completions endpoint.
 *
 * Browser-use uses a distinct request shape (task + browser_state + action_history)
 * and a dedicated provider pool (`rose-1-browser-use`). This module owns:
 *   - the three sub-modes for a browser-use request
 *       MODE 0 (claude): direct Anthropic Opus 4.7 with prompt caching
 *       MODE 1 (model_seed): forced provider index for testing
 *       MODE 2 (default):    trio racing by completion across eligible providers
 *   - per-provider dispatch (browser-use native / Yutori / Anthropic CUA /
 *     Anthropic direct / generic OpenRouter) with request/response logging
 *   - screenshot eligibility filtering, cached-latency trio selection,
 *     and single-model fast-path
 *
 * The handler composes a `BrowserUseContext` from request-level state and
 * returns a Fetch `Response`. All errors are caught and mapped to JSON
 * responses — the handler never throws.
 */

// deno-lint-ignore-file no-explicit-any

import { slog } from '../../../providers/logger.ts';
import {
  ANTHROPIC_API_URL,
  BU_DEFAULT_LATENCY_MS,
  BU_MAX_DELAY_CAP_MS,
  BU_MAX_LATENCY_CAP_MS,
  BU_RACE_TIMEOUT_MS,
  corsHeaders,
  DOM_ONLY_MODELS,
  getAnthropicApiKey,
  getBrowserUseApiKey,
  getOpenRouterApiKey,
  getYutoriApiKey,
  MODEL_POOLS,
  TRIO_SIZE,
} from '../config.ts';
import type { BrowserUseContext, UnifiedAction } from '../types.ts';
import { extractJSON, truncateForLogging, withTimeout } from '../utils.ts';
import { getCachedLatencies } from '../repo.ts';
import { isAnthropicModel, transformMessagesForAnthropic } from './anthropic.ts';
import { callAnthropicCUA, normalizeAnthropicCUAResponse } from './anthropic-cua.ts';
import { handleClaudeMode } from './browser-use-claude.ts';
import { callBrowserUseLLM, transformToBrowserUseFormat } from './browser-use-native.ts';
import { getAnthropicModelName } from './cost.ts';
import { callGenericLLM, normalizeBrowserUseResponse } from './generic.ts';
import { raceBrowserUseModels, selectRacingTrio } from './racing.ts';
import { callYutoriLLM, normalizeYutoriResponse } from './yutori.ts';

/**
 * Build the `callProvider` dispatcher closure that the three sub-modes all
 * share. Each provider has its own auth, transform, and normalization path —
 * all of them converge on a `{ action, ttftMs, actualModel, usage }` shape.
 */
function makeCallProvider(
  ctx: BrowserUseContext,
): (
  provider: string,
  providerIndex: number,
  signal?: AbortSignal,
) => Promise<{
  action: UnifiedAction;
  ttftMs: number;
  actualModel: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const { rawBody: browserUseReq, requestId, agentId, callSite, supabaseUrl } = ctx;
  return async (provider, providerIndex, signal) => {
    // Log the full request (with truncated screenshots)
    slog('info', `📤 [${requestId}] [${provider}] FULL REQUEST:`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    slog('info', `[${requestId}] [${provider}] FULL REQUEST body`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
      data: JSON.stringify(
        truncateForLogging({
          requestId,
          provider,
          providerIndex,
          task: browserUseReq.task,
          browser_state: browserUseReq.browser_state,
          action_history: browserUseReq.action_history,
          model_seed: browserUseReq.model_seed,
        }),
        null,
        2,
      ),
    });

    let result: {
      response?: any;
      ttftMs: number;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    let normalizedAction: UnifiedAction;
    let actualModel: string;

    if (provider === 'browser-use') {
      const browserUseApiKey = getBrowserUseApiKey();
      if (!browserUseApiKey) throw new Error('BROWSER_USE_API_KEY not configured');

      slog('info', `[${requestId}] [${provider}] Calling browser-use API...`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      result = await callBrowserUseLLM(browserUseReq, browserUseApiKey, signal);
      normalizedAction = normalizeBrowserUseResponse(result.response);
      actualModel = 'browser-use/bu-1-0';
    } else if (provider === 'yutori/n1') {
      const yutoriApiKey = getYutoriApiKey();
      if (!yutoriApiKey) throw new Error('YUTORI_API_KEY not configured');
      if (!browserUseReq.browser_state.screenshot) {
        throw new Error('Yutori requires screenshot');
      }

      slog('info', `[${requestId}] [${provider}] Calling Yutori API...`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      result = await callYutoriLLM(browserUseReq, yutoriApiKey, signal);
      normalizedAction = normalizeYutoriResponse(
        result.response,
        browserUseReq.browser_state.viewport,
      );
      actualModel = 'yutori/n1';
    } else if (provider === 'anthropic/claude-cua') {
      const anthropicApiKey = getAnthropicApiKey();
      if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
      if (browserUseReq.browser_state.screenshot?.startsWith('http')) {
        throw new Error('Anthropic CUA requires base64 screenshot');
      }

      slog('info', `[${requestId}] [${provider}] Calling Anthropic CUA API...`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      result = await callAnthropicCUA(browserUseReq, anthropicApiKey);
      normalizedAction = normalizeAnthropicCUAResponse(result.response);
      actualModel = 'anthropic/claude-sonnet-4-cua';
    } else if (isAnthropicModel(provider)) {
      // Direct Anthropic API call (matching streaming race pattern)
      const anthropicKey = getAnthropicApiKey();
      if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured');

      const isDomOnly = DOM_ONLY_MODELS.includes(provider);
      const { messages } = transformToBrowserUseFormat(browserUseReq, {
        includeScreenshot: !isDomOnly,
      });
      const { system, messages: anthropicMessages } = transformMessagesForAnthropic(messages);
      const anthropicModel = getAnthropicModelName(provider);

      slog(
        'info',
        `[${requestId}] [${provider}] Calling Anthropic API directly (model: ${anthropicModel})...`,
        { request_id: requestId, agent_id: agentId, call_site: callSite },
      );

      const anthropicBody: any = {
        model: anthropicModel,
        messages: anthropicMessages,
        max_tokens: 1024,
        temperature: 0.3,
      };
      if (system) anthropicBody.system = system;
      // No output_format — system prompt instructs JSON format,
      // same approach as browser-use and yutori providers

      slog('info', `[Anthropic BU] Request to ${anthropicModel}:`, {
        data: JSON.stringify(truncateForLogging(anthropicBody), null, 2),
      });

      const startTime = Date.now();
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(anthropicBody),
        signal,
      });

      const ttftMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        slog('error', `Anthropic BU API error:`, { data: [response.status, errorText] });
        throw new Error(`Anthropic BU API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      slog('info', 'Anthropic BU raw response:', {
        data: JSON.stringify(truncateForLogging(data), null, 2),
      });

      // Extract text content from Anthropic response format
      const textContent = data.content?.find((c: any) => c.type === 'text')?.text || '';
      let completion: any;
      try {
        completion = typeof textContent === 'string' ? JSON.parse(textContent) : textContent;
      } catch {
        // JSON.parse failed — try extractJSON to handle markdown-wrapped JSON (```json ... ```)
        const extracted = extractJSON(textContent);
        completion = extracted || { action: [], thinking: textContent };
      }

      const usage = {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      };

      result = { response: { completion }, ttftMs, usage };
      normalizedAction = normalizeBrowserUseResponse(result.response);
      actualModel = provider;
    } else {
      // Generic LLM via OpenRouter (e.g. openai/gpt-5.2)
      const openRouterKey = getOpenRouterApiKey();
      if (!openRouterKey) throw new Error('OPENROUTER_API_KEY not configured');

      slog('info', `[${requestId}] [${provider}] Calling OpenRouter API...`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      result = await callGenericLLM(
        browserUseReq,
        provider,
        openRouterKey,
        supabaseUrl,
        signal,
      );
      normalizedAction = normalizeBrowserUseResponse(result.response);
      actualModel = provider;
    }

    slog('info', `[${requestId}] [${provider}] FULL RESPONSE (ttft=${result.ttftMs}ms)`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
      data: JSON.stringify(truncateForLogging(result.response), null, 2),
    });
    slog('info', `[${requestId}] [${provider}] NORMALIZED ACTION`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
      data: JSON.stringify(normalizedAction, null, 2),
    });

    return {
      action: normalizedAction,
      ttftMs: result.ttftMs,
      actualModel,
      usage: result.usage,
    };
  };
}

/** Model-seed mode: caller forces a specific provider index for A/B testing. */
async function handleModelSeedMode(
  ctx: BrowserUseContext,
  browserPool: readonly string[],
  callProvider: ReturnType<typeof makeCallProvider>,
): Promise<Response> {
  const { rawBody: browserUseReq, requestId, agentId, callSite } = ctx;
  const providerIndex = browserUseReq.model_seed ?? -1;

  if (providerIndex < 0 || providerIndex >= browserPool.length) {
    slog('info', `[${requestId}] model_seed ${providerIndex} out of range`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    return new Response(
      JSON.stringify({
        error:
          `model_seed ${providerIndex} out of range. Pool has ${browserPool.length} providers (0-${
            browserPool.length - 1
          })`,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      },
    );
  }

  const selectedProvider = browserPool[providerIndex];
  slog(
    'info',
    `[${requestId}] Browser-use provider (seeded): ${selectedProvider} (index: ${providerIndex})`,
    { request_id: requestId, agent_id: agentId, call_site: callSite },
  );

  try {
    const result = await callProvider(selectedProvider, providerIndex);

    slog(
      'info',
      `[${requestId}] Browser-use response: action=${result.action.action}, index=${result.action.index}`,
      { request_id: requestId, agent_id: agentId, call_site: callSite },
    );
    slog('info', `[${requestId}] ========== REQUEST END (success) ==========\n`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });

    return new Response(
      JSON.stringify({
        action: result.action,
        requested_model: browserUseReq.model,
        actual_model: result.actualModel,
        pool_name: 'rose-1-browser-use',
        pool_size: browserPool.length,
        provider_index: providerIndex,
        ttft_ms: result.ttftMs,
        usage: result.usage,
        request_id: requestId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  } catch (error) {
    slog('error', `[${requestId}] Browser-use (seeded) failed:`, {
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
    return new Response(
      JSON.stringify({
        error: 'Browser-use request failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        request_id: requestId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    );
  }
}

/**
 * Default mode: completion-based trio racing across eligible providers.
 * Screenshot requirement filters the pool; cached latencies drive trio
 * selection and delay equalization. Single-eligible-model short-circuits
 * the race.
 */
async function handleRacingMode(
  ctx: BrowserUseContext,
  browserPool: readonly string[],
  callProvider: ReturnType<typeof makeCallProvider>,
): Promise<Response> {
  const { rawBody: browserUseReq, requestId, agentId, callSite, supabase } = ctx;
  const buPoolName = 'rose-1-browser-use';
  const buTimings: Record<string, number> = {};
  const raceStartTime = Date.now();

  // Step 1: Filter pool by screenshot availability (yutori requires screenshot)
  const hasScreenshot = !!browserUseReq.browser_state.screenshot;
  const VISION_REQUIRED = new Set(['yutori/n1']);
  const eligiblePool = hasScreenshot
    ? [...browserPool]
    : browserPool.filter((m) => !VISION_REQUIRED.has(m));

  slog(
    'info',
    `[${requestId}] Eligible pool (${eligiblePool.length}/${browserPool.length}): ${
      eligiblePool.join(', ')
    }`,
    { request_id: requestId, agent_id: agentId, call_site: callSite },
  );
  if (!hasScreenshot && eligiblePool.length < browserPool.length) {
    slog('info', `[${requestId}] No screenshot - filtered out vision-only models`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
  }

  if (eligiblePool.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'No eligible browser-use models',
        request_id: requestId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    );
  }

  // Step 2: Get cached latencies (no probing for browser-use - too expensive)
  const { latencies: buCachedLatencies } = await getCachedLatencies(
    supabase,
    buPoolName,
    eligiblePool,
  );
  buTimings.cache_lookup_ms = Date.now() - raceStartTime;

  // Step 3: Select racing trio with browser-use config
  const racingTrio = selectRacingTrio(eligiblePool, buCachedLatencies, {
    maxLatencyCapMs: BU_MAX_LATENCY_CAP_MS,
    maxDelayCapMs: BU_MAX_DELAY_CAP_MS,
    defaultLatencyMs: BU_DEFAULT_LATENCY_MS,
    trioSize: TRIO_SIZE,
  });
  buTimings.trio_select_ms = Date.now() - raceStartTime;

  if (racingTrio.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'No eligible models after latency filtering',
        request_id: requestId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    );
  }

  // Step 4: Single model → direct call, skip racing overhead
  if (racingTrio.length === 1) {
    const singleModel = racingTrio[0].model;
    const poolIndex = browserPool.indexOf(singleModel);
    slog('info', `[${requestId}] Single model eligible, direct call: ${singleModel}`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });

    try {
      const result = await withTimeout(
        callProvider(singleModel, poolIndex),
        BU_RACE_TIMEOUT_MS,
        singleModel,
      );

      slog('info', `[${requestId}] Browser-use response: action=${result.action.action}`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      slog('info', `[${requestId}] ========== REQUEST END (success, single) ==========\n`, {
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });

      return new Response(
        JSON.stringify({
          action: result.action,
          requested_model: browserUseReq.model,
          actual_model: result.actualModel,
          pool_name: buPoolName,
          pool_size: browserPool.length,
          ttft_ms: result.ttftMs,
          usage: result.usage,
          request_id: requestId,
          racing: { models_raced: 1, racing_type: 'single' },
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    } catch (error) {
      slog('error', `[${requestId}] Single model failed:`, {
        data: error,
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      return new Response(
        JSON.stringify({
          error: 'Browser-use request failed',
          details: error instanceof Error ? error.message : 'Unknown error',
          request_id: requestId,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        },
      );
    }
  }

  // Step 5: RACE!
  try {
    const raceResult = await withTimeout(
      raceBrowserUseModels(
        racingTrio,
        callProvider,
        [...browserPool],
        supabase,
        buPoolName,
        requestId,
        buTimings,
      ),
      BU_RACE_TIMEOUT_MS,
      'browser-use-race',
    );

    buTimings.race_total_ms = Date.now() - raceStartTime;
    slog(
      'info',
      `[${requestId}] Race complete: winner=${raceResult.actualModel}, time=${raceResult.ttftMs}ms`,
      { request_id: requestId, agent_id: agentId, call_site: callSite },
    );
    slog('info', `[${requestId}] ========== REQUEST END (success, race) ==========\n`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });

    // Adjust usage for racing cost (all models consumed input tokens)
    let adjustedUsage = raceResult.usage;
    if (adjustedUsage && adjustedUsage.prompt_tokens) {
      adjustedUsage = {
        prompt_tokens: adjustedUsage.prompt_tokens * raceResult.modelsRaced,
        completion_tokens: adjustedUsage.completion_tokens || 0,
        total_tokens: (adjustedUsage.prompt_tokens * raceResult.modelsRaced) +
          (adjustedUsage.completion_tokens || 0),
      };
    }

    return new Response(
      JSON.stringify({
        action: raceResult.action,
        requested_model: browserUseReq.model,
        actual_model: raceResult.actualModel,
        pool_name: buPoolName,
        pool_size: browserPool.length,
        ttft_ms: raceResult.ttftMs,
        usage: adjustedUsage,
        request_id: requestId,
        racing: {
          models_raced: raceResult.modelsRaced,
          racing_type: 'completion_trio',
          trio: raceResult.racingModels.map((m) => ({
            model: m.model,
            latency_ms: m.latencyMs,
            delay_ms: m.delayMs,
          })),
          timings: buTimings,
        },
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  } catch (error) {
    slog('error', `[${requestId}] Browser-use race failed:`, {
      data: error,
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    slog('info', `[${requestId}] ========== REQUEST END (race failed) ==========\n`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });

    return new Response(
      JSON.stringify({
        error: 'Browser-use race failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        request_id: requestId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    );
  }
}

/**
 * Browser-use entry point. Logs the incoming request, validates the pool,
 * then dispatches to Claude mode / model_seed mode / racing mode.
 */
export function handleBrowserUseRequest(ctx: BrowserUseContext): Promise<Response> {
  const { rawBody: browserUseReq, requestId, agentId, callSite } = ctx;
  slog('info', `[${requestId}] Browser-use request detected for model: ${browserUseReq.model}`, {
    request_id: requestId,
    agent_id: agentId,
    call_site: callSite,
  });

  // Tracing: log action_history details
  slog('info', `[${requestId}] action_history count: ${browserUseReq.action_history.length}`, {
    request_id: requestId,
    agent_id: agentId,
    call_site: callSite,
  });
  if (browserUseReq.action_history.length > 0) {
    const lastAction = browserUseReq.action_history[browserUseReq.action_history.length - 1];
    slog('info', `[${requestId}] Last action:`, {
      data: {
        action: lastAction.action,
        hasThinking: !!lastAction.thinking,
        hasScreenshot: !!lastAction.screenshot,
        thinkingPreview: lastAction.thinking?.slice(0, 100),
      },
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
  }

  // Tracing: log screenshot metadata
  if (browserUseReq.browser_state.screenshot) {
    slog('info', `[${requestId}] Screenshot received:`, {
      data: {
        viewport:
          `${browserUseReq.browser_state.viewport.width}x${browserUseReq.browser_state.viewport.height}`,
        screenshotChars: browserUseReq.browser_state.screenshot.length,
        isBase64: !browserUseReq.browser_state.screenshot.startsWith('http'),
      },
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
  }

  // Get the browser-use pool
  const browserPool = MODEL_POOLS['rose-1-browser-use'];
  if (!browserPool) {
    slog('info', `[${requestId}] Browser-use pool not configured`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: 'Browser-use pool not configured',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        },
      ),
    );
  }

  const callProvider = makeCallProvider(ctx);

  // CLAUDE MODE: Direct Anthropic call with Claude Code credentials + prompt caching
  if (browserUseReq.mode === 'claude') {
    return handleClaudeMode(ctx);
  }

  // MODE 1: model_seed provided - direct call to specific provider (for testing)
  if (browserUseReq.model_seed !== undefined) {
    return handleModelSeedMode(ctx, browserPool, callProvider);
  }

  // MODE 2: No model_seed - completion-based trio racing
  return handleRacingMode(ctx, browserPool, callProvider);
}
