/** Microsoft Foundry GPT Responses fallback. Deployment names may differ from model IDs. */

import { createHash } from 'node:crypto';

import { buildCodexResponsesBody } from './gptAuth';
import {
  RoseAllFailed,
  RoseAuthError,
  RoseError,
  RoseInvalidRequest,
  RoseRateLimitError,
  RoseServerError,
} from './errors';
import { createLogger } from '../logger';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import type { PoolSpec } from './pools';
import { parseResponsesSSE } from './streaming';
import { postFoundryResponsesStream } from './transport';
import type {
  CompletionChunk,
  CompletionMessage,
  CompletionOptions,
  ResponseFormat,
  RoseStreamChunk,
} from './types';

const log = createLogger('Rose');

const cooldownUntil = new Map<string, number>();
let authCooldownUntil = 0;

export function foundryConfigured(poolSpec: PoolSpec): boolean {
  return Boolean(
    poolSpec.foundryEnabled &&
    Date.now() >= authCooldownUntil &&
    process.env.AZURE_FOUNDRY_ENDPOINT?.trim() &&
    process.env.AZURE_FOUNDRY_API_KEY?.trim()
  );
}

/**
 * Deployments serving `model`: configured names equal to it or prefixed
 * `<model>-`. AZURE_FOUNDRY_DEPLOYMENTS is shared by every Foundry pool, so one
 * pool's deployments never receive another pool's model; without a matching
 * name, Foundry's deploymentless inference serves the model id.
 */
