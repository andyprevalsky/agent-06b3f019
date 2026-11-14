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

import { createHash } from 'node:crypto';

import { classifyComputeGrantFailure } from '../computeGrantFailure';
import { createLogger } from '../logger';
import {
  RoseAuthError,
  RoseError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
import { getPool, type PoolSpec } from './pools';
import { anthropicSpeedFor, type AgentSpeed } from './speed';
import {
  boundedRateLimitBackoffMs,
  extractRateLimitedUntil,
  providerRequiredWaitMs,
} from './rateLimitReset';
import { observeSubscriptionUsage } from './subscriptionUsage';
import { parseAnthropicSSE } from './streaming';
import { isUncachedContext, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './cache';
import { applyAnthropicToolConfig, transformMessagesForAnthropic } from './transforms';
import { anthropicErrorFields, postAnthropicApiKeyStream, postAnthropicStream } from './transport';
import type { CompletionMessage, ResponseFormat, RoseStreamChunk } from './types';

/**
 * How to authenticate the direct-Anthropic call. `oauth` uses a Claude Max
 * compute token (Bearer, $0 to Rose); `apiKey` uses a plain `sk-ant-api03` key
 * (x-api-key, billed) and serves as a funded default for any user when no
 * compute token is available — see client.ts tier ordering.
 */
export type AnthropicAuth = { mode: 'oauth'; token: string } | { mode: 'apiKey'; key: string };

const log = createLogger('Rose');

const MAX_ATTEMPTS = 3;
const BACKOFF_CAP_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Fast mode on a subscription is billed as extra usage (overage). When the
 * account cannot pay for it, Anthropic answers the fast request 429 with
 * `anthropic-ratelimit-unified-overage-disabled-reason` and the MONTHLY overage
 * reset, while the account's own 5h/7d windows still serve standard requests.
 * Claude Code (services/api/withRetry.ts handleFastModeOverageRejection) turns
 * fast mode off and retries at standard speed on the same credential; it never
 * cools the account. Per token: fast mode stays off until that reset (or
 * FAST_MODE_OFF_DEFAULT_MS without one). Process-local and bounded: it only
 * saves the doomed fast request; correctness never depends on it. Mirrors
 * agents/providers/rose/claude_auth.py.
 */
const OVERAGE_DISABLED_REASON_HEADER = 'anthropic-ratelimit-unified-overage-disabled-reason';
const FAST_MODE_OFF_DEFAULT_MS = 60 * 60_000;
const FAST_MODE_OFF_MAX_TOKENS = 1_000;
const fastModeOffUntil = new Map<string, number>();

function fastModeKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function fastModeOff(token: string): boolean {
  const key = fastModeKey(token);
  const until = fastModeOffUntil.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  fastModeOffUntil.delete(key);
  return false;
}

function turnFastModeOff(token: string, rateLimitedUntil: string | undefined): void {
  const parsed = rateLimitedUntil === undefined ? NaN : Date.parse(rateLimitedUntil);
  const key = fastModeKey(token);
  fastModeOffUntil.delete(key);
  fastModeOffUntil.set(key, Number.isNaN(parsed) ? Date.now() + FAST_MODE_OFF_DEFAULT_MS : parsed);
  while (fastModeOffUntil.size > FAST_MODE_OFF_MAX_TOKENS) {
    const oldest = fastModeOffUntil.keys().next().value;
    if (oldest === undefined) break;
    fastModeOffUntil.delete(oldest);
  }
}

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
  speed?: AgentSpeed;
  effort?: string;
}

const DEFAULT_REASONING_EFFORT = 'xhigh';

function normalizeReasoningEffort(effort?: string): string {
  // Anthropic does not accept the literal "minimal" (OpenAI chat sentinel).
  if (effort === 'minimal') return 'low';
  if (effort === 'max') return 'xhigh';
  return effort ?? DEFAULT_REASONING_EFFORT;
}

function modelSupportsOutputConfigEffort(model: string): boolean {
  // claude-haiku-4-5 (rose-1-mini) 400s: "This model does not support the
  // effort parameter." Mirror agents/providers/rose/claude_auth.py.
  return !model.toLowerCase().includes('haiku');
}

function modelSupportsAdaptiveThinking(model: string): boolean {
  // claude-haiku-4-5 400s on thinking.type=adaptive. Mirror agents rose
  // claude_auth (never default adaptive thinking onto Haiku).
  return !model.toLowerCase().includes('haiku');
}

function modelRejectsForcedToolChoice(model: string): boolean {
  // Official Claude API IDs are claude-fable-5-1 / claude-mythos-5-1.
  // OpenRouter uses a dot (claude-fable-5.1). Do not match leftover Fable 5.
  const canonical = model.toLowerCase().replace(/\./g, '-');
  return (
    canonical.includes('claude-fable-5-1') ||
    canonical.includes('claude-mythos-5-1') ||
    canonical.includes('claude-opus-5-5')
  );
}

function downgradeForcedToolChoiceIfUnsupported(
  body: Record<string, unknown>,
  model: string
): void {
  if (!modelRejectsForcedToolChoice(model)) return;
  const tc = body.tool_choice as Record<string, unknown> | undefined;
  if (!tc || (tc.type !== 'any' && tc.type !== 'tool')) return;
  const downgraded: Record<string, unknown> = { type: 'auto' };
  if (tc.type === 'tool') {
    // Named required_tool used to mean "call this once". Keep that contract
    // when Fable 5.1 forces the downgrade to auto.
    downgraded.disable_parallel_tool_use = true;
  }
  body.tool_choice = downgraded;
}

function addCacheBreakpoint(messages: Array<{ role: string; content: unknown }>): void {
  let index = messages.length - 1;
  while (index >= 0 && isUncachedContext(messages[index])) index--;
  const last = messages[index];
  if (!last) return;
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
    temperature: 1,
  };
  if (modelSupportsAdaptiveThinking(opts.poolSpec.claudeAuthModel)) {
    body.thinking = { type: 'adaptive' };
  }
  if (modelSupportsOutputConfigEffort(opts.poolSpec.claudeAuthModel)) {
    body.output_config = { effort: normalizeReasoningEffort(opts.effort) };
  }
  const anthropicSpeed = anthropicSpeedFor(opts.speed, opts.poolSpec.claudeAuthModel);
  if (anthropicSpeed !== undefined) body.speed = anthropicSpeed;

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

  // Fable 5.1 / Mythos 5.1 reject forced tool_choice (400). Opus 5.5 is on
  // the same list until a credited call proves it accepts type any/tool.
  // Run this before the thinking conflict so a named required_tool still
  // becomes auto + disable_parallel_tool_use instead of a bare auto.
  downgradeForcedToolChoiceIfUnsupported(body, opts.poolSpec.claudeAuthModel);

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
  // for json_schema reasons). Haiku rejects effort — omit rather than 400.
  if (modelSupportsOutputConfigEffort(opts.poolSpec.claudeAuthModel)) {
    const oc = (body.output_config as Record<string, unknown> | undefined) ?? {};
    oc.effort = normalizeReasoningEffort(opts.effort);
    body.output_config = oc;
  } else {
    const oc = body.output_config as Record<string, unknown> | undefined;
    if (oc && 'effort' in oc) {
      delete oc.effort;
      if (Object.keys(oc).length === 0) {
        delete body.output_config;
      }
    }
  }

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
  speed?: AgentSpeed;
  effort?: string;
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
    speed: opts.speed,
    effort: opts.effort,
  });
  // `-claude` marks the $0 OAuth path (used for cost detection downstream);
  // `-anthropic` marks the billed direct-API-key path. Both keep the claude-*
  // model name so "claude family" assertions still hold.
  const actualModel =
    opts.auth.mode === 'oauth'
      ? `${opts.poolSpec.claudeAuthModel}-claude`
      : `${opts.poolSpec.claudeAuthModel}-anthropic`;
  const poolName = opts.auth.mode === 'oauth' ? 'claude-token' : 'anthropic-apikey';

  if (opts.auth.mode === 'oauth' && body.speed === 'fast' && fastModeOff(opts.auth.token)) {
    delete body.speed;
  }

  let lastError: Error | null = null;
  // The standard-speed retry after a fast-mode overage rejection gets its own attempt.
  let maxAttempts = MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
      if (attempt < maxAttempts - 1) {
        await sleep(Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS), opts.abortSignal);
        continue;
      }
      throw new RoseServerError(`Anthropic connect/read error: ${lastError.message}`);
    }

    const status = response.status;
    // Every subscription response carries the account's 5h/7d usage (a 429 also
    // names the spent window); record it in the background, never awaited.
    if (opts.auth.mode === 'oauth') {
      observeSubscriptionUsage('claude', opts.auth.token, response.headers, {
        status,
        body: response.errorBody,
      });
    }

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
      const overageDisabledReason = response.headers.get(OVERAGE_DISABLED_REASON_HEADER);
      if (opts.auth.mode === 'oauth' && body.speed === 'fast' && overageDisabledReason !== null) {
        // Fast mode needs extra usage this account cannot use; the subscription
        // itself is not limited. Never surface a rate limit (that cools the
        // account): retry the same token at standard speed.
        turnFastModeOff(opts.auth.token, rateLimitedUntil);
        delete body.speed;
        maxAttempts += 1;
        log.warn('claudeAuth.fast_mode_overage_rejected', {
          requestId: opts.requestId,
          callSite: opts.callSite,
          overageDisabledReason,
          fastModeOffUntil: rateLimitedUntil ?? null,
          providerMessage: anthropicErrorFields(errorBody).message ?? null,
        });
        continue;
      }
      // Retry in place ONLY when we can honor the provider's wait inside our
      // sleep cap. Sleeping less than it asked for is a guaranteed second 429
      // that burns an attempt (a `retry-after: 30` clipped to the 5s cap did
      // exactly that), and sleeping the full window would stall the activity.
      // Anything longer — including a far-future 5h/7d usage window — rotates
      // credentials instead. Mirrors _should_rotate_429_without_retry in
      // agents/providers/rose/claude_auth.py.
      const requiredWaitMs = providerRequiredWaitMs(response.headers, errorBody, rateLimitedUntil);
      const canWaitInPlace = requiredWaitMs === null || requiredWaitMs <= BACKOFF_CAP_MS;
      if (attempt < maxAttempts - 1 && canWaitInPlace) {
        await sleep(
          boundedRateLimitBackoffMs(attempt, requiredWaitMs, BACKOFF_CAP_MS),
          opts.abortSignal
        );
        continue;
      }
      throw new RoseRateLimitError('Anthropic 429', status, rateLimitedUntil);
    }

    if (status === 401 || status === 403) {
      // Grant liveness is observed HERE, from real agent traffic, rather than by
      // a scheduled prober. Classify on the BODY: revocation arrives as both 401
      // and 403, so a status-only check marks a dead grant healthy and suppresses
      // the re-mint that would fix it. The 429 branch above returns earlier, so a
      // throttle can never reach this and be mistaken for death.
      const failure = classifyComputeGrantFailure({ status, body: errorBody });
      throw new RoseAuthError(`Anthropic ${status}`, status, failure.shouldRemint);
    }

    // 402 = out of credits/quota. Terminal for this credential (a retry won't
    // help until it's topped up), so surface a distinct typed error the client
    // uses to back the API key off — see ANTHROPIC_API_KEY cooldown in client.ts.
    if (status === 402) {
      throw new RosePaymentRequiredError('Anthropic 402 (out of credits)', status);
    }

    if (
      status === 400 &&
      /credit balance is too low|out of credits|purchase credits/i.test(errorBody)
    ) {
      throw new RosePaymentRequiredError('Anthropic 400 (out of credits)', status);
    }

    if (status === 400) {
      // Name the provider's error code so a fall-through reason is diagnosable.
      const code = anthropicErrorFields(errorBody).error_code;
      throw new RoseInvalidRequest(code ? `Anthropic 400 (${code})` : 'Anthropic 400', status);
    }

    if (status >= 500) {
      if (attempt < maxAttempts - 1) {
        await sleep(Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS), opts.abortSignal);
        continue;
      }
      throw new RoseServerError(`Anthropic ${status}`, status);
    }

    throw new RoseError(`Anthropic ${status}`, status);
  }

  // Unreachable in practice — loop body either yields, returns, or throws.
  if (lastError) throw new RoseServerError(`Anthropic exhausted retries: ${lastError.message}`);
  throw new RoseServerError('Anthropic exhausted retries');
}

