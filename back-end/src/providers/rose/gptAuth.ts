/**
 * Direct ChatGPT/Codex Responses streaming call + retry.
 *
 * Mirrors claudeAuth.ts, but targets Codex's ChatGPT-account backend using
 * a saved Codex OAuth access token. This intentionally does not route through
 * OpenRouter. The Codex endpoint accepts Responses API-shaped requests and
 * streams Responses SSE events.
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

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './cache';
import {
  RoseAuthError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseServerError,
} from './errors';
import { getPool, type PoolSpec } from './pools';
import { openAiServiceTierFor, type AgentSpeed } from './speed';
import {
  boundedRateLimitBackoffMs,
  extractRateLimitedUntil,
  providerRequiredWaitMs,
} from './rateLimitReset';
import { observeSubscriptionUsage } from './subscriptionUsage';
import { parseResponsesSSE } from './streaming';
import { responsesToolChoice, responsesTools } from './toolContract';
import { postCodexStream, postOpenAIResponsesStream } from './transport';
import type { CompletionMessage, ContentBlock, ResponseFormat, RoseStreamChunk } from './types';

const MAX_ATTEMPTS = 3;
const BACKOFF_CAP_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful assistant.';
const OPENAI_CREDIT_ERROR_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_usage_limit_exceeded',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
]);

function isOpenAiCreditError(errorBody: string): boolean {
  try {
    const parsed = JSON.parse(errorBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return false;
    const error = (parsed as { error?: { code?: unknown; type?: unknown } }).error;
    return (
      (typeof error?.code === 'string' && OPENAI_CREDIT_ERROR_CODES.has(error.code)) ||
      error?.type === 'insufficient_quota'
    );
  } catch {
    return false;
  }
}

interface BuildBodyOptions {
  poolSpec: PoolSpec;
  modelOverride?: string;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  temperature?: number;
  effort?: string;
  /** Already resolved for this leg (see speed.ts); omitted = standard. */
  serviceTier?: 'priority' | 'ultrafast';
  requestId: string;
  /** Route honors GPT-5.6+ prompt_cache_breakpoint (Foundry, OpenAI API key). */
  cacheBreakpoints?: boolean;
}

type ResponsesInputMessage = {
  role: 'user' | 'assistant';
  content: Array<
    | {
        type: 'input_text' | 'output_text';
        text: string;
        prompt_cache_breakpoint?: { mode: 'explicit' };
      }
    | { type: 'input_image'; image_url: string; detail?: string }
  >;
};
type CodexInputMessage = Omit<CompletionMessage, 'role'> & {
  role: CompletionMessage['role'] | 'tool';
};
type ResponsesInputItem =
  | ResponsesInputMessage
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; encrypted_content: string; summary: unknown[] }
  | Record<string, unknown>;

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.text) return block.text;
      if (block.type === 'image_url') return '[Image attachment]';
      if (block.type === 'file') return `[File attachment: ${block.file?.filename ?? 'file'}]`;
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
}

