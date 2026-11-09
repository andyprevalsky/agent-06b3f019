/**
 * RoseClient — public orchestration layer for the Rose chat completions path.
 *
 * Mirrors agents/providers/rose/client.py (slim chat-only port). One entry
 * point, `createStreamingCompletion(options)`, that:
 *
 *   1. Resolves the pool from `options.model` (`rose-labs/rose-1-flash`, etc).
 *   2. When explicitly selected, routes exclusively through either the pool's
 *      OpenRouter waterfall or shared OpenAI priority, failing closed on config.
 *   3. Tries claudeAuth (direct Anthropic) when `options.claude_token` is set,
 *      buffering the metadata chunk so a pre-content failure can fall through
 *      cleanly.
 *   4. Tries gptAuth (direct ChatGPT/Codex) when `options.gpt_token` is set,
 *      using the same pre-content fall-through contract. On a usage-limit,
 *      out-of-credits or auth failure it leases every other untried
 *      subscription from `options.subscription_leases` (subscriptionLegs.ts)
 *      before any funded key below.
 *   5. Tries the shared OpenAI API key path when configured.
 *   6. Tries the shared Anthropic API key path when configured.
 *   7. Tries GPT-6 Sol through Microsoft Foundry for ultra when configured.
 *   8. Falls through to the pool's OpenRouter waterfall on any typed
 *      RoseError before first content.
 *   9. Wraps the normalized RoseStreamChunk stream into the OpenAI-shaped
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
import {
  isAnthropicApiKeyOnCooldown,
  isGptApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
} from '../computeCredentials';
import { RoseAllFailed, RoseAuthError, RoseError, RosePaymentRequiredError } from './errors';
import { openAiApiKeyComplete } from './gptAuth';
import { runSubscriptionLegs } from './subscriptionLegs';
import { getPool, poolForModel } from './pools';
import { normalizeAgentSpeed } from './speed';
import { localCompletion } from './local';
import { buildOpenAiResponseFormat } from './schema';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';
import { withNativeToolContract } from './transforms';
import { waterfallComplete } from './waterfall';
import { startLlmCapture, finishLlmCapture, type LlmCapture } from '../llmDump';
import { exclusiveOpenRouterWaterfall } from './openrouterRoute';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import { exclusiveCerebrasCompletion, POOL_CEREBRAS_IDLE_TIMEOUT_MS } from './cerebrasRoute';
import {
  runCerebrasChatWithWaterfallFallback,
  selectExclusiveCerebrasChatRoute,
} from './exclusiveCerebrasChatRoute';
import { createStreamAccumulator, dumpDisplayModel, emitRoseChunk } from './completionChunks';
import {
  chatFoundryLastResort,
  foundryComplete,
  foundryConfigured,
  foundryRequestFor,
  isChatRouteExhausted,
} from './foundry';

const log = createLogger('Rose');

const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';
const GPT_API_KEY_ENV = 'GPT_API_KEY';
// Optional funded default: a plain Anthropic API key. When set, it serves any
// request that has no working user/pool compute token or shared GPT key, ahead
// of the OpenRouter waterfall — so completions stay up even when the
// compute-token pool is empty.
const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

// Shared circuit breaker for the global ANTHROPIC_API_KEY lives in the DB (see
// computeCredentials) so every backend instance and Fly worker respects one
// backoff — no cross-workflow hammering when the key is out of credits.
export { __resetAnthropicApiKeyCooldown } from '../computeCredentials';
export { __resetGptApiKeyCooldown } from '../computeCredentials';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} environment variable`);
  return v;
}

function openAiApiKey(): string | undefined {
  return process.env[GPT_API_KEY_ENV];
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
      `Rose: unknown model ${options.model} (expected rose-labs/rose-1-mini, ` +
        `rose-labs/rose-1-flash, rose-labs/rose-1-ultra, or rose-labs/rose-1-browser-use)`
    );
  }
  if (options.response_format && options.response_model) {
    throw new Error('Rose: pass either response_format or response_model, not both');
  }
  if (pool === 'rose-local') return localCompletion(options);
  const normalizedOptions: CompletionOptions = {
    ...options,
    // Speed is explicit: a call without an agent speed runs standard.
    speed: normalizeAgentSpeed(options.speed),
    response_format: options.response_model
      ? buildOpenAiResponseFormat(options.response_model)
      : options.response_format,
  };

  const requestId = randomUUID().replace(/-/g, '').slice(0, 12);
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
      provider_route: normalizedOptions.provider_route,
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
  const acc = createStreamAccumulator();
  let dumpCapture: LlmCapture | null = null;

  // OpenAI-dialect legs receive a tool-envelope response_model as native tools.
  // Anthropic legs extract the same tools from response_format themselves.
  const toolOptions = withNativeToolContract(opts.options);
  const openAiToolFields = {
    responseFormat: toolOptions.response_format,
    tools: toolOptions.tools,
    toolChoice: toolOptions.tool_choice,
  };

  if (opts.options.dump_context) {
    dumpCapture = await startLlmCapture({
      call_site: opts.options.dump_context.call_site,
      agent_id: opts.options.dump_context.agent_id,
      root_agent_id: opts.options.dump_context.root_agent_id,
      model: opts.options.model,
      message_count: opts.options.messages.length,
      messages: opts.options.messages,
      response_format: toolOptions.response_format,
      tools: toolOptions.tools,
      config: {
        pool: opts.pool,
        call_site: opts.callSite,
        model: opts.options.model,
        temperature: opts.options.temperature,
        max_tokens: opts.options.max_tokens,
        reasoning_effort: opts.options.effort,
        response_format: toolOptions.response_format,
        tools: toolOptions.tools,
        tool_choice: toolOptions.tool_choice,
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
          speed: opts.options.speed,
          provider_route: opts.options.provider_route,
        },
        ...(opts.options.dump_context.config ?? {}),
      },
      extra: opts.options.dump_context.extra,
    });
  }

  const emitChunk = (chunk: RoseStreamChunk): CompletionChunk | null =>
    emitRoseChunk({
      chunk,
      options: opts.options,
      poolSize: poolSpec.waterfall.length,
      acc,
    });

  let dumpFinalized = false;
  const finalizeDump = async (error?: unknown, consumerClosed = false) => {
    if (!dumpCapture || dumpFinalized) return;
    dumpFinalized = true;
    const actualModelRaw = acc.metadata.actual_model || '';
    const actualModel = actualModelRaw ? dumpDisplayModel(actualModelRaw) : null;
    await finishLlmCapture(dumpCapture, {
      model: actualModel ?? opts.options.model,
      config: {
        actual_model: actualModel,
        actual_model_raw: actualModelRaw || null,
        pool_name: acc.metadata.pool_name || null,
        finish_reason: acc.finishReason,
      },
      extra: {
        consumer_closed: consumerClosed,
        output: acc.outputParts.join(''),
        reasoning: acc.reasoningParts.join(''),
        tool_calls: acc.toolCalls,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error
              ? String(error)
              : null,
      },
    });
  };

  try {
    // Chat prefers low-latency Gemma-4-31B on Cerebras. If that route produces no
    // caller-visible content before its deadline, we race the same-model
    // OpenRouter spill against the REAL multi-provider waterfall. Neither branch
    // is pinned to the stalled Cerebras host, so a slow/empty provider can never
    // silence the whole chat turn.
    let cerebrasRoute;
    try {
      cerebrasRoute = selectExclusiveCerebrasChatRoute({
        options: toolOptions,
        requestId: opts.requestId,
        callSite: opts.callSite,
      });
    } catch (error) {
      await finalizeDump(error);
      throw error;
    }
    const foundryRequest = () =>
      foundryRequestFor({
        poolSpec,
        options: toolOptions,
        requestId: opts.requestId,
        callSite: opts.callSite,
      });
    const chatFallback = (exhausted: PreContentFallThroughError | RoseAllFailed) =>
      chatFoundryLastResort({
        exhausted,
        request: foundryRequest(),
        pool: opts.pool,
        emit: emitChunk,
      });
    if (cerebrasRoute !== null) {
      // Cerebras low-latency chat with fallover: on a pre-content quota/rate cap
      // (402/429) it keeps the chat on Gemma-4-31B via OpenRouter (unpinned); on a
      // stall it races that spill against the generic multi-provider waterfall.
      try {
        try {
          yield* runCerebrasChatWithWaterfallFallback({
            cerebrasRoute,
            poolSpec,
            options: toolOptions,
            requestId: opts.requestId,
            pool: opts.pool,
            callSite: opts.callSite,
            startedAt,
            emit: emitChunk,
          });
        } catch (error) {
          if (!isChatRouteExhausted(error)) throw error;
          yield* chatFallback(error);
        }
      } catch (error) {
        const cause = error instanceof PreContentFallThroughError ? error.cause : error;
        await finalizeDump(cause);
        throw cause;
      }
      await finalizeDump();
      return;
    }

    // Exclusive OpenRouter route used by the synchronous Chat Generator. It preserves
    // the pool's ordered pre-content fallback and bypasses every OAuth/shared-key
    // provider. Missing configuration fails closed before any provider call.
    if (opts.options.provider_route === 'openrouter-waterfall') {
      try {
        try {
          yield* runWithFallThrough({
            produce: () =>
              exclusiveOpenRouterWaterfall({
                poolSpec,
                options: toolOptions,
                requestId: opts.requestId,
                callSite: opts.callSite,
              }),
            emit: emitChunk,
          });
        } catch (error) {
          if (!isChatRouteExhausted(error)) throw error;
          yield* chatFallback(error);
        }
      } catch (error) {
        const cause = error instanceof PreContentFallThroughError ? error.cause : error;
        await finalizeDump(cause);
        throw cause;
      }

      log.info('openrouter_waterfall.done', {
        request_id: opts.requestId,
        pool: opts.pool,
        elapsed_ms: Date.now() - startedAt,
      });
      await finalizeDump();
      return;
    }

    // Exclusive low-latency route used by the synchronous Chat Router. This
    // branch precedes every user OAuth, shared Anthropic, and OpenRouter path.
    if (opts.options.provider_route === 'shared-openai-priority') {
      const sharedOpenAiKey = openAiApiKey();
      if (!sharedOpenAiKey) {
        const error = new Error('Rose shared-openai-priority route requires GPT_API_KEY');
        await finalizeDump(error);
        throw error;
      }
      if (await isGptApiKeyOnCooldown()) {
        const error = new Error('Rose shared-openai-priority route is on GPT_API_KEY cooldown');
        await finalizeDump(error);
        throw error;
      }

      try {
        yield* runWithFallThrough({
          produce: () =>
            openAiApiKeyComplete({
              poolSpec,
              model: poolSpec.gptAuthModel,
              messages: opts.options.messages,
              ...openAiToolFields,
              temperature: opts.options.temperature,
              effort: opts.options.effort,
              openAiKey: sharedOpenAiKey,
              requestId: opts.requestId,
              callSite: opts.callSite,
              speed: opts.options.speed,
              abortSignal: opts.options.abort_signal,
            }),
          emit: emitChunk,
        });
      } catch (error) {
        const cause = error instanceof PreContentFallThroughError ? error.cause : error;
        if (
          error instanceof PreContentFallThroughError &&
          (cause instanceof RosePaymentRequiredError || cause instanceof RoseAuthError)
        ) {
          await markGptApiKeyOnCooldown(cause.name);
        }
        await finalizeDump(cause);
        throw cause;
      }

      log.info('shared_openai_priority.done', {
        request_id: opts.requestId,
        pool: opts.pool,
        elapsed_ms: Date.now() - startedAt,
      });
      await finalizeDump();
      return;
    }

    // 1-2. Subscription legs: the caller's Claude/Codex tokens, then every other
    // leasable subscription, before any funded key below.
    const allowDirectAuth = poolSpec.directAuthEnabled !== false;
    let claudeAuthFailed: RoseError | null = null;
    let gptAuthFailed: RoseError | null = null;
    let openAiApiKeyFailed: RoseError | null = null;
    const allowSubscriptions = poolSpec.subscriptionAuthEnabled ?? allowDirectAuth;
    if (allowSubscriptions) {
      let subscriptions;
      try {
        subscriptions = yield* runSubscriptionLegs({
          poolSpec,
          options: opts.options,
          openAiToolFields,
          requestId: opts.requestId,
          callSite: opts.callSite,
          emit: emitChunk,
          log,
        });
      } catch (err) {
        await finalizeDump(err);
        throw err;
      }
      if (subscriptions.served) {
        await finalizeDump();
        return;
      }
      claudeAuthFailed = subscriptions.claudeAuthFailed;
      gptAuthFailed = subscriptions.gptAuthFailed;
    }

    // 2.5 OpenAI API-key fallback — a funded GPT default for any user. Engages
    // when no compute token served (or it fell through), before Anthropic and
    // OpenRouter. Force provider fast mode for this funded route.
    const sharedOpenAiKey = allowDirectAuth ? openAiApiKey() : undefined;
    const gptKeyOnCooldown = sharedOpenAiKey ? await isGptApiKeyOnCooldown() : false;
    if (sharedOpenAiKey && gptKeyOnCooldown) {
      log.info('openai_apikey.skipped_cooldown', { request_id: opts.requestId });
    }
    if (sharedOpenAiKey && !gptKeyOnCooldown) {
      try {
        yield* runWithFallThrough({
          produce: () =>
            openAiApiKeyComplete({
              poolSpec,
              model: poolSpec.gptAuthModel,
              messages: opts.options.messages,
              ...openAiToolFields,
              temperature: opts.options.temperature,
              effort: opts.options.effort,
              openAiKey: sharedOpenAiKey,
              requestId: opts.requestId,
              callSite: opts.callSite,
              speed: opts.options.speed,
              abortSignal: opts.options.abort_signal,
            }),
          emit: emitChunk,
        });
        log.info('openai_apikey.done', {
          request_id: opts.requestId,
          pool: opts.pool,
          elapsed_ms: Date.now() - startedAt,
          claude_auth_failed: claudeAuthFailed?.name ?? null,
          gpt_auth_failed: gptAuthFailed?.name ?? null,
        });
        await finalizeDump();
        return;
      } catch (err) {
        if (err instanceof PreContentFallThroughError) {
          openAiApiKeyFailed = err.cause;
          if (err.cause instanceof RosePaymentRequiredError || err.cause instanceof RoseAuthError) {
            await markGptApiKeyOnCooldown(err.cause.name);
          }
          log.info('fall_through_from_openai_apikey', {
            request_id: opts.requestId,
            reason: err.cause.name,
          });
        } else {
          await finalizeDump(err);
          throw err;
        }
      }
    }

    // 2.6 Anthropic API-key fallback — a funded default for any user. Engages
    // when no compute token or shared GPT key served (or it fell through) and an
    // ANTHROPIC_API_KEY is configured, ahead of the OpenRouter waterfall. Direct Anthropic via
    // x-api-key (billed), reusing the claudeAuth request body.
    let anthropicApiKeyFailed: RoseError | null = null;
    const anthropicApiKey = allowDirectAuth ? process.env[ANTHROPIC_API_KEY_ENV] : undefined;
    // Shared DB-backed cooldown: skip the key entirely while it's backed off so
    // no worker/workflow hammers an exhausted key. Only query when a key exists.
    const apiKeyOnCooldown = anthropicApiKey ? await isAnthropicApiKeyOnCooldown() : false;
    if (anthropicApiKey && apiKeyOnCooldown) {
      log.info('anthropic_apikey.skipped_cooldown', {
        request_id: opts.requestId,
      });
    }
    if (allowDirectAuth && anthropicApiKey && !apiKeyOnCooldown) {
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
              effort: opts.options.effort,
              auth: { mode: 'apiKey', key: anthropicApiKey },
              requestId: opts.requestId,
              callSite: opts.callSite,
              speed: opts.options.speed,
              abortSignal: opts.options.abort_signal,
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
        await finalizeDump();
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
          await finalizeDump(err);
          throw err;
        }
      }
    }

    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    if (poolSpec.cerebrasModel && cerebrasKey) {
      try {
        yield* runWithFallThrough({
          produce: () =>
            exclusiveCerebrasCompletion({
              options: toolOptions,
              cerebrasKey,
              requestId: opts.requestId,
              callSite: opts.callSite,
              model: poolSpec.cerebrasModel,
              reasoningEffort: poolSpec.cerebrasReasoningEffort,
              idleTimeoutMs: POOL_CEREBRAS_IDLE_TIMEOUT_MS,
            }),
          emit: emitChunk,
        });
        log.info('cerebras.done', {
          request_id: opts.requestId,
          pool: opts.pool,
          model: poolSpec.cerebrasModel,
          elapsed_ms: Date.now() - startedAt,
        });
        await finalizeDump();
        return;
      } catch (err) {
        if (err instanceof PreContentFallThroughError) {
          log.info('fall_through_from_cerebras', {
            request_id: opts.requestId,
            reason: err.cause.name,
            model: poolSpec.cerebrasModel,
          });
        } else {
          await finalizeDump(err);
          throw err;
        }
      }
    }

    // Microsoft Foundry serves the pool's GPT model with the compute-token
    // Responses shape. Its shared deployment is funded, so it follows the
    // user/pool tokens, API keys and the direct Cerebras hop, before OpenRouter.
    let foundryFailed: RoseError | null = null;
    if (foundryConfigured(poolSpec)) {
      try {
        yield* runWithFallThrough({
          produce: () => foundryComplete(foundryRequest()),
          emit: emitChunk,
        });
        log.info('foundry.done', { request_id: opts.requestId, pool: opts.pool });
        await finalizeDump();
        return;
      } catch (err) {
        if (err instanceof PreContentFallThroughError) {
          foundryFailed = err.cause;
          log.info('fall_through_from_foundry', {
            request_id: opts.requestId,
            reason: err.cause.name,
          });
        } else {
          await finalizeDump(err);
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
        foundryFailed ??
        openAiApiKeyFailed ??
        gptAuthFailed ??
        claudeAuthFailed ??
        new Error('Rose waterfall disabled');
      await finalizeDump(error);
      throw error;
    }

    try {
      yield* runWithFallThrough({
        produce: () =>
          waterfallComplete({
            poolSpec,
            messages: opts.options.messages,
            ...openAiToolFields,
            anthropicTools: toolOptions.anthropic_tools,
            temperature: opts.options.temperature,
            maxTokens: opts.options.max_tokens,
            reasoningEffort: opts.options.effort,
            openrouterKey: requiredEnv(OPENROUTER_API_KEY_ENV),
            requestId: opts.requestId,
            callSite: opts.callSite,
            speed: opts.options.speed,
            abortSignal: opts.options.abort_signal,
          }),
        emit: emitChunk,
      });
    } catch (err) {
      if (err instanceof PreContentFallThroughError) {
        await finalizeDump(err.cause);
        throw err.cause;
      }
      await finalizeDump(err);
      throw err;
    }
    log.info('waterfall.done', {
      request_id: opts.requestId,
      pool: opts.pool,
      elapsed_ms: Date.now() - startedAt,
      claude_auth_failed: claudeAuthFailed?.name ?? null,
      gpt_auth_failed: gptAuthFailed?.name ?? null,
      openai_apikey_failed: openAiApiKeyFailed?.name ?? null,
      anthropic_apikey_failed: anthropicApiKeyFailed?.name ?? null,
      foundry_failed: foundryFailed?.name ?? null,
    });
    await finalizeDump();
  } catch (error) {
    await finalizeDump(error);
    throw error;
  } finally {
    // Async-generator return skips ordinary trailing code. Preserve the partial
    // response before the caller can seal/archive the terminated chat stream.
    await finalizeDump(undefined, true);
  }
}
