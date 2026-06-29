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
  RoseError,
  RoseInvalidRequest,
  RoseRateLimitError,
  RoseServerError,
} from './errors';
import type { PoolSpec } from './pools';
import { parseResponsesSSE } from './streaming';
import { postCodexStream } from './transport';
import type { CompletionMessage, ContentBlock, ResponseFormat, RoseStreamChunk } from './types';

const MAX_ATTEMPTS = 3;
const BACKOFF_CAP_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful assistant.';

interface BuildBodyOptions {
  poolSpec: PoolSpec;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  temperature?: number;
  effort?: string;
  providerFastMode?: boolean;
  requestId: string;
}

type ResponsesInputMessage = {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'input_text' | 'output_text'; text: string }
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

function contentToResponsesParts(
  content: string | ContentBlock[],
  role: 'user' | 'assistant'
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
      if (block.text) parts.push({ type: textPartType(role), text: block.text });
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

function responsesTools(
  tools?: Array<Record<string, unknown>>
): Array<Record<string, unknown>> | undefined {
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools ?? []) {
    const fn =
      typeof tool.function === 'object' && tool.function !== null
        ? (tool.function as Record<string, unknown>)
        : tool;
    if (typeof fn.name !== 'string' || fn.name.length === 0) continue;
    const parameters =
      typeof fn.parameters === 'object' && fn.parameters !== null ? fn.parameters : {};
    out.push({
      type: 'function',
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      strict: typeof fn.strict === 'boolean' ? fn.strict : false,
      parameters,
    });
  }
  return out.length > 0 ? out : undefined;
}

function buildResponsesInput(messages: CompletionMessage[]): ResponsesInputItem[] {
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
    out.push({ role, content: contentToResponsesParts(msg.content, role) });
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
    model: opts.poolSpec.gptAuthModel,
    instructions: instructions ?? '',
    responseFormat: opts.responseFormat?.json_schema ?? null,
  });
  return `rose:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
}

function normalizeReasoningEffort(effort?: string): string {
  if (effort === 'minimal') return 'low';
  if (effort === 'max') return 'xhigh';
  return effort ?? 'medium';
}

export function buildCodexResponsesBody(opts: BuildBodyOptions): Record<string, unknown> {
  const instructions = buildInstructions(opts.messages) ?? DEFAULT_CODEX_INSTRUCTIONS;
  const body: Record<string, unknown> = {
    model: opts.poolSpec.gptAuthModel,
    input: buildResponsesInput(opts.messages),
    stream: true,
    store: false,
    parallel_tool_calls: true,
    tool_choice: opts.toolChoice ?? 'auto',
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
  if (opts.providerFastMode === true) {
    body.service_tier = 'priority';
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
  providerFastMode?: boolean;
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal;
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
    providerFastMode: opts.providerFastMode,
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
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(backoffFor429(response.headers, attempt), opts.abortSignal);
        continue;
      }
      throw new RoseRateLimitError(`Codex 429: ${errorBody.substring(0, 200)}`, status);
    }

    if (status === 401 || status === 403) {
      throw new RoseAuthError(`Codex ${status}: ${errorBody.substring(0, 200)}`, status);
    }

    if (status === 400) {
      throw new RoseInvalidRequest(`Codex 400: ${errorBody.substring(0, 200)}`, status);
    }

    if (status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS), opts.abortSignal);
        continue;
      }
      throw new RoseServerError(`Codex ${status}: ${errorBody.substring(0, 200)}`, status);
    }

    throw new RoseError(`Codex ${status}: ${errorBody.substring(0, 200)}`, status);
  }

  if (lastError) throw new RoseServerError(`Codex exhausted retries: ${lastError.message}`);
  throw new RoseServerError('Codex exhausted retries');
}

function backoffFor429(headers: Headers, attempt: number): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const parsed = Number.parseFloat(retryAfter);
    if (!Number.isNaN(parsed)) {
      return Math.max(1000, Math.min(parsed * 1000, BACKOFF_CAP_MS));
    }
  }
  return Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS);
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