function textPartType(role: 'user' | 'assistant'): 'input_text' | 'output_text' {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

const MAX_PROMPT_CACHE_BREAKPOINTS = 50;

/** GPT-5.6 and later cache only at breakpoints; earlier models reject the field (HTTP 400). */
export function supportsPromptCacheBreakpoints(model?: string): boolean {
  const match = /gpt-(\d+)(?:\.(\d+))?/.exec(model ?? '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

function hasCacheMarker(block: ContentBlock): boolean {
  const marker = (block as ContentBlock & { cache_control?: unknown }).cache_control;
  return typeof marker === 'object' && marker !== null;
}

/**
 * Breakpoint after every user message before the final item (its last text part).
 * Replaying 911 real agent calls through the measured GPT-5.6+ rule (2026-10-12):
 * implicit mode plus these marks cost 0.51x of no caching, against 0.55x for implicit
 * mode alone and 0.61x for explicit mode.
 */
function markCompletedUserMessages(items: ResponsesInputItem[]): void {
  for (const item of items.slice(0, -1)) {
    const message = item as ResponsesInputMessage;
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const texts = message.content.filter((part) => part.type === 'input_text');
    const last = texts[texts.length - 1] as
      { prompt_cache_breakpoint?: { mode: 'explicit' } } | undefined;
    if (last) last.prompt_cache_breakpoint = { mode: 'explicit' };
  }
}

/** Reads consider the latest 50 breakpoints; drop older marks beyond that. */
function capPromptCacheBreakpoints(items: ResponsesInputItem[]): void {
  const marked = items.flatMap((item) => {
    const content = (item as ResponsesInputMessage).content;
    return Array.isArray(content)
      ? content.filter((part) => 'prompt_cache_breakpoint' in part)
      : [];
  });
  for (const part of marked.slice(0, Math.max(marked.length - MAX_PROMPT_CACHE_BREAKPOINTS, 0))) {
    delete (part as { prompt_cache_breakpoint?: unknown }).prompt_cache_breakpoint;
  }
}

function contentToResponsesParts(
  content: string | ContentBlock[],
  role: 'user' | 'assistant',
  cacheBreakpoints = false
): ResponsesInputMessage['content'] {
  if (typeof content === 'string') return [{ type: textPartType(role), text: content }];
  const parts: ResponsesInputMessage['content'] = [];
  for (const block of content) {
    if (
      block.text ||
      block.type === 'text' ||
      block.type === 'input_text' ||
      block.type === 'output_text'
    ) {
      if (block.text) {
        // The caller's cache marker, in GPT-5.6+'s form.
        const breakpoint = cacheBreakpoints && role === 'user' && hasCacheMarker(block);
        parts.push({
          type: textPartType(role),
          text: block.text,
          ...(breakpoint ? { prompt_cache_breakpoint: { mode: 'explicit' as const } } : {}),
        });
      }
      continue;
    }
    if ((block.type === 'image_url' || block.type === 'input_image') && role === 'user') {
      const imageUrl = typeof block.image_url === 'object' ? block.image_url.url : undefined;
      if (imageUrl) {
        const detail = block.detail ?? block.image_url?.detail;
        parts.push({
          type: 'input_image',
          image_url: imageUrl,
          ...(detail ? { detail } : {}),
        });
      }
      continue;
    }
    if (block.type === 'file') {
      parts.push({
        type: textPartType(role),
        text: `[File attachment: ${block.file?.filename ?? 'file'}]`,
      });
    }
  }
  return parts.length > 0 ? parts : [{ type: textPartType(role), text: '' }];
}

function stableCallId(name: string, args: unknown, index: number): string {
  const rawArgs =
    typeof args === 'string'
      ? args
      : JSON.stringify(args ?? {}, Object.keys(args as object).sort());
  return `call_${createHash('sha256').update(`${name}:${rawArgs}:${index}`).digest('hex').slice(0, 16)}`;
}

function normalizeToolArguments(args: unknown): string {
  if (args === undefined || args === null || args === '') return '{}';
  return typeof args === 'string' ? args : JSON.stringify(args);
}

function normalizeCodexReasoningItem(item: Record<string, unknown>): ResponsesInputItem | null {
  return typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
    ? {
        type: 'reasoning',
        encrypted_content: item.encrypted_content,
        summary: Array.isArray(item.summary) ? item.summary : [],
      }
    : null;
}

function normalizeCodexMessageItem(item: Record<string, unknown>): ResponsesInputItem | null {
  if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content))
    return null;
  const content = item.content
    .filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null)
    .map((part) =>
      typeof part.text === 'string' ? { type: 'output_text', text: part.text } : null
    )
    .filter((part): part is { type: 'output_text'; text: string } => part !== null);
  if (content.length === 0) return null;
  return {
    type: 'message',
    role: 'assistant',
    status: ['completed', 'incomplete', 'in_progress'].includes(String(item.status))
      ? item.status
      : 'completed',
    content,
    ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
    ...(typeof item.phase === 'string' && item.phase ? { phase: item.phase } : {}),
  };
}

