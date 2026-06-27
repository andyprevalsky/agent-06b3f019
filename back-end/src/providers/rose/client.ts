/**
 * RoseClient — public orchestration layer for the Rose chat completions path.
 *
 * Mirrors agents/providers/rose/client.py (slim chat-only port). One entry
 * point, `createStreamingCompletion(options)`, that:
 *
 *   1. Resolves the pool from `options.model` (`rose-labs/rose-1-lite`, etc).
 *   2. Tries claudeAuth (direct Anthropic) when `options.claude_token` is set,
 *      buffering the metadata chunk so a pre-content failure can fall through
 *      cleanly.
 *   3. Tries gptAuth (direct ChatGPT/Codex) when `options.gpt_token` is set,
 *      using the same pre-content fall-through contract.
 *   4. Falls through to the pool's OpenRouter waterfall on any typed
 *      RoseError before first content.
 *   5. Wraps the normalized RoseStreamChunk stream into the OpenAI-shaped
 *      CompletionChunk DTO chat callers iterate.
 *
 * No top-level deadline / heartbeat — those are agent-side concerns
 * (Temporal). The chat path lives inside an HTTP request that's already
 * bounded by the upstream client's timeout.
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../logger';
import { logJson } from '../../utils/log';
import { claudeAuthComplete } from './claudeAuth';
import { isAnthropicApiKeyOnCooldown, markAnthropicApiKeyOnCooldown } from '../computeCredentials';
import { isFallThroughError, RoseAuthError, RoseError, RosePaymentRequiredError } from './errors';
import { gptAuthComplete } from './gptAuth';
import { getPool, poolForModel } from './pools';
import { buildOpenAiResponseFormat } from './schema';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';
import { waterfallComplete } from './waterfall';
import { dumpLlmContext, updateLlmDump } from '../llmDump';

const log = createLogger('Rose');

/**
 * Internal sentinel — a fall-through RoseError captured *before* any chunk
 * was emitted to the caller. Only these can be swallowed and replaced with
 * waterfall output. A mid-stream fall-through MUST propagate directly so we
 * don't splice partial content from two different models.
 */
class PreContentFallThroughError extends Error {
  readonly cause: RoseError;
  constructor(cause: RoseError) {
    super(cause.message);
    this.name = 'PreContentFallThroughError';
    this.cause = cause;
  }
}

const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';
// Optional funded default: a plain Anthropic API key. When set, it serves any
// request that has no working user/pool compute token, ahead of the OpenRouter
// waterfall — so completions stay up even when the compute-token pool is empty.
const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