export function orderedFoundryDeployments(model: string, routeKey: string): string[] {
  const configured = (process.env.AZURE_FOUNDRY_DEPLOYMENTS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const matching = configured.filter((name) => name === model || name.startsWith(`${model}-`));
  const names = matching.length ? matching : [model];
  const start =
    parseInt(createHash('sha256').update(routeKey).digest('hex').slice(0, 8), 16) % names.length;
  return [...names.slice(start), ...names.slice(0, start)];
}

function cooldownMs(headers: Headers): number {
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return Math.max(1_000, Math.min(60_000, ms));
  const seconds = Number(headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0)
    return Math.max(1_000, Math.min(60_000, seconds * 1_000));
  return 1_000;
}

export interface FoundryOptions {
  poolSpec: PoolSpec;
  messages: CompletionMessage[];
  responseFormat?: ResponseFormat;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  temperature?: number;
  effort?: string;
  providerFastMode?: boolean;
  requestId: string;
  routeKey: string;
  callSite?: string;
  abortSignal?: AbortSignal;
}

export async function* foundryComplete(opts: FoundryOptions): AsyncIterable<RoseStreamChunk> {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_FOUNDRY_API_KEY?.trim();
  if (!endpoint || !apiKey) throw new RoseAuthError('Foundry endpoint or key missing');
  let lastError: RoseError = new RoseServerError('No usable Foundry deployment');

  for (const deployment of orderedFoundryDeployments(opts.poolSpec.gptAuthModel, opts.routeKey)) {
    if (Date.now() < (cooldownUntil.get(deployment) ?? 0)) continue;
    const body = buildCodexResponsesBody({
      poolSpec: opts.poolSpec,
      modelOverride: deployment,
      messages: opts.messages,
      responseFormat: opts.responseFormat,
      tools: opts.tools,
      toolChoice: opts.toolChoice,
      temperature: opts.temperature,
      effort: opts.effort,
      providerFastMode: opts.providerFastMode,
      requestId: opts.requestId,
      // Foundry Standard deployments honor caller cache markers as breakpoints.
      cacheBreakpoints: true,
    });
    let response;
    try {
      response = await postFoundryResponsesStream({
        endpoint,
        apiKey,
        body,
        requestId: opts.requestId,
        callSite: opts.callSite,
        abortSignal: opts.abortSignal,
      });
    } catch (err) {
      if (opts.abortSignal?.aborted) throw err;
      lastError = new RoseServerError(
        `Foundry transport failed: ${err instanceof Error ? err.name : 'unknown'}`
      );
      continue;
    }

    if (response.status !== 200) {
      const status = response.status;
      if (status === 429) {
        cooldownUntil.set(deployment, Date.now() + cooldownMs(response.headers));
        lastError = new RoseRateLimitError(`Foundry deployment ${deployment} rate limited`, status);
      } else if (status === 401 || status === 403) {
        authCooldownUntil = Date.now() + 300_000;
        lastError = new RoseAuthError(`Foundry authentication failed (${status})`, status);
      } else if (status === 400) {
        lastError = new RoseInvalidRequest('Foundry rejected the Responses request', status);
      } else {
        lastError = new RoseServerError(
          `Foundry deployment ${deployment} returned ${status}`,
          status
        );
      }
      if ([400, 401, 403].includes(status)) break;
      continue;
    }
    if (!response.body) {
      lastError = new RoseServerError('Foundry returned an empty stream');
      continue;
    }
    let buffered: RoseStreamChunk | null = null;
    let yieldedVisible = false;
    try {
      for await (const chunk of parseResponsesSSE(response.body, {
        actualModel: `${opts.poolSpec.gptAuthModel}-foundry`,
        poolName: 'foundry',
        requestId: opts.requestId,
      })) {
        if (chunk.kind === 'metadata' && buffered === null) {
          buffered = chunk;
          continue;
        }
        if (buffered !== null) {
          yield buffered;
          buffered = null;
        }
        yieldedVisible = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (yieldedVisible || opts.abortSignal?.aborted) throw err;
      lastError =
        err instanceof RoseError
          ? err
          : new RoseServerError(
              `Foundry stream failed: ${err instanceof Error ? err.name : 'unknown'}`
            );
      if (lastError instanceof RoseRateLimitError) {
        cooldownUntil.set(deployment, Date.now() + cooldownMs(response.headers));
      }
    }
  }
  throw lastError;
}

/** Foundry request for one completion: the pool's GPT model and the caller's routing identity. */
export function foundryRequestFor(params: {
  poolSpec: PoolSpec;
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
}): FoundryOptions {
  const { options } = params;
  return {
    poolSpec: params.poolSpec,
    messages: options.messages,
    responseFormat: options.response_format,
    tools: options.tools,
    toolChoice: options.tool_choice,
    temperature: options.temperature,
    // A fallback layer: speed pools pin their fast effort (xhigh TTFT is slow).
    effort: params.poolSpec.waterfallReasoningEffort ?? options.effort,
    providerFastMode: options.provider_fast_mode,
    requestId: params.requestId,
    routeKey:
      options.route_key ??
      options.dump_context?.agent_id ??
      options.compute_grant?.userId ??
      params.requestId,
    callSite: params.callSite,
    abortSignal: options.abort_signal,
  };
}

/** Pre-content exhaustion: a fall-through sentinel, or a waterfall whose every step failed. */
export function isChatRouteExhausted(
  error: unknown
): error is PreContentFallThroughError | RoseAllFailed {
  return error instanceof PreContentFallThroughError || error instanceof RoseAllFailed;
}

/**
 * The chat-exclusive routes end at OpenRouter. When every one of their own
 * fallbacks failed before content, the pool's GPT model on funded Azure serves
 * the turn instead of failing it; normal chat latency is unchanged.
 */
export async function* chatFoundryLastResort(params: {
  /** Pre-content exhaustion: a fall-through sentinel or a waterfall whose every step failed. */
  exhausted: PreContentFallThroughError | RoseAllFailed;
  request: FoundryOptions;
  pool: string;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
}): AsyncIterable<CompletionChunk> {
  const { exhausted, request } = params;
  const cause = exhausted instanceof PreContentFallThroughError ? exhausted.cause : exhausted;
  if (!foundryConfigured(request.poolSpec) || request.abortSignal?.aborted) throw cause;
  log.warn('chat_foundry_last_resort.start', {
    request_id: request.requestId,
    pool: params.pool,
    reason: cause.name,
  });
  try {
    yield* runWithFallThrough({ produce: () => foundryComplete(request), emit: params.emit });
  } catch (error) {
    throw error instanceof PreContentFallThroughError ? cause : error;
  }
  log.info('chat_foundry_last_resort.done', { request_id: request.requestId, pool: params.pool });
}
