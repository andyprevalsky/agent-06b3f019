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
 *   3. Falls through to the pool's OpenRouter waterfall on any typed
 *      RoseError before first content.
 *   4. Wraps the normalized RoseStreamChunk stream into the OpenAI-shaped
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
import { getPool, poolForModel } from './pools';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';
import { waterfallComplete } from './waterfall';

const log = createLogger('Rose');

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

  const requestId = shortRequestId();
  const callSite = 'chat';

  log.info('request', {
    request_id: requestId,
    pool,
    has_claude_token: !!options.claude_token,
    body: logJson({
      model: options.model,
      message_count: options.messages.length,
      response_format: options.response_format?.json_schema?.name,
      temperature: options.temperature,
    }),
  });

  return wrapStream({
    options,
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
    return null;
  };

  // 1. claudeAuth attempt (with fall-through buffering)
  let claudeAuthFailed: RoseError | null = null;
  if (opts.options.claude_token) {
    try {
      yield* runWithFallThrough({
        produce: () =>
          claudeAuthComplete({
            poolSpec,
            messages: opts.options.messages,
            responseFormat: opts.options.response_format,
            maxTokens: opts.options.max_tokens,
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
      if (err instanceof RoseError && isFallThroughError(err)) {
        claudeAuthFailed = err;
        log.info('fall_through_to_waterfall', {
          request_id: opts.requestId,
          reason: err.name,
        });
      } else {
        throw err;
      }
    }
  }

  // 2. Waterfall
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
  log.info('waterfall.done', {
    request_id: opts.requestId,
    pool: opts.pool,
    elapsed_ms: Date.now() - startedAt,
    claude_auth_failed: claudeAuthFailed?.name ?? null,
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
   
  while (true) {
    let result: IteratorResult<RoseStreamChunk>;
    try {
      result = await iterator.next();
    } catch (err) {
      if (!yieldedAny && err instanceof RoseError && isFallThroughError(err)) {
        throw err; // caller wraps — see wrapStream
      }
      throw err;
    }
    if (result.done) return;
    const out = opts.emit(result.value);
    if (out) {
      yield out;
      yieldedAny = true;
    }
  }
}
