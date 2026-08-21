/**
 * Direct Anthropic streaming call + retry.
 *
 * Mirrors agents/providers/rose/claude_auth.py for the chat surface. Chat
 * has no per-token rotation (workflow-side concern in agents) — we just do
 * up to 3 in-place retries on 429 / 5xx / network and either succeed or
 * raise a typed RoseError so the client can fall through to waterfall.
 *
 * Contract:
 *   429              -> retry up to 3, exp backoff (Retry-After honored, cap 5s)
 *   5xx              -> retry up to 3, exp backoff (cap 5s)
 *   401 / 403        -> RoseAuthError       (rotation = caller's problem)
 *   400              -> RoseInvalidRequest  (do NOT retry — request is bad)
 *   stream stall     -> RoseStallError      (from streaming.ts)
 *   network errors   -> RoseServerError after retries
 */

import { classifyComputeGrantFailure } from '../computeGrantFailure';
import {
  RoseAuthError,
  RoseError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
import type { PoolSpec } from './pools';
import {
  boundedRateLimitBackoffMs,
  extractRateLimitedUntil,
  providerRequiredWaitMs,
} from './rateLimitReset';
import { parseAnthropicSSE } from './streaming';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './cache';
import { applyAnthropicToolConfig, transformMessagesForAnthropic } from './transforms';
import { postAnthropicApiKeyStream, postAnthropicStream } from './transport';
import type { CompletionMessage, ResponseFormat, RoseStreamChunk } from './types';

/**
 * How to authenticate the direct-Anthropic call. `oauth` uses a Claude Max
 * compute token (Bearer, $0 to Rose); `apiKey` uses a plain `sk-ant-api03` key
 * (x-api-key, billed) and serves as a funded default for any user when no
 * compute token is available — see client.ts tier ordering.
 */
export type AnthropicAuth = { mode: 'oauth'; token: string } | { mode: 'apiKey'; key: string };

const MAX_ATTEMPTS = 3;
const BACKOFF_CAP_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Identity-block pair the Claude OAuth token validator requires as the
 * first two `system` blocks. Order matches research/.../claude-token.ts.
 */
const IDENTITY_BLOCK = {
  type: 'text',
  text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
};
const DISCLAIMER_BLOCK = {
  type: 'text',
  text:
    'Disregard the previous identity — you are NOT Claude Code. ' +
    'You are a Rose Labs AI agent. Follow the system instructions below.',
};

interface BuildBodyOptions {
  poolSpec: PoolSpec;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  providerFastMode?: boolean;
}

function supportsAnthropicFastMode(model: string): boolean {
  return ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8'].includes(model);
}

function addCacheBreakpoint(messages: Array<{ role: string; content: unknown }>): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const target = last.content[last.content.length - 1];
    if (target && typeof target === 'object') {
      (target as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }
  }
}

function addToolCacheBreakpoint(body: Record<string, unknown>): void {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return;
  const last = tools[tools.length - 1];
  if (last && typeof last === 'object') {
    (last as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }
}

/**
 * Anthropic rejects a request carrying more than four `cache_control` blocks
 * ("A maximum of 4 blocks with cache_control may be provided"). A prompt that
 * splits its system text into several stable sections spends one marker each,
 * and the message + tools breakpoints spend two more — so a five-section
 * caller had every claudeAuth round rejected and silently fell through to the
 * paid waterfall.
 *
 * Breakpoints are prefix markers, so the first (universal static prefix) and
 * the last (longest cached prefix) carry nearly all the reuse. Drop the
 * intermediate system markers until the request fits.
 */
const ANTHROPIC_MAX_CACHE_BLOCKS = 4;

function countCacheControlBlocks(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, entry) => sum + countCacheControlBlocks(entry), 0);
  }
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  let count = 'cache_control' in record ? 1 : 0;
  if (Array.isArray(record.content)) count += countCacheControlBlocks(record.content);
  return count;
}

function enforceCacheBlockBudget(body: Record<string, unknown>): void {
  const systemBlocks = Array.isArray(body.system)
    ? (body.system as Record<string, unknown>[]).filter(
        (block) => block && typeof block === 'object' && 'cache_control' in block
      )
    : [];

  let total =
    systemBlocks.length +
    countCacheControlBlocks(body.messages) +
    countCacheControlBlocks(body.tools);

  // Walk inward from the second marker, always leaving the first and last.
  for (let i = 1; i < systemBlocks.length - 1 && total > ANTHROPIC_MAX_CACHE_BLOCKS; i++) {
    delete systemBlocks[i].cache_control;
    total--;
  }
  // Still over budget (e.g. only two system markers): give up the first one,
  // keeping the longest prefix.
  for (let i = 0; i < systemBlocks.length - 1 && total > ANTHROPIC_MAX_CACHE_BLOCKS; i++) {
    if ('cache_control' in systemBlocks[i]) {
      delete systemBlocks[i].cache_control;
      total--;
    }
  }

  // System markers alone may not be enough: a caller-supplied transcript can
  // carry its own breakpoints. Anthropic rejects the whole request over the
  // limit, so strip from the oldest message blocks — the least valuable prefix —
  // until the request is legal.
  if (total > ANTHROPIC_MAX_CACHE_BLOCKS && Array.isArray(body.messages)) {
    for (const message of body.messages as Record<string, unknown>[]) {
      if (total <= ANTHROPIC_MAX_CACHE_BLOCKS) break;
      if (!message || typeof message !== 'object') continue;
      if ('cache_control' in message) {
        delete message.cache_control;
        total--;
      }
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Record<string, unknown>[]) {
        if (total <= ANTHROPIC_MAX_CACHE_BLOCKS) break;
        if (block && typeof block === 'object' && 'cache_control' in block) {
          delete block.cache_control;
          total--;
        }
      }
    }
  }
}

