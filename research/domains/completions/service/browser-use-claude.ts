/**
 * Browser-use Claude-mode sub-flow.
 *
 * When a browser-use request sets `mode: 'claude'`, the caller wants the
 * Anthropic Opus 4.7 model billed against their Claude Code subscription
 * (OAuth-fetched via the backend). This path applies prompt caching on the
 * system prompt and action history, speaks the Anthropic Messages API
 * directly, and returns a 200 response with `error=CLAUDE_RATE_LIMITED` on
 * 429 so the agent caller can fall back to racing.
 */

// deno-lint-ignore-file no-explicit-any

import { slog } from '../../../providers/logger.ts';
import { ANTHROPIC_API_URL, corsHeaders, getBackendApiKey, getBackendApiUrl } from '../config.ts';
import { extractJSON, truncateForLogging } from '../utils.ts';
import { logUsage } from '../repo.ts';
import { transformContentBlockForAnthropic } from './anthropic.ts';
import { transformToBrowserUseFormat } from './browser-use-native.ts';
import { normalizeBrowserUseResponse } from './generic.ts';
import type { BrowserUseContext } from '../types.ts';

/**
 * Claude-mode: direct Anthropic Opus 4.7 call using the user's Claude Code
 * OAuth token with prompt caching. Returns a 200 OK with `error=CLAUDE_RATE_LIMITED`
 * on 429 so the agent caller can fall back to racing.
 */