function buildResponsesInput(
  messages: CompletionMessage[],
  cacheBreakpoints = false
): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  const emittedCallIds = new Set<string>();
  for (const [msgIndex, rawMsg] of messages.entries()) {
    const msg = rawMsg as CodexInputMessage;
    if (msg.role === 'system') continue;

    if (msg.role === 'assistant') {
      for (const item of msg.codex_reasoning_items ?? []) {
        const normalized = normalizeCodexReasoningItem(item);
        if (normalized) out.push(normalized);
      }
      for (const item of msg.codex_message_items ?? []) {
        const normalized = normalizeCodexMessageItem(item);
        if (normalized) out.push(normalized);
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const content = contentToResponsesParts(msg.content, 'assistant');
      if (content.some((part) => 'text' in part && part.text.length > 0)) {
        out.push({ role: 'assistant', content });
      }
      for (const [toolIndex, toolCall] of msg.tool_calls.entries()) {
        const name = toolCall.function?.name ?? toolCall.name ?? 'tool';
        const args = normalizeToolArguments(toolCall.function?.arguments ?? toolCall.arguments);
        const callId =
          toolCall.call_id ?? toolCall.id ?? stableCallId(name, args, msgIndex + toolIndex);
        out.push({
          type: 'function_call',
          call_id: callId,
          name,
          arguments: args,
        });
        emittedCallIds.add(callId);
      }
      continue;
    }

    if (msg.role === 'tool') {
      const callId = msg.tool_call_id ?? msg.call_id;
      const toolText = contentToText(msg.content);
      if (callId && emittedCallIds.has(callId)) {
        out.push({
          type: 'function_call_output',
          call_id: callId,
          output: toolText,
        });
      } else {
        out.push({
          role: 'user',
          content: [{ type: 'input_text', text: `[TOOL]: ${toolText}` }],
        });
      }
      continue;
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: contentToResponsesParts(msg.content, role, cacheBreakpoints) });
  }
  while (out.length > 0 && (out[out.length - 1] as ResponsesInputMessage).role === 'assistant') {
    out.pop();
  }
  if (out.length === 0) {
    out.push({ role: 'user', content: [{ type: 'input_text', text: 'Begin.' }] });
  }
  return out;
}