/** Small fast model, as Claude Code's quota check uses (getSmallFastModel). */
const QUOTA_CHECK_POOL = 'rose-1-mini';
const QUOTA_CHECK_TIMEOUT_MS = 15_000;

export interface ClaudeQuotaCheckResponse {
  status: number;
  headers: Headers;
  /** Error body of a non-2xx response. */
  body?: string;
}

/**
 * Claude Code's quota check (claudeAiLimits.ts makeTestQuery / checkQuotaStatus):
 * one subscription request, `max_tokens: 1` on the small fast model, made only
 * for the `anthropic-ratelimit-unified-*` headers every subscription response
 * (200 or 429) carries. It is how an inference-only token (a setup-token, which
 * the usage endpoint refuses without `user:profile`) reports its windows.
 * Same body builder and OAuth transport as claudeAuthComplete; one attempt, no
 * retry or rotation, and the one-token stream is cancelled unread. The caller
 * reads the headers.
 */
export async function claudeQuotaCheck(opts: {
  token: string;
  requestId: string;
}): Promise<ClaudeQuotaCheckResponse> {
  const body = buildAnthropicBody({
    poolSpec: getPool(QUOTA_CHECK_POOL),
    messages: [{ role: 'user', content: 'quota' }],
    maxTokens: 1,
  });
  const response = await postAnthropicStream({
    body,
    claudeToken: opts.token,
    requestId: opts.requestId,
    callSite: 'usage_quota_check',
    connectTimeoutMs: QUOTA_CHECK_TIMEOUT_MS,
  });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, headers: response.headers, body: response.errorBody };
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
