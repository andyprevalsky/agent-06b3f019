/**
 * Sequential model fallback — the "waterfall" path.
 *
 * Mirrors agents/providers/rose/waterfall.py for the chat surface.
 * Tries each model in the pool in order via OpenRouter; streams the first
 * one that returns 2xx with non-empty content.
 *
 * No retries at this layer — each step is a single attempt. claudeAuth.ts
 * owns the retry/backoff logic for the direct-Anthropic path.
 */

import { createLogger } from '../logger';
import { RoseAllFailed, RoseError, RoseStallError, type RoseStepError } from './errors';
import type { PoolSpec } from './pools';
import { parseOpenAISSE } from './streaming';
import { postOpenRouterStream } from './transport';
import { openAiChatToolChoice, openAiChatTools } from './toolContract';
import { normalizeOpenAiToolCalls } from './transforms';
import type { CompletionMessage, ResponseFormat, RoseStreamChunk } from './types';

const log = createLogger('RoseWaterfall');

const PER_STEP_TIMEOUT_MS = 60_000;

interface WaterfallOptions {
  poolSpec: PoolSpec;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  temperature?: number;
  maxTokens?: number;
  openrouterKey: string;
  requestId: string;
  callSite?: string;
  perStepTimeoutMs?: number;
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal;
  providerFastMode?: boolean;
  reasoningEffort?: string;
  tools?: Array<Record<string, unknown>>;
  anthropicTools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
}

export function buildOpenRouterBody(opts: {
  model: string;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  temperature?: number;
  maxTokens?: number;
  providerFastMode?: boolean;
  reasoningEffort?: string;
  tools?: Array<Record<string, unknown>>;
  anthropicTools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: normalizeOpenAiToolCalls(opts.messages),
    stream: true,
    stream_options: { include_usage: true },
    // Always stamp reasoning.effort (default xhigh) so every waterfall step
    // body is well-formed. OpenRouter accepts max/xhigh/high/medium/low/none.
    // Map our "minimal" sentinel → "low" (matches gpt_auth / PY waterfall).
    reasoning: {
      effort:
        opts.reasoningEffort === 'max'
          ? 'xhigh'
          : opts.reasoningEffort === 'minimal'
            ? 'low'
            : (opts.reasoningEffort ?? 'xhigh'),
    },
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.providerFastMode === true) body.speed = 'fast';
  // OpenAI chat function shape, whichever shape the caller supplied; tool_choice
  // only accompanies declared tools (mirrors build_openrouter_body).
  const modelTools =
    opts.model.startsWith('anthropic/') && opts.anthropicTools ? opts.anthropicTools : opts.tools;
  const tools = openAiChatTools(modelTools);
  if (tools) {
    body.tools = tools;
    if (opts.toolChoice !== undefined) {
      body.tool_choice = openAiChatToolChoice(opts.toolChoice, opts.model);
    }
  }
  return body;
}

export async function* waterfallComplete(opts: WaterfallOptions): AsyncIterable<RoseStreamChunk> {
  const stepErrors: RoseStepError[] = [];
  const perStepMs = opts.perStepTimeoutMs ?? PER_STEP_TIMEOUT_MS;

  for (let idx = 0; idx < opts.poolSpec.waterfall.length; idx++) {
    if (opts.abortSignal?.aborted) {
      throw opts.abortSignal.reason ?? new Error('OpenRouter waterfall aborted');
    }
    const model = opts.poolSpec.waterfall[idx];
    log.info('step', {
      request_id: opts.requestId,
      call_site: opts.callSite,
      pool: opts.poolSpec.name,
      step: idx + 1,
      total: opts.poolSpec.waterfall.length,
      model,
    });

    // Speed pools pin waterfall effort (low). Ultra leaves it unset.
    const reasoningEffort = opts.poolSpec.waterfallReasoningEffort ?? opts.reasoningEffort;
    const body = buildOpenRouterBody({
      model,
      messages: opts.messages,
      responseFormat: opts.responseFormat,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      providerFastMode: opts.providerFastMode,
      reasoningEffort,
      tools: opts.tools,
      anthropicTools: opts.anthropicTools,
      toolChoice: opts.toolChoice,
    });

    // Only pre-content failures are eligible for waterfall fallback — once a
    // model has streamed any content, a mid-stream failure must propagate
    // directly so the next provider's output doesn't get spliced onto it.
    let emitted = false;
    try {
      const stepIter = streamOneStep({
        body,
        model,
        poolName: opts.poolSpec.name,
        openrouterKey: opts.openrouterKey,
        requestId: opts.requestId,
        callSite: opts.callSite,
        perStepTimeoutMs: perStepMs,
        idleTimeoutMs: opts.idleTimeoutMs ?? perStepMs,
        abortSignal: opts.abortSignal,
      });
      for await (const chunk of stepIter) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (err) {
      // A bounded hedge abort means this whole waterfall lost the race. Do not
      // mistake cancellation for a provider failure and start the next model.
      if (opts.abortSignal?.aborted) {
        throw opts.abortSignal.reason ?? err;
      }
      const re = err instanceof RoseError ? err : new RoseError(String(err));
      if (emitted) {
        log.warn('step_failed_mid_stream', {
          request_id: opts.requestId,
          call_site: opts.callSite,
          pool: opts.poolSpec.name,
          step: idx + 1,
          model,
          error: re.message,
        });
        throw re;
      }
      log.warn('step_failed', {
        request_id: opts.requestId,
        call_site: opts.callSite,
        pool: opts.poolSpec.name,
        step: idx + 1,
        model,
        error: re.message,
      });
      stepErrors.push({ model, error: re });
    }
  }

  log.error('all_failed', {
    request_id: opts.requestId,
    pool: opts.poolSpec.name,
    step_count: stepErrors.length,
  });
  throw new RoseAllFailed(
    `All ${opts.poolSpec.waterfall.length} waterfall models failed for pool ${opts.poolSpec.name}`,
    stepErrors
  );
}

async function* streamOneStep(opts: {
  body: Record<string, unknown>;
  model: string;
  poolName: string;
  openrouterKey: string;
  requestId: string;
  callSite?: string;
  perStepTimeoutMs: number;
  idleTimeoutMs: number;
  abortSignal?: AbortSignal;
}): AsyncIterable<RoseStreamChunk> {
  const response = await postOpenRouterStream({
    body: opts.body,
    openrouterKey: opts.openrouterKey,
    requestId: opts.requestId,
    callSite: opts.callSite,
    connectTimeoutMs: opts.perStepTimeoutMs,
    abortSignal: opts.abortSignal,
  });

  if (!response.ok) {
    throw new RoseError(
      `OpenRouter ${opts.model} returned ${response.status}: ${(response.errorBody ?? '').substring(0, 200)}`,
      response.status
    );
  }

  if (!response.body) {
    throw new RoseStallError(`OpenRouter ${opts.model} 200 but empty body`);
  }

  yield* parseOpenAISSE(response.body, {
    actualModel: opts.model,
    poolName: opts.poolName,
    requestId: opts.requestId,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
}
