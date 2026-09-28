/** Microsoft Foundry GPT Responses fallback. Deployment names may differ from model IDs. */

import { createHash } from 'node:crypto';

import { buildCodexResponsesBody } from './gptAuth';
import {
  RoseAuthError,
  RoseError,
  RoseInvalidRequest,
  RoseRateLimitError,
  RoseServerError,
} from './errors';
import type { PoolSpec } from './pools';
import { parseResponsesSSE } from './streaming';
import { postFoundryResponsesStream } from './transport';
import type { CompletionMessage, ResponseFormat, RoseStreamChunk } from './types';

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

export function orderedFoundryDeployments(model: string, routeKey: string): string[] {
  const names = (process.env.AZURE_FOUNDRY_DEPLOYMENTS ?? model)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) return [];
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

interface FoundryOptions {
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
