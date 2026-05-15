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
import { isFallThroughError, RoseError } from './errors';
import { gptAuthComplete } from './gptAuth';
import { getPool, poolForModel } from './pools';
import { buildOpenAiResponseFormat } from './schema';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';
import { waterfallComplete } from './waterfall';

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

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} environment variable`);
  return v;
}

function shortRequestId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
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
  const callSite = 'chat';

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

  let metadata: { actual_model: string; pool_name: string } = {
    actual_model: '',
    pool_name: '',
  };

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
      return {
        choices: [{ index: 0, delta: { content: chunk.data.text }, finish_reason: null }],
        requested_model: opts.options.model,
        actual_model: metadata.actual_model,
        pool_name: metadata.pool_name,
        pool_size: poolSpec.waterfall.length,
      };
    }
    if (chunk.kind === 'reasoning') {
      return {
        choices: [{ index: 0, delta: { reasoning: chunk.data.text }, finish_reason: null }],
        requested_model: opts.options.model,
        actual_model: metadata.actual_model,
        pool_name: metadata.pool_name,
        pool_size: poolSpec.waterfall.length,
      };
    }
    if (chunk.kind === 'usage') {
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
            claudeToken: opts.options.claude_token!,
            requestId: opts.requestId,
            callSite: opts.callSite,
          }),
        emit: emitChunk,
      });
      log.info('claude_auth.done', {
        request_id: opts.requestId,
        pool: opts.pool,
        elapsed_ms: Date.now() - startedAt,
      });
      return;
    } catch (err) {
      if (err instanceof PreContentFallThroughError) {
        claudeAuthFailed = err.cause;
        log.info('fall_through_from_claude_auth', {
          request_id: opts.requestId,
          reason: err.cause.name,
        });
      } else {
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
          }),
        emit: emitChunk,
      });
      log.info('gpt_auth.done', {
        request_id: opts.requestId,
        pool: opts.pool,
        elapsed_ms: Date.now() - startedAt,
        claude_auth_failed: claudeAuthFailed?.name ?? null,
      });
      return;
    } catch (err) {
      if (err instanceof PreContentFallThroughError) {
        gptAuthFailed = err.cause;
        log.info('fall_through_from_gpt_auth', {
          request_id: opts.requestId,
          reason: err.cause.name,
        });
      } else {
        throw err;
      }
    }
  }

  // 3. Waterfall — this is the terminal pipeline; unwrap the internal
  // fall-through sentinel so callers continue to see typed RoseError
  // subclasses (their `instanceof RoseError` checks depend on it).
  if (opts.options.disable_waterfall) {
    throw gptAuthFailed ?? claudeAuthFailed ?? new Error('Rose waterfall disabled');
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
        }),
      emit: emitChunk,
    });
  } catch (err) {
    if (err instanceof PreContentFallThroughError) {
      throw err.cause;
    }
    throw err;
  }
  log.info('waterfall.done', {
    request_id: opts.requestId,
    pool: opts.pool,
    elapsed_ms: Date.now() - startedAt,
    claude_auth_failed: claudeAuthFailed?.name ?? null,
    gpt_auth_failed: gptAuthFailed?.name ?? null,
  });
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
