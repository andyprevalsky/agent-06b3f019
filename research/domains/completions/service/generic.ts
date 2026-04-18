/**
 * Generic OpenRouter LLM + background latency probes.
 *
 * - `callGenericLLM` calls an arbitrary OpenRouter model using the browser-use
 *   message format. Used by the browser-use racer for DOM-only/vision LLMs.
 * - `normalizeBrowserUseResponse` unpacks the various first-action shapes
 *   (nested, flat, semi-nested) into a UnifiedAction for the Python agent.
 * - `fireLatencyProbes` kicks off a streaming request per model to measure
 *   time-to-first-contentful-token, aborts the moment content arrives, and
 *   updates the latency cache in the background.
 */

// deno-lint-ignore-file no-explicit-any

import {
  ANTHROPIC_API_URL,
  DOM_ONLY_MODELS,
  LATENCY_PROBE_MAX_TOKENS,
  LATENCY_PROBE_MESSAGES,
} from '../config.ts';
import { updateLatencyCache } from '../repo.ts';
import type { BrowserUseRequest, SupabaseClient, UnifiedAction } from '../types.ts';
import { extractJSON, slog } from '../utils.ts';
import { transformToBrowserUseFormat } from './browser-use-native.ts';
import { getAnthropicModelName } from './cost.ts';
import { isAnthropicModel } from './anthropic.ts';

// Call generic LLM via OpenRouter using browser-use format
export async function callGenericLLM(
  req: BrowserUseRequest,
  model: string,
  openRouterKey: string,
  supabaseUrl: string,
  signal?: AbortSignal,
): Promise<
  {
    response: any;
    ttftMs: number;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }
> {
  // Check if this is a DOM-only model (no vision needed)
  const isDomOnly = DOM_ONLY_MODELS.includes(model);

  // transformToBrowserUseFormat already includes the dynamic system prompt
  // For DOM-only models, skip screenshot to reduce tokens and improve latency
  const { messages } = transformToBrowserUseFormat(req, { includeScreenshot: !isDomOnly });

  slog('info', `Generic LLM request to: ${model} (DOM-only: ${isDomOnly})`);
  slog('info', 'Messages count:', { data: messages.length });

  const startTime = Date.now();

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': supabaseUrl,
      'X-Title': 'Rose Browser Use',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    }),
    signal,
  });

  const ttftMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    slog('error', 'OpenRouter API error:', { data: [response.status, errorText] });
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  // Extract the content from OpenRouter response format
  const content = data.choices?.[0]?.message?.content;
  slog('info', 'Generic LLM raw content:', { data: content });

  // Parse JSON content and return in browser-use compatible format
  let completion: any;
  try {
    completion = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    completion = { action: [], thinking: content };
  }

  // Extract usage from OpenRouter response
  const usage = data.usage
    ? {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    }
    : undefined;

  return {
    response: { completion },
    ttftMs,
    usage,
  };
}

