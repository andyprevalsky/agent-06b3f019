/**
 * Microsoft Foundry GPT Responses fallback. Deployment names may differ from model IDs.
 *
 * The unsuffixed AZURE_FOUNDRY_ENDPOINT / _API_KEY / _DEPLOYMENTS variables are
 * region 1. AZURE_FOUNDRY_ENDPOINT_<n> / AZURE_FOUNDRY_API_KEY_<n> /
 * AZURE_FOUNDRY_DEPLOYMENTS_<n> (n = 2..9) add further Azure resources, normally
 * in other regions; a region needs both endpoint and key. Each route key ranks
 * regions by rendezvous hashing: one agent keeps a stable primary region (and its
 * prompt cache) while agents spread evenly, and a failing region's traffic spreads
 * over all remaining regions. Pre-content 429s, in-stream rate limits, 5xx and
 * transport errors try the next region; cooldowns are per (region, deployment).
 * Mirrors agents/providers/rose/foundry.py.
 */

import { createHash } from 'node:crypto';
import {
  foundryCooldownKey,
  InvalidFoundryCooldownRequest,
  readSharedFoundryCooldowns,
  reportSharedFoundryRateLimit,
  reportSharedFoundryServed,
} from '../foundryDeploymentCooldown';

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

/** Keyed by region endpoint: one key belongs to one Azure resource. */
const authCooldownUntil = new Map<string, number>();

const REGION_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const suffix = (slot: number): string => (slot === 1 ? '' : `_${slot}`);

export const FOUNDRY_REGION_ENV_NAMES: readonly string[] = REGION_SLOTS.flatMap((slot) =>
  ['ENDPOINT', 'API_KEY', 'DEPLOYMENTS'].map((name) => `AZURE_FOUNDRY_${name}${suffix(slot)}`)
);

/** `URL.canParse` needs Node 18.17; engines allow 18.0, so parse inside try/catch. */
function hostnameOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '';
  }
}

/** One Azure resource. The key is a private field, so JSON/inspect never render it. */
export class FoundryRegion {
  readonly #apiKey: string;
  readonly host: string;

  constructor(
    readonly slot: number,
    readonly endpoint: string,
    apiKey: string,
    readonly deployments: readonly string[]
  ) {
    this.#apiKey = apiKey;
    this.host = hostnameOf(endpoint);
  }

  apiKey(): string {
    return this.#apiKey;
  }

  toString(): string {
    return `FoundryRegion(${this.slot}, ${this.host})`;
  }
}