function buildInstructions(messages: CompletionMessage[]): string | undefined {
  const systemText = messages
    .filter((msg) => msg.role === 'system')
    .map((msg) => contentToText(msg.content).trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
  if (systemText.length === 0) return undefined;
  if (!systemText.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) return systemText;
  const stripped = systemText
    .split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
  return stripped.length > 0 ? stripped : undefined;
}

function buildPromptCacheKey(opts: BuildBodyOptions, instructions?: string): string {
  const fingerprint = JSON.stringify({
    model: opts.modelOverride ?? opts.poolSpec.gptAuthModel,
    instructions: instructions ?? '',
    responseFormat: opts.responseFormat?.json_schema ?? null,
  });
  return `rose:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
}

function normalizeReasoningEffort(effort?: string): string {
  if (effort === 'minimal') return 'low';
  if (effort === 'max') return 'xhigh';
  if (
    effort === 'none' ||
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh'
  ) {
    return effort;
  }
  return 'xhigh';
}

export function buildCodexResponsesBody(opts: BuildBodyOptions): Record<string, unknown> {
  const instructions = buildInstructions(opts.messages) ?? DEFAULT_CODEX_INSTRUCTIONS;
  const model = opts.modelOverride ?? opts.poolSpec.gptAuthModel;
  const breakpoints = opts.cacheBreakpoints === true && supportsPromptCacheBreakpoints(model);
  const input = buildResponsesInput(opts.messages, breakpoints);
  if (breakpoints) markCompletedUserMessages(input);
  capPromptCacheBreakpoints(input);
  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    tool_choice: responsesToolChoice(opts.toolChoice),
    prompt_cache_key: buildPromptCacheKey(opts, instructions),
    reasoning: { effort: normalizeReasoningEffort(opts.effort), summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  };

  body.instructions = instructions;
  const convertedTools = responsesTools(opts.tools);
  if (convertedTools) body.tools = convertedTools;

  if (opts.responseFormat?.json_schema) {
    body.text = {
      format: {
        type: 'json_schema',
        name: opts.responseFormat.json_schema.name,
        strict: opts.responseFormat.json_schema.strict,
        schema: opts.responseFormat.json_schema.schema,
      },
    };
  }
  if (opts.serviceTier !== undefined) {
    body.service_tier = opts.serviceTier;
  }

  return body;
}

interface GptAuthOptions {
  poolSpec: PoolSpec;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  temperature?: number;
  effort?: string;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  gptToken: string;
  accountId?: string;
  requestId: string;
  callSite?: string;
  speed?: AgentSpeed;
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

/** The small pool's Codex model, as the Claude quota check uses the small Claude model. */
const CODEX_QUOTA_CHECK_POOL = 'rose-1-mini';
const CODEX_QUOTA_CHECK_TIMEOUT_MS = 15_000;

export interface CodexQuotaCheckResponse {
  status: number;
  headers: Headers;
  /** Error body of a non-2xx response (a usage_limit_reached body names the reset). */
  body?: string;
}

/**
 * The Codex counterpart of claudeQuotaCheck: one minimal subscription request
 * at standard speed, made only for the `x-codex-*` window headers (and, on a
 * 429, the usage_limit_reached body) every ChatGPT-backend response carries.
 * Same body builder and transport as gptAuthComplete; one attempt, no retry or
 * rotation, and the stream is cancelled unread. The caller reads the headers.
 */
export async function codexQuotaCheck(opts: {
  token: string;
  accountId?: string;
  requestId: string;
}): Promise<CodexQuotaCheckResponse> {
  const body = buildCodexResponsesBody({
    poolSpec: getPool(CODEX_QUOTA_CHECK_POOL),
    messages: [{ role: 'user', content: 'quota' }],
    effort: 'low',
    requestId: opts.requestId,
  });
  const response = await postCodexStream({
    body,
    gptToken: opts.token,
    accountId: opts.accountId,
    requestId: opts.requestId,
    callSite: 'usage_quota_check',
    connectTimeoutMs: CODEX_QUOTA_CHECK_TIMEOUT_MS,
  });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, headers: response.headers, body: response.errorBody };
}

export async function* gptAuthComplete(opts: GptAuthOptions): AsyncIterable<RoseStreamChunk> {
  const body = buildCodexResponsesBody({
    poolSpec: opts.poolSpec,
    messages: opts.messages,
    responseFormat: opts.responseFormat,
    tools: opts.tools,
    toolChoice: opts.toolChoice,
    temperature: opts.temperature,
    effort: opts.effort,
    serviceTier: openAiServiceTierFor(opts.speed, opts.poolSpec.gptAuthModel),
    requestId: opts.requestId,
  });
  const actualModel = `${opts.poolSpec.gptAuthModel}-gpt`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await postCodexStream({
        body,
        gptToken: opts.gptToken,
        accountId: opts.accountId,
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
      throw new RoseServerError(`Codex connect/read error: ${lastError.message}`);
    }

    const status = response.status;
    // The account's 5h/7d usage (x-codex-* headers, plus a usage-limit body's
    // reset on failure), recorded in the background, never awaited.
    observeSubscriptionUsage('gpt', opts.gptToken, response.headers, {
      status,
      body: response.errorBody,
    });

    if (status === 200) {
      if (!response.body) {
        throw new RoseServerError('Codex 200 but empty body');
      }
      yield* parseResponsesSSE(response.body, {
        actualModel,
        poolName: 'gpt-token',
        requestId: opts.requestId,
        idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      });
      return;
    }

    const errorBody = response.errorBody ?? '';

    if (status === 429) {
      // Carry the provider's own reset through to the credential cooldown —
      // see the identical capture in claudeAuth.ts and rateLimitReset.ts.
      const rateLimitedUntil = extractRateLimitedUntil(response.headers, errorBody) ?? undefined;
      // Retry in place only when the provider's wait fits inside our sleep cap;
      // otherwise rotate. See the matching comment in claudeAuth.ts.
      const requiredWaitMs = providerRequiredWaitMs(response.headers, errorBody, rateLimitedUntil);
      const canWaitInPlace = requiredWaitMs === null || requiredWaitMs <= BACKOFF_CAP_MS;
      if (attempt < MAX_ATTEMPTS - 1 && canWaitInPlace) {
        await sleep(
          boundedRateLimitBackoffMs(attempt, requiredWaitMs, BACKOFF_CAP_MS),
          opts.abortSignal
        );
        continue;
      }
      throw new RoseRateLimitError('Codex 429', status, rateLimitedUntil);
    }

    if (status === 401 || status === 403) {
      throw new RoseAuthError(`Codex ${status}`, status);
    }

    if (status === 400) {
      throw new RoseInvalidRequest('Codex 400', status);
    }

    if (status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS), opts.abortSignal);
        continue;
      }
      throw new RoseServerError(`Codex ${status}`, status);
    }

    // 404 (and any other unexpected non-2xx) must be RoseServerError so
    // isFallThroughError() walks openai-api-key / waterfall. A bare RoseError
    // is NOT fall-through — that gap made Cloudflare/edge 404s (empty body,
    // same for garbage tokens) fail the whole agent instead of falling through.
    // Do not retry 404 in place: the same egress IP keeps getting blocked.
    throw new RoseServerError(`Codex ${status}`, status);
  }

  if (lastError) throw new RoseServerError(`Codex exhausted retries: ${lastError.message}`);
  throw new RoseServerError('Codex exhausted retries');
}

interface OpenAiApiKeyOptions {
  poolSpec: PoolSpec;
  model: string;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  temperature?: number;
  effort?: string;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  openAiKey: string;
  requestId: string;
  callSite?: string;
  speed?: AgentSpeed;
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

export async function* openAiApiKeyComplete(
  opts: OpenAiApiKeyOptions
): AsyncIterable<RoseStreamChunk> {
  const body = buildCodexResponsesBody({
    poolSpec: opts.poolSpec,
    modelOverride: opts.model,
    cacheBreakpoints: true,
    messages: opts.messages,
    responseFormat: opts.responseFormat,
    tools: opts.tools,
    toolChoice: opts.toolChoice,
    temperature: opts.temperature,
    effort: opts.effort,
    serviceTier: openAiServiceTierFor(opts.speed, opts.model),
    requestId: opts.requestId,
  });
  const actualModel = `${opts.model}-openai`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await postOpenAIResponsesStream({
        body,
        openAiKey: opts.openAiKey,
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
      throw new RoseServerError(`OpenAI connect/read error: ${lastError.message}`);
    }

    const status = response.status;

    if (status === 200) {
      if (!response.body) {
        throw new RoseServerError('OpenAI 200 but empty body');
      }
      yield* parseResponsesSSE(response.body, {
        actualModel,
        poolName: 'openai-api-key',
        requestId: opts.requestId,
        idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      });
      return;
    }

    const errorBody = response.errorBody ?? '';

    if (status === 402 || (status === 429 && isOpenAiCreditError(errorBody))) {
      throw new RosePaymentRequiredError(
        `OpenAI ${status}: ${errorBody.substring(0, 200)}`,
        status
      );
    }

    if (status === 429) {
      const rateLimitedUntil = extractRateLimitedUntil(response.headers, errorBody) ?? undefined;
      // Retry in place only when the provider's wait fits inside our sleep cap;
      // otherwise rotate. See the matching comment in claudeAuth.ts.
      const requiredWaitMs = providerRequiredWaitMs(response.headers, errorBody, rateLimitedUntil);
      const canWaitInPlace = requiredWaitMs === null || requiredWaitMs <= BACKOFF_CAP_MS;
      if (attempt < MAX_ATTEMPTS - 1 && canWaitInPlace) {
        await sleep(
          boundedRateLimitBackoffMs(attempt, requiredWaitMs, BACKOFF_CAP_MS),
          opts.abortSignal
        );
        continue;
      }
      throw new RoseRateLimitError('OpenAI 429', status, rateLimitedUntil);
    }

    if (status === 401 || status === 403) {
      throw new RoseAuthError(`OpenAI ${status}`, status);
    }

    if (status === 400) {
      throw new RoseInvalidRequest('OpenAI 400', status);
    }

    if (status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS), opts.abortSignal);
        continue;
      }
      throw new RoseServerError(`OpenAI ${status}`, status);
    }

    // Mirror Codex: unexpected statuses (incl. 404) fall through as
    // RoseServerError, never bare RoseError (not in isFallThroughError).
    throw new RoseServerError(`OpenAI ${status}`, status);
  }

  if (lastError) throw new RoseServerError(`OpenAI exhausted retries: ${lastError.message}`);
  throw new RoseServerError('OpenAI exhausted retries');
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortSignal.reason);
      },
      { once: true }
    );
  });
}