// Shared circuit breaker for the global ANTHROPIC_API_KEY lives in the DB (see
// computeCredentials) so every backend instance and Fly worker respects one
// backoff — no cross-workflow hammering when the key is out of credits.
export { __resetAnthropicApiKeyCooldown } from '../computeCredentials';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} environment variable`);
  return v;
}

function shortRequestId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function dumpDisplayModel(actualModel: string): string {
  if (actualModel.endsWith('-claude')) return actualModel.slice(0, -'-claude'.length);
  if (actualModel.endsWith('-gpt')) return actualModel.slice(0, -'-gpt'.length);
  return actualModel;
}

/**
 * Drop-in replacement for the deleted Supabase edge-function client.
 * Same function signature, same CompletionChunk shape — chat callers
 * (routerLlm, generatorLlm, supervisorHandler) need no changes beyond
 * swapping the import path.
 */
export async function createStreamingCompletion(
  options: CompletionOptions
): Promise<AsyncIterable<CompletionChunk>> {
  const pool = poolForModel(options.model);
  if (!pool) {
    throw new Error(
      `Rose: unknown model ${options.model} (expected rose-labs/rose-1-lite, ` +
        `rose-labs/rose-1-ultra, or rose-labs/rose-1-browser-use)`
    );
  }
  if (options.response_format && options.response_model) {
    throw new Error('Rose: pass either response_format or response_model, not both');
  }

  const normalizedOptions: CompletionOptions = {
    ...options,
    response_format: options.response_model
      ? buildOpenAiResponseFormat(options.response_model)
      : options.response_format,
  };

  const requestId = shortRequestId();
  const callSite = options.dump_context?.call_site ?? 'chat';

  log.info('request', {
    request_id: requestId,
    pool,
    has_claude_token: !!options.claude_token,
    has_gpt_token: !!options.gpt_token,
    body: logJson({
      model: normalizedOptions.model,
      message_count: normalizedOptions.messages.length,
      response_format: normalizedOptions.response_format?.json_schema?.name,
      response_model: normalizedOptions.response_model?.name,
      temperature: normalizedOptions.temperature,
    }),
  });

  return wrapStream({
    options: normalizedOptions,
    pool,
    requestId,
    callSite,
  });
}

interface WrapOptions {
  options: CompletionOptions;
  pool: ReturnType<typeof poolForModel> & string;
  requestId: string;
  callSite: string;
}

async function* wrapStream(opts: WrapOptions): AsyncIterable<CompletionChunk> {
  const poolSpec = getPool(opts.pool);
  const startedAt = Date.now();
  const outputParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let finishReason: string | null = null;
  let dumpPath: string | null = null;

  let metadata: { actual_model: string; pool_name: string } = {
    actual_model: '',
    pool_name: '',
  };

  if (opts.options.dump_context) {
    dumpPath = dumpLlmContext({
      call_site: opts.options.dump_context.call_site,
      agent_id: opts.options.dump_context.agent_id,
      model: opts.options.model,
      message_count: opts.options.messages.length,
      messages: opts.options.messages,
      response_format: opts.options.response_format,
      tools: opts.options.tools,
      config: {
        pool: opts.pool,
        call_site: opts.callSite,
        model: opts.options.model,
        temperature: opts.options.temperature,
        max_tokens: opts.options.max_tokens,
        reasoning_effort: opts.options.effort,
        response_format: opts.options.response_format,
        tools: opts.options.tools,
        tool_choice: opts.options.tool_choice,
        direct_auth: {
          claude_token: Boolean(opts.options.claude_token),
          gpt_token: Boolean(opts.options.gpt_token),
          gpt_account_id: Boolean(opts.options.gpt_account_id),
        },
        requested_params: {
          temperature: opts.options.temperature,
          max_tokens: opts.options.max_tokens,
          reasoning_effort: opts.options.effort,
          response_format: opts.options.response_format,
          tool_choice: opts.options.tool_choice,
          provider_fast_mode: opts.options.provider_fast_mode,
        },
        ...(opts.options.dump_context.config ?? {}),
      },
      extra: opts.options.dump_context.extra,
    });
  }

  const emitChunk = (chunk: RoseStreamChunk): CompletionChunk | null => {
    if (chunk.kind === 'metadata') {
      metadata = {
        actual_model: chunk.data.actual_model ?? '',
        pool_name: chunk.data.pool_name ?? '',
      };
      // Caller doesn't need a dedicated metadata chunk — every CompletionChunk
      // we emit carries actual_model + pool_name inline (parity with the
      // deleted edge function's behavior).
      return null;
    }
    if (chunk.kind === 'content') {
      outputParts.push(chunk.data.text);
      return {
        choices: [{ index: 0, delta: { content: chunk.data.text }, finish_reason: null }],
        requested_model: opts.options.model,
        actual_model: metadata.actual_model,
        pool_name: metadata.pool_name,
        pool_size: poolSpec.waterfall.length,
      };
    }
    if (chunk.kind === 'reasoning') {
      reasoningParts.push(chunk.data.text);
      return {
        choices: [{ index: 0, delta: { reasoning: chunk.data.text }, finish_reason: null }],
        requested_model: opts.options.model,
        actual_model: metadata.actual_model,
        pool_name: metadata.pool_name,
        pool_size: poolSpec.waterfall.length,
      };
    }
    if (chunk.kind === 'usage') {
      finishReason = chunk.data.finish_reason ?? 'stop';
      return {
        choices: [{ index: 0, delta: {}, finish_reason: chunk.data.finish_reason ?? 'stop' }],
        requested_model: opts.options.model,
        actual_model: metadata.actual_model,
        pool_name: metadata.pool_name,
        pool_size: poolSpec.waterfall.length,
        usage: {
          prompt_tokens: chunk.data.prompt_tokens ?? 0,
          completion_tokens: chunk.data.completion_tokens ?? 0,
          total_tokens: chunk.data.total_tokens ?? 0,
          cache_creation_input_tokens: chunk.data.cache_creation_input_tokens,
          cache_read_input_tokens: chunk.data.cache_read_input_tokens,
        },
      };
    }
    if (chunk.kind === 'tool_call') {
      toolCalls.push({
        id: chunk.data.id,
        name: chunk.data.name,
        arguments: chunk.data.arguments,
      });
      return {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: chunk.data.id,
                  type: 'function',
                  function: { name: chunk.data.name, arguments: chunk.data.arguments },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        requested_model: opts.options.model,
        actual_model: metadata.actual_model,
        pool_name: metadata.pool_name,
        pool_size: poolSpec.waterfall.length,
      };
    }
    if (chunk.kind === 'codex_reasoning_item') {
      return {
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        requested_model: opts.options.model,
        actual_model: metadata.actual_model,
        pool_name: metadata.pool_name,
        pool_size: poolSpec.waterfall.length,
        codex_reasoning_item: chunk.data,
      };
    }
    return null;
  };

  const finalizeDump = (error?: unknown) => {
    if (!dumpPath) return;
    const actualModelRaw = metadata.actual_model || '';
    const actualModel = actualModelRaw ? dumpDisplayModel(actualModelRaw) : null;
    updateLlmDump(dumpPath, {
      model: actualModel ?? opts.options.model,
      config: {
        actual_model: actualModel,
        actual_model_raw: actualModelRaw || null,
        pool_name: metadata.pool_name || null,
        finish_reason: finishReason,
      },
      extra: {
        output: outputParts.join(''),
        reasoning: reasoningParts.join(''),
        tool_calls: toolCalls,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error
              ? String(error)
              : null,
      },
    });
  };

  // 1. claudeAuth attempt (with fall-through buffering)
  let claudeAuthFailed: RoseError | null = null;
  let gptAuthFailed: RoseError | null = null;
  if (opts.options.claude_token) {
    try {
      yield* runWithFallThrough({
        produce: () =>
          claudeAuthComplete({
            poolSpec,
            messages: opts.options.messages,
            responseFormat: opts.options.response_format,
            tools: opts.options.tools,
            toolChoice: opts.options.tool_choice,
            maxTokens: opts.options.max_tokens,
            temperature: opts.options.temperature,
            auth: { mode: 'oauth', token: opts.options.claude_token! },
            requestId: opts.requestId,
            callSite: opts.callSite,
            providerFastMode: opts.options.provider_fast_mode,
          }),
        emit: emitChunk,
      });
      log.info('claude_auth.done', {
        request_id: opts.requestId,
        pool: opts.pool,
        elapsed_ms: Date.now() - startedAt,
      });
      finalizeDump();
      return;
    } catch (err) {
      if (err instanceof PreContentFallThroughError) {
        claudeAuthFailed = err.cause;
        log.info('fall_through_from_claude_auth', {
          request_id: opts.requestId,
          reason: err.cause.name,
        });
      } else {
        finalizeDump(err);
        throw err;
      }
    }
  }

  // 2. gptAuth attempt (with fall-through buffering)
  if (opts.options.gpt_token) {
    try {
      yield* runWithFallThrough({
        produce: () =>
          gptAuthComplete({
            poolSpec,
            messages: opts.options.messages,
            responseFormat: opts.options.response_format,
            tools: opts.options.tools,
            toolChoice: opts.options.tool_choice,
            temperature: opts.options.temperature,
            effort: opts.options.effort,
            gptToken: opts.options.gpt_token!,
            accountId: opts.options.gpt_account_id,
            requestId: opts.requestId,
            callSite: opts.callSite,
            providerFastMode: opts.options.provider_fast_mode,
          }),
        emit: emitChunk,
      });
      log.info('gpt_auth.done', {
        request_id: opts.requestId,
        pool: opts.pool,
        elapsed_ms: Date.now() - startedAt,
        claude_auth_failed: claudeAuthFailed?.name ?? null,
      });
      finalizeDump();
      return;
    } catch (err) {
      if (err instanceof PreContentFallThroughError) {
        gptAuthFailed = err.cause;
        log.info('fall_through_from_gpt_auth', {
          request_id: opts.requestId,
          reason: err.cause.name,
        });
      } else {
        finalizeDump(err);
        throw err;
      }
    }
  }

  // 2.5 Anthropic API-key fallback — a funded default for any user. Engages
  // when no compute token served (or it fell through) and an ANTHROPIC_API_KEY
  // is configured, ahead of the OpenRouter waterfall. Direct Anthropic via
  // x-api-key (billed), reusing the claudeAuth request body.
  let anthropicApiKeyFailed: RoseError | null = null;
  const anthropicApiKey = process.env[ANTHROPIC_API_KEY_ENV];
  // Shared DB-backed cooldown: skip the key entirely while it's backed off so
  // no worker/workflow hammers an exhausted key. Only query when a key exists.
  const apiKeyOnCooldown = anthropicApiKey ? await isAnthropicApiKeyOnCooldown() : false;
  if (anthropicApiKey && apiKeyOnCooldown) {
    log.info('anthropic_apikey.skipped_cooldown', {
      request_id: opts.requestId,
    });
  }
  if (anthropicApiKey && !apiKeyOnCooldown) {
    try {
      yield* runWithFallThrough({
        produce: () =>
          claudeAuthComplete({
            poolSpec,
            messages: opts.options.messages,
            responseFormat: opts.options.response_format,
            tools: opts.options.tools,
            toolChoice: opts.options.tool_choice,
            maxTokens: opts.options.max_tokens,
            temperature: opts.options.temperature,
            auth: { mode: 'apiKey', key: anthropicApiKey },
            requestId: opts.requestId,
            callSite: opts.callSite,
            providerFastMode: opts.options.provider_fast_mode,
          }),
        emit: emitChunk,
      });
      log.info('anthropic_apikey.done', {
        request_id: opts.requestId,
        pool: opts.pool,
        elapsed_ms: Date.now() - startedAt,
        claude_auth_failed: claudeAuthFailed?.name ?? null,
        gpt_auth_failed: gptAuthFailed?.name ?? null,
      });
      finalizeDump();
      return;
    } catch (err) {
      if (err instanceof PreContentFallThroughError) {
        anthropicApiKeyFailed = err.cause;
        // Out-of-credits (402) or bad-key (401/403) means the shared key is
        // unusable right now — back it off in the DB so no other request, on any
        // worker or workflow, retries it for the cooldown window. Transient
        // errors (5xx/stall/429) do NOT trip it: those can recover next call.
        if (err.cause instanceof RosePaymentRequiredError || err.cause instanceof RoseAuthError) {
          await markAnthropicApiKeyOnCooldown(err.cause.name);
        }
        log.info('fall_through_from_anthropic_apikey', {
          request_id: opts.requestId,
          reason: err.cause.name,
        });
      } else {
        finalizeDump(err);
        throw err;
      }
    }
  }

  // 3. Waterfall — this is the terminal pipeline; unwrap the internal
  // fall-through sentinel so callers continue to see typed RoseError
  // subclasses (their `instanceof RoseError` checks depend on it).
  if (opts.options.disable_waterfall) {
    const error =
      anthropicApiKeyFailed ??
      gptAuthFailed ??
      claudeAuthFailed ??
      new Error('Rose waterfall disabled');
    finalizeDump(error);
    throw error;
  }

  try {
    yield* runWithFallThrough({
      produce: () =>
        waterfallComplete({
          poolSpec,
          messages: opts.options.messages,
          responseFormat: opts.options.response_format,
          temperature: opts.options.temperature,
          maxTokens: opts.options.max_tokens,
          openrouterKey: requiredEnv(OPENROUTER_API_KEY_ENV),
          requestId: opts.requestId,
          callSite: opts.callSite,
          providerFastMode: opts.options.provider_fast_mode,
        }),
      emit: emitChunk,
    });
  } catch (err) {
    if (err instanceof PreContentFallThroughError) {
      finalizeDump(err.cause);
      throw err.cause;
    }
    finalizeDump(err);
    throw err;
  }
  log.info('waterfall.done', {
    request_id: opts.requestId,
    pool: opts.pool,
    elapsed_ms: Date.now() - startedAt,
    claude_auth_failed: claudeAuthFailed?.name ?? null,
    gpt_auth_failed: gptAuthFailed?.name ?? null,
    anthropic_apikey_failed: anthropicApiKeyFailed?.name ?? null,
  });
  finalizeDump();
}

interface RunWithFallThroughOptions {
  produce: () => AsyncIterable<RoseStreamChunk>;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
}

/**
 * Iterate `produce()` and yield non-null `emit()` results. Buffers the first
 * metadata chunk so a pre-first-content RoseError can propagate without the
 * caller seeing partial output. Once content has flowed, errors propagate
 * normally (we can't undo what's already been streamed).
 */
async function* runWithFallThrough(
  opts: RunWithFallThroughOptions
): AsyncIterable<CompletionChunk> {
  let yieldedAny = false;
  const iterator = opts.produce()[Symbol.asyncIterator]();

  try {
    while (true) {
      let result: IteratorResult<RoseStreamChunk>;
      try {
        result = await iterator.next();
      } catch (err) {
        if (!yieldedAny && err instanceof RoseError && isFallThroughError(err)) {
          // Caller-visible "no content yet" failure — safe to swap pipelines.
          throw new PreContentFallThroughError(err);
        }
        // Post-content failures must propagate directly: partial output has
        // already been streamed to the caller, so splicing in a second model's
        // output would corrupt the response.
        throw err;
      }
      if (result.done) return;
      const out = opts.emit(result.value);
      if (out) {
        yield out;
        yieldedAny = true;
      }
    }
  } finally {
    // Close the upstream iterator when the consumer stops early (throw/return)
    // so `produce()`'s finally blocks — socket cleanup, AbortController signal
    // tripping, stream cancellation — actually run. Without this, an early
    // exit (e.g. a consumer break) would leak the underlying fetch response.
    if (iterator.return) {
      try {
        await iterator.return();
      } catch {
        // Nothing useful we can do here; the finally's sole purpose was
        // plumbing cleanup into the upstream generator.
      }
    }
  }
}