function configuredNames(variable: string): string[] {
  return (process.env[variable] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Configured regions in slot order; the endpoint drops a trailing `/openai/v1`. */
export function foundryRegions(): FoundryRegion[] {
  const regions: FoundryRegion[] = [];
  for (const slot of REGION_SLOTS) {
    const endpoint = process.env[`AZURE_FOUNDRY_ENDPOINT${suffix(slot)}`]?.trim();
    const apiKey = process.env[`AZURE_FOUNDRY_API_KEY${suffix(slot)}`]?.trim();
    if (!endpoint || !apiKey) continue;
    regions.push(
      new FoundryRegion(
        slot,
        endpoint.replace(/\/+$/, '').replace(/\/openai\/v1$/, ''),
        apiKey,
        configuredNames(`AZURE_FOUNDRY_DEPLOYMENTS${suffix(slot)}`)
      )
    );
  }
  return regions;
}

/** `${slot}\n${endpoint}` pairs already warned about, so a bad optional slot logs once. */
const warnedInsecureRegions = new Set<string>();

/**
 * Configured regions that routing may use: HTTPS endpoints only. A non-HTTPS
 * optional region (slot 2..9) is dropped with one warning naming its env slot,
 * so a typo there cannot stop the healthy regions. A non-HTTPS region 1, or a
 * configuration with no HTTPS region left, stays a whole-config error.
 * Mirrors `_routable_regions` in agents/providers/rose/foundry.py.
 */
function routableRegions(): FoundryRegion[] {
  const configured = foundryRegions();
  const usable = configured.filter((region) => region.endpoint.startsWith('https://'));
  const insecure = configured.filter((region) => !region.endpoint.startsWith('https://'));
  if (insecure.length && (insecure[0].slot === 1 || !usable.length))
    throw new RoseInvalidRequest(`AZURE_FOUNDRY_ENDPOINT${suffix(insecure[0].slot)} must be HTTPS`);
  for (const region of insecure) {
    const key = `${region.slot}\n${region.endpoint}`;
    if (warnedInsecureRegions.has(key)) continue;
    warnedInsecureRegions.add(key);
    log.warn('foundry.region_not_https', {
      env: `AZURE_FOUNDRY_ENDPOINT${suffix(region.slot)}`,
      region_slot: region.slot,
    });
  }
  return usable;
}

export function foundryConfigured(poolSpec: PoolSpec): boolean {
  if (!poolSpec.foundryEnabled) return false;
  let regions: FoundryRegion[];
  try {
    regions = routableRegions();
  } catch (error) {
    // Routing rejects this configuration; let foundryComplete surface that error.
    if (error instanceof RoseInvalidRequest) return true;
    throw error;
  }
  const now = Date.now();
  const models = foundryModels(poolSpec);
  const listed = isListed(regions, models);
  return regions.some(
    (region) =>
      now >= (authCooldownUntil.get(region.endpoint) ?? 0) &&
      regionDeployments(region, models, listed).length > 0
  );
}

/** Azure Sol deployments stand in for each other; other models serve only themselves. */
const FOUNDRY_SOL_MODELS: readonly string[] = ['gpt-6-sol', 'gpt-6.1-sol'];

/** Models whose Foundry deployments may serve the pool, its own model first. */
export function foundryModels(poolSpec: PoolSpec): string[] {
  const model = poolSpec.gptAuthModel;
  if (!FOUNDRY_SOL_MODELS.includes(model)) return [model];
  return [model, ...FOUNDRY_SOL_MODELS.filter((other) => other !== model)];
}

const asModels = (models: string | readonly string[]): readonly string[] =>
  typeof models === 'string' ? [models] : models;

const servesModel = (name: string, model: string): boolean =>
  name === model || name.startsWith(`${model}-`);

const matching = (configured: readonly string[], models: string | readonly string[]): string[] =>
  configured.filter((name) => asModels(models).some((model) => servesModel(name, model)));

const isListed = (regions: FoundryRegion[], models: string | readonly string[]): boolean =>
  regions.some((region) => matching(region.deployments, models).length > 0);

/** The model a deployment name serves: the first of `models` it equals or extends. */
const servedModel = (deployment: string, models: readonly string[]): string =>
  models.find((model) => servesModel(deployment, model)) ?? models[0];

function rotated(names: string[], routeKey: string): string[] {
  if (!names.length) return [];
  const start =
    parseInt(createHash('sha256').update(routeKey).digest('hex').slice(0, 8), 16) % names.length;
  return [...names.slice(start), ...names.slice(0, start)];
}

/**
 * Deployments serving `model`: configured names equal to it or prefixed
 * `<model>-`. A region's deployment list is shared by every Foundry pool, so one
 * pool's deployments never receive another pool's model. Without a matching
 * name, region 1 uses Foundry's deploymentless inference for the pool's own
 * model unless another region lists one of the models (that region is where it is deployed;
 * region 1's deploymentless call would be a terminal 400). Other regions serve
 * only the names they list, so a new resource holding only GPT-6 Sol never
 * receives Luna traffic that would fail there with DeploymentNotFound.
 */
function regionDeployments(
  region: FoundryRegion,
  models: string | readonly string[],
  listedElsewhere = false
): string[] {
  const names = matching(region.deployments, models);
  return region.slot === 1 && !names.length && !listedElsewhere ? [asModels(models)[0]] : names;
}

function rendezvousWeight(routeKey: string, region: FoundryRegion): bigint {
  return BigInt(
    `0x${createHash('sha256').update(`${routeKey}\n${region.endpoint}`).digest('hex').slice(0, 16)}`
  );
}

/** Every (region, deployment) to try, primary region first, for this route key. */
export function foundryRoutePlan(
  regions: FoundryRegion[],
  models: string | readonly string[],
  routeKey: string
): Array<{ region: FoundryRegion; deployment: string }> {
  const weights = new Map(regions.map((region) => [region, rendezvousWeight(routeKey, region)]));
  const listed = isListed(regions, models);
  return regions
    .filter((region) => regionDeployments(region, models, listed).length > 0)
    .sort((a, b) => {
      const wa = weights.get(a) ?? 0n;
      const wb = weights.get(b) ?? 0n;
      if (wa !== wb) return wa > wb ? -1 : 1;
      return a.slot - b.slot;
    })
    .flatMap((region) =>
      rotated(regionDeployments(region, models, listed), routeKey).map((deployment) => ({
        region,
        deployment,
      }))
    );
}

/** Test hook: forget every rate-limit and auth cooldown and every once-only warning. */
export function __resetFoundryCooldowns(): void {
  authCooldownUntil.clear();
  warnedInsecureRegions.clear();
}

function retryHintSeconds(headers: Headers, message = ''): number | undefined {
  const now = Date.now();
  const accept = (seconds: number): number | undefined =>
    Number.isFinite(seconds) &&
    seconds > 0 &&
    Number.isFinite(new Date(now + seconds * 1000).getTime())
      ? seconds
      : undefined;
  const retryAfterMs = headers.get('retry-after-ms');
  if (retryAfterMs !== null) {
    const seconds = accept(Number(retryAfterMs) / 1000);
    if (seconds !== undefined) return seconds;
  }
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter) {
    const numeric = Number(retryAfter);
    const seconds = accept(
      Number.isFinite(numeric) ? numeric : (Date.parse(retryAfter) - now) / 1000
    );
    if (seconds !== undefined) return seconds;
  }
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|seconds?|s)/i.exec(message);
  return match
    ? accept(Number(match[1]) / (match[2].toLowerCase() === 'ms' ? 1000 : 1))
    : undefined;
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

/** Classify a non-200 Foundry response and record the cooldown it implies. */
function recordHttpFailure(
  status: number,
  region: FoundryRegion,
  deployment: string,
  _headers: Headers
): RoseError {
  if (status === 429) {
    return new RoseRateLimitError(`Foundry deployment ${deployment} rate limited`, status);
  }
  if (status === 401 || status === 403) {
    // A key belongs to one Azure resource; other regions keep serving.
    authCooldownUntil.set(region.endpoint, Date.now() + 300_000);
    return new RoseAuthError(`Foundry authentication failed (${status})`, status);
  }
  if (status === 400)
    return new RoseInvalidRequest('Foundry rejected the Responses request', status);
  return new RoseServerError(`Foundry deployment ${deployment} returned ${status}`, status);
}

async function reportRateLimitOrFail(
  region: FoundryRegion,
  deployment: string,
  retryAfterSeconds?: number
): Promise<void> {
  try {
    await reportSharedFoundryRateLimit(region.host.toLowerCase(), deployment, retryAfterSeconds);
  } catch (cause) {
    throw Object.assign(new RoseServerError('Foundry shared cooldown authority unavailable'), { cause });
  }
}

export async function* foundryComplete(opts: FoundryOptions): AsyncIterable<RoseStreamChunk> {
  const models = foundryModels(opts.poolSpec);
  const regions = routableRegions();
  if (!regions.length) throw new RoseAuthError('Foundry endpoint or key missing');
  let lastError: RoseError | null = null;
  let skippedCooling = false;
  let attempt = 0;

  const plan = foundryRoutePlan(regions, models, opts.routeKey).filter(({ region, deployment }) => {
    try {
      foundryCooldownKey(region.host.toLowerCase(), deployment);
      return true;
    } catch (error) {
      if (error instanceof InvalidFoundryCooldownRequest) return false;
      throw error;
    }
  });
  if (plan.length === 0) throw new RoseInvalidRequest('Foundry has no valid deployment routes');
  let cooldowns: Awaited<ReturnType<typeof readSharedFoundryCooldowns>>;
  try {
    cooldowns = await readSharedFoundryCooldowns(
      plan.map(({ region, deployment }) => `${region.host.toLowerCase()}:${deployment}`)
    );
  } catch {
    throw new RoseServerError('Foundry shared cooldown authority unavailable');
  }
  for (const { region, deployment } of plan) {
    const now = Date.now();
    if (now < (authCooldownUntil.get(region.endpoint) ?? 0)) continue;
    if ((cooldowns[`${region.host.toLowerCase()}:${deployment}`]?.remainingSeconds ?? 0) > 0) {
      skippedCooling = true;
      continue;
    }
    attempt++;
    // Region identity only; the key is never part of any log event.
    const where = {
      request_id: opts.requestId,
      region: region.host,
      region_slot: region.slot,
      deployment,
    };
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
        endpoint: region.endpoint,
        apiKey: region.apiKey(),
        body,
        requestId: opts.requestId,
        callSite: opts.callSite,
        abortSignal: opts.abortSignal,
      });
    } catch (err) {
      if (opts.abortSignal?.aborted) throw err;
      const errorType = err instanceof Error ? err.name : 'unknown';
      lastError = new RoseServerError(`Foundry transport failed: ${errorType}`);
      log.warn('foundry.transport_failed', { ...where, error_type: errorType });
      continue;
    }

    if (response.status !== 200) {
      const status = response.status;
      lastError = recordHttpFailure(status, region, deployment, response.headers);
      if (status === 429)
        await reportRateLimitOrFail(
          region,
          deployment,
          retryHintSeconds(response.headers)
        );
      log.warn('foundry.attempt_failed', { ...where, status });
      // A request-shape error applies to every region and deployment.
      if (status === 400) break;
      continue;
    }
    if (!response.body) {
      lastError = new RoseServerError('Foundry returned an empty stream');
      log.warn('foundry.stream_failed', { ...where, error_type: lastError.name });
      continue;
    }
    let buffered: RoseStreamChunk | null = null;
    let yieldedVisible = false;
    try {
      for await (const chunk of parseResponsesSSE(response.body, {
        actualModel: `${servedModel(deployment, models)}-foundry`,
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
      log.info('foundry.served', { ...where, attempt });
      try {
        if ((cooldowns[`${region.host.toLowerCase()}:${deployment}`]?.strikes ?? 0) > 0) {
          await reportSharedFoundryServed(region.host.toLowerCase(), deployment);
        }
      } catch (error) {
        log.warn('foundry.shared_cooldown_reset_failed', { error: String(error) });
      }
      return;
    } catch (err) {
      if (err instanceof RoseRateLimitError) {
        await reportRateLimitOrFail(
          region,
          deployment,
          retryHintSeconds(response.headers, err.message)
        );
      }
      if (yieldedVisible || opts.abortSignal?.aborted) throw err;
      lastError =
        err instanceof RoseError
          ? err
          : new RoseServerError(
              `Foundry stream failed: ${err instanceof Error ? err.name : 'unknown'}`
            );
      log.warn('foundry.stream_failed', { ...where, error_type: lastError.name });
      // An in-stream request-shape rejection is the same everywhere.
      if (lastError instanceof RoseInvalidRequest) break;
    }
  }
  if (lastError) throw lastError;
  // Every candidate is cooling; let the waterfall move on without a request.
  if (skippedCooling)
    throw new RoseRateLimitError('Every Foundry region and deployment is cooling down');
  throw new RoseServerError('No usable Foundry deployment');
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