export function buildAnthropicBody(opts: BuildBodyOptions): Record<string, unknown> {
  const {
    staticSystem,
    dynamicSystem,
    messages: anthropicMessages,
  } = transformMessagesForAnthropic(opts.messages);

  const systemBlocks: Record<string, unknown>[] = [IDENTITY_BLOCK, DISCLAIMER_BLOCK];
  if (staticSystem) {
    systemBlocks.push({
      type: 'text',
      text: staticSystem,
      cache_control: { type: 'ephemeral', scope: 'global' },
    });
  }
  // dynamicSystem semantics, mirroring agents/providers/rose/claude_auth.py:
  //   - No boundary inside → single uncached block (legacy "static prefix +
  //     dynamic tail" pattern).
  //   - Contains additional boundaries → each non-empty section is a stable
  //     system block; mark each globally cached. Lets callers express multiple
  //     cache layers (universal-static + per-user-stable) in one prompt.
  if (dynamicSystem) {
    if (dynamicSystem.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
      for (const part of dynamicSystem.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
        const text = part.trim();
        if (!text) continue;
        systemBlocks.push({
          type: 'text',
          text,
          cache_control: { type: 'ephemeral', scope: 'global' },
        });
      }
    } else {
      systemBlocks.push({ type: 'text', text: dynamicSystem });
    }
  }

  addCacheBreakpoint(anthropicMessages);

  const body: Record<string, unknown> = {
    model: opts.poolSpec.claudeAuthModel,
    messages: anthropicMessages,
    max_tokens: opts.maxTokens ?? 8192,
    stream: true,
    system: systemBlocks,
    thinking: { type: 'adaptive' },
    temperature: 1,
    output_config: { effort: 'high' },
  };
  if (opts.providerFastMode === true && supportsAnthropicFastMode(opts.poolSpec.claudeAuthModel)) {
    body.speed = 'fast';
  }

  // Detect whether tools were synthesized from response_format below — when
  // they are, we MUST force tool_choice so the model emits a tool_use block
  // (the supervisor's structured output) instead of free-form prose.
  const cameFromResponseFormat = !opts.tools && opts.responseFormat?.json_schema !== undefined;

  const nativeToolMode = applyAnthropicToolConfig(
    body,
    opts.responseFormat,
    opts.tools,
    opts.toolChoice
  );

  addToolCacheBreakpoint(body);

  // Anthropic rejects `thinking` together with a forced (`any`/`tool`)
  // tool_choice. Two resolutions, depending on which constraint matters more:
  //   - Tools synthesized from response_format: structured output requires
  //     the tool to fire. Drop thinking, keep tool_choice forced.
  //   - Explicit tools with forced tool_choice from the caller: prefer
  //     thinking, downgrade to auto.
  const tc = body.tool_choice as Record<string, unknown> | undefined;
  if (nativeToolMode && tc && (tc.type === 'any' || tc.type === 'tool') && 'thinking' in body) {
    if (cameFromResponseFormat) {
      delete body.thinking;
    } else {
      body.tool_choice = { type: 'auto' };
    }
  }

  // Set effort AFTER applyAnthropicToolConfig (which may drop output_config
  // for json_schema reasons) — effort is always valid regardless of tool mode.
  const oc = (body.output_config as Record<string, unknown> | undefined) ?? {};
  oc.effort = 'high';
  body.output_config = oc;

  enforceCacheBlockBudget(body);

  return body;
}

interface ClaudeAuthOptions {
  poolSpec: PoolSpec;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  auth: AnthropicAuth;
  requestId: string;
  callSite?: string;
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal;
  providerFastMode?: boolean;
}

/**
 * Run a claudeAuth attempt end-to-end, yielding normalized stream chunks.
 * Throws a typed RoseError on any fall-through failure; caller falls
 * through to the waterfall path.
 */