// Normalize browser-use response to unified action format
export function normalizeBrowserUseResponse(response: any): UnifiedAction {
  slog('info', 'Normalizing response:', { data: JSON.stringify(response, null, 2) });

  // browser-use returns { completion: { thinking, action: [...], ... }, usage }
  // or sometimes just the completion directly
  const completion = response.completion || response;

  // Check if completion is a string (raw LLM response)
  if (typeof completion === 'string') {
    // Try to extract JSON (handles markdown-wrapped JSON)
    const parsed = extractJSON(completion);
    if (parsed) {
      return normalizeBrowserUseResponse({ completion: parsed });
    }
    slog('info', 'Could not extract JSON from completion:', { data: completion.slice(0, 300) });
    throw new Error(
      `normalizeBrowserUseResponse: Could not extract JSON from completion: ${
        completion.slice(0, 200)
      }`,
    );
  }

  // Extract action array - it could be in different places
  const actions = completion.action;
  if (!actions || actions.length === 0) {
    // Model returned no actions - throw error to trigger provider failover
    slog('info', 'No actions in completion, triggering failover to next provider');
    throw new Error('normalizeBrowserUseResponse: No actions returned in completion');
  }

  const firstAction = actions[0];
  slog('info', 'First action:', { data: JSON.stringify(firstAction, null, 2) });

  // Action can be in different formats:
  // 1. { action_name: "click", index: 5 } - flat format
  // 2. { click: { index: 5 } } - nested format (browser-use native)
  // 3. { action_name: { ...params } } - semi-nested

  let actionName: string;
  let params: Record<string, any> = {};
  let index: number | undefined;

  if (firstAction.action_name) {
    // Format 1 or 3: has explicit action_name field
    actionName = firstAction.action_name;
    params = { ...firstAction };
    delete params.action_name;
    index = firstAction.index;
  } else {
    // Format 2: nested { click: { index: 5 } }
    const keys = Object.keys(firstAction);
    actionName = keys[0];
    params = firstAction[actionName] || {};
    index = params.index;
  }

  // Map action names to Python agent expected names
  // Browser-use native actions: search, navigate, go_back, wait, click, input, upload_file,
  // switch, close, extract, scroll, send_keys, find_text, screenshot, dropdown_options, select_dropdown, evaluate, done
  const actionNameMap: Record<string, string> = {
    'navigate': 'goto',
    'go_back': 'navback',
    'input': 'input_text',
    'send_keys': 'press_key',
    'switch': 'switch_tab',
    'close': 'close_tab',
    'done': 'attempt_completion',
  };

  const normalizedAction = actionNameMap[actionName] || actionName;

  // Validate action is one we support
  const validActions = [
    'click',
    'click_coordinates',
    'scroll',
    'wait',
    'extract',
    'evaluate',
    'dropdown_options',
    'select_dropdown',
    'screenshot',
    'find_text',
    'upload_file',
    'search',
    'goto',
    'navback',
    'input_text',
    'press_key',
    'switch_tab',
    'close_tab',
    'open_new_tab',
    'attempt_completion',
  ];
  if (!validActions.includes(normalizedAction)) {
    throw new Error(
      `normalizeBrowserUseResponse: Unknown action "${normalizedAction}" (raw: "${actionName}") - add to actionNameMap or validActions`,
    );
  }

  // Convert click_coordinates to click with coordinates
  if (normalizedAction === 'click_coordinates') {
    const x = params.x ?? params.coordinate_x;
    const y = params.y ?? params.coordinate_y;
    if (x === undefined || y === undefined) {
      throw new Error(
        `normalizeBrowserUseResponse: click_coordinates requires x and y, got: ${
          JSON.stringify(params)
        }`,
      );
    }
    return {
      action: 'click',
      thinking: completion.next_goal || completion.thinking,
      coordinates: { x, y },
      params: {},
    };
  }

  // Validate click action has required index (DOM-based models must return index)
  if (normalizedAction === 'click' && index === undefined) {
    throw new Error(
      `normalizeBrowserUseResponse: click action requires element index, got none. Raw action: ${
        JSON.stringify(firstAction)
      }`,
    );
  }

  // Normalize params to Python agent expected format
  const normalizedParams: Record<string, any> = {};

  // Handle different param formats
  if (params.url) normalizedParams.url = params.url;
  if (params.text) normalizedParams.text = params.text;
  if (params.typing_text) normalizedParams.text = params.typing_text; // Yutori format

  // File upload - filename can be at top level (firstAction) or in params
  if (firstAction.filename) normalizedParams.filename = firstAction.filename;
  else if (params.filename) normalizedParams.filename = params.filename;
  if (firstAction.file_path) normalizedParams.file_path = firstAction.file_path;
  else if (params.file_path) normalizedParams.file_path = params.file_path;

  // press_key: map 'keys' to 'key'
  if (params.key) normalizedParams.key = params.key;
  if (params.keys) normalizedParams.key = params.keys;

  // extract: map 'query' to 'instruction'
  if (params.instruction) normalizedParams.instruction = params.instruction;
  if (params.query) normalizedParams.instruction = params.query;
  if (params.extract_links !== undefined) normalizedParams.extract_links = params.extract_links;

  if (params.code) normalizedParams.code = params.code;

  // select_dropdown: map 'text' to 'value' (but text is also used for input_text)
  // Only map to 'value' for select_dropdown action
  if (normalizedAction === 'select_dropdown' && params.text) {
    normalizedParams.value = params.text;
  } else if (params.value) {
    normalizedParams.value = params.value;
  }

  if (params.tab_id) normalizedParams.tab_id = params.tab_id;
  if (params.message) normalizedParams.message = params.message;
  if (params.reasoning) normalizedParams.reasoning = params.reasoning;
  if (params.reason) normalizedParams.reason = params.reason;

  // wait: convert 'seconds' to 'time_ms'
  if (params.seconds !== undefined) {
    normalizedParams.time_ms = params.seconds * 1000;
  }
  if (params.timeout !== undefined) {
    normalizedParams.time_ms = params.timeout; // Already in ms
  }
  if (params.time_ms !== undefined) {
    normalizedParams.time_ms = params.time_ms;
  }

  // scroll: convert 'down'/'pages' to 'direction'/'amount'
  if (actionName === 'scroll_up') {
    normalizedParams.direction = 'up';
    normalizedParams.amount = 300; // Default scroll amount
  } else if (actionName === 'scroll_down') {
    normalizedParams.direction = 'down';
    normalizedParams.amount = 300;
  } else if (params.down !== undefined) {
    normalizedParams.direction = params.down ? 'down' : 'up';
    // Convert pages to pixel amount (1 page ≈ viewport height ≈ 600px)
    const pages = params.pages !== undefined ? params.pages : 1.0;
    normalizedParams.amount = Math.round(pages * 600);
  } else if (params.direction) {
    normalizedParams.direction = params.direction;
    normalizedParams.amount = params.amount || 300;
  }

  // Copy index to params if present
  if (index !== undefined) {
    normalizedParams.index = index;
  }

  return {
    action: normalizedAction,
    thinking: completion.next_goal || completion.thinking,
    index: index,
    coordinates: params.coordinate_x !== undefined
      ? {
        x: params.coordinate_x,
        y: params.coordinate_y,
      }
      : undefined,
    element_description: params.element_description,
    params: normalizedParams,
  };
}