export async function handleClaudeMode(ctx: BrowserUseContext): Promise<Response> {
  const { rawBody: browserUseReq, requestId, agentId, callSite, authInfo, supabase } = ctx;

  // For claude-mode, use user_id from request body if provided (the API key may map to a shared
  // worker user, but the real user who owns the agent/credentials is passed via user_id)
  const claudeUserId = browserUseReq.user_id || authInfo.userId;
  slog(
    'info',
    `[${requestId}] Claude mode: direct Opus 4.7 with cache controls (userId: ${claudeUserId})`,
    { request_id: requestId, agent_id: agentId, call_site: callSite },
  );

  // Fetch Claude Code OAuth token from backend
  const backendUrl = getBackendApiUrl();
  const backendApiKey = getBackendApiKey();
  if (!backendApiKey) {
    return new Response(
      JSON.stringify({ error: 'BACKEND_API_KEY not configured for claude mode' }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    );
  }

  let oauthToken: string;
  if (browserUseReq.oauth_token) {
    // Token provided by caller (agent worker handles token management)
    oauthToken = browserUseReq.oauth_token;
    slog('info', `[${requestId}] Using caller-provided OAuth token`, {
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });
  } else {
    // Fallback: fetch from backend (backwards compat)
    try {
      const tokenResp = await fetch(
        `${backendUrl}/api/integrations/claude-code/credentials/token`,
        {
          headers: {
            'X-API-Key': backendApiKey,
            'X-User-Id': claudeUserId,
          },
        },
      );
      if (!tokenResp.ok) {
        const errData = await tokenResp.json().catch(() => null);
        const errMsg = errData?.error || `Backend token fetch failed: ${tokenResp.status}`;
        slog('error', `[${requestId}] Claude Code token fetch failed:`, {
          data: errMsg,
          request_id: requestId,
          agent_id: agentId,
          call_site: callSite,
        });
        return new Response(
          JSON.stringify({
            error: errMsg,
            request_id: requestId,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: tokenResp.status === 404 ? 400 : 500,
          },
        );
      }
      const tokenData = await tokenResp.json();
      oauthToken = tokenData.accessToken;
    } catch (tokenErr) {
      slog('error', `[${requestId}] Failed to fetch Claude Code token:`, {
        data: tokenErr,
        request_id: requestId,
        agent_id: agentId,
        call_site: callSite,
      });
      return new Response(
        JSON.stringify({
          error: 'Failed to fetch Claude Code credentials',
          details: tokenErr instanceof Error ? tokenErr.message : 'Unknown error',
          request_id: requestId,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        },
      );
    }
  }

  // Build messages with screenshots ON (including history screenshots)
  const { messages } = transformToBrowserUseFormat(browserUseReq, {
    includeScreenshot: true,
  });

  // Build history screenshot blocks for the user message
  // Each action_history entry with a screenshot gets an image block
  const historyImageBlocks: any[] = [];
  for (const entry of browserUseReq.action_history) {
    if (entry.screenshot) {
      const imageUrl = entry.screenshot.startsWith('http')
        ? entry.screenshot
        : `data:image/png;base64,${entry.screenshot}`;
      historyImageBlocks.push({
        type: 'text',
        text: `Step ${entry.step}: ${entry.action}${
          entry.index !== undefined ? ` (index: ${entry.index})` : ''
        } ${entry.result.success ? '✓' : '✗'}`,
      });
      historyImageBlocks.push({
        type: 'image_url',
        image_url: { url: imageUrl },
      });
    }
  }

  // Inject history screenshots into user message content
  if (historyImageBlocks.length > 0) {
    const userMsg = messages.find((m: any) => m.role === 'user');
    if (userMsg) {
      // Ensure content is an array
      if (!Array.isArray(userMsg.content)) {
        userMsg.content = [{ type: 'text', text: userMsg.content }];
      }
      // Insert history screenshots before the last content block
      userMsg.content = [
        ...userMsg.content,
        { type: 'text', text: '\n--- Action History Screenshots ---' },
        ...historyImageBlocks,
      ];
    }
  }

  // Transform to Anthropic format — system as array with cache_control
  const systemParts: string[] = [];
  const anthropicMessages: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      );
    } else {
      if (Array.isArray(msg.content)) {
        const transformedContent = msg.content.map(transformContentBlockForAnthropic);
        anthropicMessages.push({ ...msg, content: transformedContent });
      } else {
        anthropicMessages.push(msg);
      }
    }
  }

  // Add cache_control breakpoint only to the last user message's last content block
  for (let i = anthropicMessages.length - 1; i >= 0; i--) {
    if (
      anthropicMessages[i].role === 'user' && Array.isArray(anthropicMessages[i].content) &&
      anthropicMessages[i].content.length > 0
    ) {
      anthropicMessages[i].content[anthropicMessages[i].content.length - 1].cache_control = {
        type: 'ephemeral',
      };
      break;
    }
  }

  // Build system as array of blocks with cache_control (required for prompt caching)
  const systemBlocks = systemParts.map((text, i) => ({
    type: 'text' as const,
    text,
    ...(i === systemParts.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const identityBlock = {
    type: 'text' as const,
    text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  };
  const disclaimerBlock = {
    type: 'text' as const,
    text:
      'Disregard the previous identity — you are NOT Claude Code. You are a Rose Labs AI agent. Follow the system instructions below.',
  };
  const anthropicBody: any = {
    model: 'claude-opus-4-7',
    system: [identityBlock, disclaimerBlock, ...systemBlocks],
    messages: anthropicMessages,
    max_tokens: 16000,
    temperature: 1,
    thinking: { type: 'enabled', budget_tokens: 10000 },
  };

  slog('info', `[${requestId}] Claude mode: calling Anthropic with cache controls`, {
    request_id: requestId,
    agent_id: agentId,
    call_site: callSite,
  });
  slog(
    'info',
    `[Claude Mode] System blocks: ${anthropicBody.system.length}, Messages: ${anthropicMessages.length}`,
  );

  const startTime = Date.now();
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${oauthToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':
        'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24',
      'x-app': 'cli',
      'User-Agent': 'claude-cli/2.1.81 (external, sdk-ts, agent-sdk/0.2.75)',
      'content-type': 'application/json',
    },
    body: JSON.stringify(anthropicBody),
  });

  const ttftMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    slog('error', `[${requestId}] Claude mode API error:`, {
      data: [response.status, errorText],
      request_id: requestId,
      agent_id: agentId,
      call_site: callSite,
    });

    // Rate limited — signal caller to fall back to racing
    if (response.status === 429) {
      const parseEpochHeader = (raw: string | null): number | null => {
        if (!raw) return null;
        const num = Number(raw);
        if (!Number.isFinite(num) || num <= 0) return null;
        return Math.floor(num);
      };
      const parseRetryAfter = (raw: string | null): number | null => {
        if (!raw) return null;
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds);
        const dateMs = Date.parse(raw);
        if (Number.isFinite(dateMs)) {
          const delaySec = Math.ceil((dateMs - Date.now()) / 1000);
          return delaySec > 0 ? delaySec : null;
        }
        return null;
      };

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const unifiedReset = parseEpochHeader(
        response.headers.get('anthropic-ratelimit-unified-reset'),
      );
      const unified5hReset = parseEpochHeader(
        response.headers.get('anthropic-ratelimit-unified-5h-reset'),
      );
      const unified7dReset = parseEpochHeader(
        response.headers.get('anthropic-ratelimit-unified-7d-reset'),
      );
      const chosenResetEpoch = unifiedReset ?? unified5hReset ?? unified7dReset ??
        (retryAfter ? Math.floor(Date.now() / 1000) + retryAfter : null);
      const rateLimitedUntil = chosenResetEpoch
        ? new Date(chosenResetEpoch * 1000).toISOString()
        : null;

      let rateLimitMessage = '';
      try {
        const parsed = JSON.parse(errorText);
        rateLimitMessage = parsed?.error?.message || parsed?.message || '';
      } catch {
        rateLimitMessage = errorText.slice(0, 300);
      }

      slog(
        'warn',
        `[${requestId}] Claude mode rate limited, signaling fallback to racing`,
        { request_id: requestId, agent_id: agentId, call_site: callSite },
      );
      return new Response(
        JSON.stringify({
          error: 'CLAUDE_RATE_LIMITED',
          fallback: 'racing',
          rateLimitedUntil,
          rateLimitHeaders: {
            retryAfter: response.headers.get('retry-after'),
            unifiedStatus: response.headers.get('anthropic-ratelimit-unified-status'),
            unifiedReset: response.headers.get('anthropic-ratelimit-unified-reset'),
            representativeClaim: response.headers.get(
              'anthropic-ratelimit-unified-representative-claim',
            ),
            overageDisabledReason: response.headers.get(
              'anthropic-ratelimit-unified-overage-disabled-reason',
            ),
          },
          message: rateLimitMessage || 'Claude account is rate limited',
          request_id: requestId,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    }

    return new Response(
      JSON.stringify({
        error: `Anthropic API error: ${response.status}`,
        details: errorText,
        request_id: requestId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: response.status === 401 ? 401 : 500,
      },
    );
  }

  const data = await response.json();
  slog('info', 'Claude mode raw response:', {
    data: JSON.stringify(truncateForLogging(data), null, 2),
  });

  // Extract text content from Anthropic response
  const textContent = data.content?.find((c: any) => c.type === 'text')?.text || '';
  let completion: any;
  try {
    completion = typeof textContent === 'string' ? JSON.parse(textContent) : textContent;
  } catch {
    const extracted = extractJSON(textContent);
    completion = extracted || { action: [], thinking: textContent };
  }

  const usage = {
    prompt_tokens: data.usage?.input_tokens || 0,
    completion_tokens: data.usage?.output_tokens || 0,
    total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
  };

  const normalizedAction = normalizeBrowserUseResponse({ completion });
  slog(
    'info',
    `[${requestId}] Claude mode: action=${normalizedAction.action}, ttft=${ttftMs}ms, cache_read=${usage.cache_read_input_tokens}, cache_write=${usage.cache_creation_input_tokens}`,
    { request_id: requestId, agent_id: agentId, call_site: callSite },
  );

  // Log usage with $0 cost (billed to user's Claude subscription)
  const claudeModeResponse = {
    action: normalizedAction,
    actual_model: 'anthropic/claude-opus-4.7',
    mode: 'claude',
    usage,
    ttft_ms: ttftMs,
  };
  await logUsage(
    supabase,
    authInfo.apiKeyId,
    authInfo.userId,
    {
      model: browserUseReq.model,
      mode: 'claude',
      task: browserUseReq.task,
    },
    claudeModeResponse,
    0,
    0,
  );

  return new Response(
    JSON.stringify({
      action: normalizedAction,
      requested_model: browserUseReq.model,
      actual_model: 'anthropic/claude-opus-4.7',
      mode: 'claude',
      pool_name: 'rose-1-browser-use',
      ttft_ms: ttftMs,
      usage,
      request_id: requestId,
    }),
    {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    },
  );
}