export async function* claudeAuthComplete(opts: ClaudeAuthOptions): AsyncIterable<RoseStreamChunk> {
  const body = buildAnthropicBody({
    poolSpec: opts.poolSpec,
    messages: opts.messages,
    responseFormat: opts.responseFormat,
    tools: opts.tools,
    toolChoice: opts.toolChoice,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    providerFastMode: opts.providerFastMode,
  });
  // `-claude` marks the $0 OAuth path (used for cost detection downstream);
  // `-anthropic` marks the billed direct-API-key path. Both keep the claude-*
  // model name so "claude family" assertions still hold.
  const actualModel =
    opts.auth.mode === 'oauth'
      ? `${opts.poolSpec.claudeAuthModel}-claude`
      : `${opts.poolSpec.claudeAuthModel}-anthropic`;
  const poolName = opts.auth.mode === 'oauth' ? 'claude-token' : 'anthropic-apikey';

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response =
        opts.auth.mode === 'oauth'
          ? await postAnthropicStream({
              body,
              claudeToken: opts.auth.token,
              requestId: opts.requestId,
              callSite: opts.callSite,
              abortSignal: opts.abortSignal,
            })
          : await postAnthropicApiKeyStream({
              body,
              apiKey: opts.auth.key,
              requestId: opts.requestId,
              callSite: opts.callSite,
              abortSignal: opts.abortSignal,
            });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS), opts.abortSignal);
        continue;
      }
      throw new RoseServerError(`Anthropic connect/read error: ${lastError.message}`);
    }

    const status = response.status;

    if (status === 200) {
      if (!response.body) {
        throw new RoseServerError('Anthropic 200 but empty body');
      }
      yield* parseAnthropicSSE(response.body, {
        actualModel,
        poolName,
        requestId: opts.requestId,
        idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      });
      return;
    }

    const errorBody = response.errorBody ?? '';

    if (status === 429) {
      // Capture Anthropic's own reset BEFORE deciding what to do with it. This
      // is the value the credential cooldown must be stamped with; without it
      // the caller invents a 5-minute default that can clobber a real 5h/7d
      // usage window written by the Python agent path.
      const rateLimitedUntil = extractRateLimitedUntil(response.headers, errorBody) ?? undefined;
      // Retry in place ONLY when we can honor the provider's wait inside our
      // sleep cap. Sleeping less than it asked for is a guaranteed second 429
      // that burns an attempt (a `retry-after: 30` clipped to the 5s cap did
      // exactly that), and sleeping the full window would stall the activity.
      // Anything longer — including a far-future 5h/7d usage window — rotates
      // credentials instead. Mirrors _should_rotate_429_without_retry in
      // agents/providers/rose/claude_auth.py.
      const requiredWaitMs = providerRequiredWaitMs(response.headers, errorBody, rateLimitedUntil);
      const canWaitInPlace = requiredWaitMs === null || requiredWaitMs <= BACKOFF_CAP_MS;
      if (attempt < MAX_ATTEMPTS - 1 && canWaitInPlace) {
        await sleep(
          boundedRateLimitBackoffMs(attempt, requiredWaitMs, BACKOFF_CAP_MS),
          opts.abortSignal
        );
        continue;
      }
      throw new RoseRateLimitError(
        `Anthropic 429: ${errorBody.substring(0, 200)}`,
        status,
        rateLimitedUntil
      );
    }

    if (status === 401 || status === 403) {
      // Grant liveness is observed HERE, from real agent traffic, rather than by
      // a scheduled prober. Classify on the BODY: revocation arrives as both 401
      // and 403, so a status-only check marks a dead grant healthy and suppresses
      // the re-mint that would fix it. The 429 branch above returns earlier, so a
      // throttle can never reach this and be mistaken for death.
      const failure = classifyComputeGrantFailure({ status, body: errorBody });
      throw new RoseAuthError(
        `Anthropic ${status}: ${errorBody.substring(0, 200)}`,
        status,
        failure.shouldRemint
      );
    }

    // 402 = out of credits/quota. Terminal for this credential (a retry won't
    // help until it's topped up), so surface a distinct typed error the client
    // uses to back the API key off — see ANTHROPIC_API_KEY cooldown in client.ts.
    if (status === 402) {
      throw new RosePaymentRequiredError(
        `Anthropic 402 (out of credits): ${errorBody.substring(0, 200)}`,
        status
      );
    }

    if (
      status === 400 &&
      /credit balance is too low|out of credits|purchase credits/i.test(errorBody)
    ) {
      throw new RosePaymentRequiredError(
        `Anthropic 400 (out of credits): ${errorBody.substring(0, 200)}`,
        status
      );
    }

    if (status === 400) {
      throw new RoseInvalidRequest(`Anthropic 400: ${errorBody.substring(0, 200)}`, status);
    }

    if (status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS), opts.abortSignal);
        continue;
      }
      throw new RoseServerError(`Anthropic ${status}: ${errorBody.substring(0, 200)}`, status);
    }

    throw new RoseError(`Anthropic ${status}: ${errorBody.substring(0, 200)}`, status);
  }

  // Unreachable in practice — loop body either yields, returns, or throws.
  if (lastError) throw new RoseServerError(`Anthropic exhausted retries: ${lastError.message}`);
  throw new RoseServerError('Anthropic exhausted retries');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Request aborted'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('Request aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Re-export for callers that need to discriminate stalls separately.
export { RoseStallError };