// Fire latency probes to specified models (runs in background, updates cache)
export async function fireLatencyProbes(
  models: string[],
  pool: string,
  openRouterKey: string,
  supabaseUrl: string,
  supabase: SupabaseClient,
): Promise<void> {
  slog('info', `Firing latency probes for ${models.length} models: ${models.join(', ')}`);

  const probePromises = models.map(async (model) => {
    const startTime = Date.now();
    const controller = new AbortController(); // To kill the request immediately

    try {
      let response: globalThis.Response;

      // Call Anthropic directly for Claude models (same as race)
      if (isAnthropicModel(model)) {
        const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
        if (!anthropicKey) {
          slog('error', `Probe skipped for ${model}: no ANTHROPIC_API_KEY`);
          return;
        }

        const anthropicModel = getAnthropicModelName(model);
        response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: anthropicModel,
            messages: [{ role: 'user', content: "Reply with just 'ok'" }],
            max_tokens: LATENCY_PROBE_MAX_TOKENS,
            stream: true,
          }),
          signal: controller.signal,
        });
      } else {
        // OpenRouter for other models
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose AI - Latency Probe',
          },
          body: JSON.stringify({
            model,
            messages: LATENCY_PROBE_MESSAGES,
            max_tokens: LATENCY_PROBE_MAX_TOKENS,
            stream: true,
          }),
          signal: controller.signal, // Enable abort
        });
      }

      if (!response.ok) {
        slog('error', `Probe failed for ${model}: ${response.status}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        slog('error', `Probe no body for ${model}`);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      // Read chunks until we get first contentful token
      while (true) {
        // deno-lint-ignore no-await-in-loop -- sequential SSE read, can't parallelize
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Check each line for contentful data
        for (const line of lines) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue;

          try {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            const parsed = JSON.parse(jsonStr);

            // Handle both OpenRouter and Anthropic streaming formats
            let hasContent = false;
            if (parsed.choices?.[0]?.delta) {
              // OpenRouter format
              const delta = parsed.choices[0].delta;
              hasContent = delta.content || delta.reasoning;
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              // Anthropic format
              hasContent = true;
            }

            if (hasContent) {
              const ttftMs = Date.now() - startTime;
              slog('info', `Probe result: ${model} = ${ttftMs}ms (first contentful token)`);

              // IMMEDIATELY kill the entire HTTP connection
              controller.abort();

              // Fire-and-forget cache update
              updateLatencyCache(supabase, model, pool, ttftMs).catch(() => {});
              return;
            }
          } catch (_e) {
            // Skip unparseable lines
          }
        }

        // Keep only the last incomplete line in buffer
        buffer = lines[lines.length - 1] || '';
      }

      slog('error', `Probe no contentful data for ${model}`);
    } catch (error) {
      // Ignore abort errors (expected when we kill the request)
      if (error instanceof DOMException && error.name === 'AbortError') return;
      slog('error', `Probe error for ${model}:`, { data: error });
    }
  });

  // Wait for all probes to complete
  await Promise.allSettled(probePromises);
  slog('info', `All latency probes completed for ${pool}`);
}
