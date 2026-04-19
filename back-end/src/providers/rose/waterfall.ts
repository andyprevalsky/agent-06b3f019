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
}

function buildOpenRouterBody(opts: {
  model: string;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  temperature?: number;
  maxTokens?: number;
}): Record<string, any> {
  const body: Record<string, any> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  return body;
}

export async function* waterfallComplete(
  opts: WaterfallOptions
): AsyncIterable<RoseStreamChunk> {
  const stepErrors: RoseStepError[] = [];
  const perStepMs = opts.perStepTimeoutMs ?? PER_STEP_TIMEOUT_MS;

  for (let idx = 0; idx < opts.poolSpec.waterfall.length; idx++) {
    const model = opts.poolSpec.waterfall[idx];
    log.info('step', {
      request_id: opts.requestId,
      call_site: opts.callSite,
      pool: opts.poolSpec.name,
      step: idx + 1,
      total: opts.poolSpec.waterfall.length,
      model,
    });

    const body = buildOpenRouterBody({
      model,
      messages: opts.messages,
      responseFormat: opts.responseFormat,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });

    try {
      yield* streamOneStep({
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
      return;
    } catch (err) {
      const re = err instanceof RoseError ? err : new RoseError(String(err));
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
  body: Record<string, any>;
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
