/**
 * Background retrieval of a Claude subscription's usage windows (and their
 * reset times) for accounts the response-header path has not measured.
 *
 *   user:profile token:  GET https://api.anthropic.com/api/oauth/usage
 *     Authorization: Bearer <the account's OAuth access token>
 *     anthropic-beta: oauth-2025-04-20
 *   → { five_hour, seven_day, seven_day_opus, …: { utilization: 0-100 PERCENT, resets_at: ISO } | null }
 *
 *   inference-only token (setup-token, scopes ["user:inference"]), or one the
 *   endpoint refuses: Claude Code's quota check (claudeAiLimits.ts
 *   checkQuotaStatus), one max_tokens 1 subscription request (claudeQuotaCheck)
 *   whose anthropic-ratelimit-unified-* headers (200 or 429) carry the windows.
 *   The endpoint answers such a token 403 permission_error "OAuth token does not
 *   meet scope requirement user:profile"; Claude Code only calls it with
 *   user:profile (usage.ts fetchUtilization → hasProfileScope).
 *
 * STATE MACHINE (per Integration row, per process)
 *
 *   [idle] ──schedule(id)──► due? ──no──► (throttled: attempted < 5 min ago,
 *     ▲                       │            or unavailable < 60 min ago)
 *     │                      yes
 *     │                       ▼
 *     │                 read token ──none/expired──► [idle]
 *     │                       ├──user:profile──► GET usage (5 s) ──200──► store (usage_endpoint) ──► [idle]
 *     │                       │                       └──401/403──┐
 *     │                       ▼                                   ▼
 *     │                 quota check (max_tokens 1) ──unified headers──► store (response | rate_limit) ──► [idle]
 *     │                       ├──401/403, no headers──► [unavailable] backoff 60 min. NEVER an
 *     │                       │                         auth failure: the account is never touched
 *     └───────────────────────┴──other / network / bad body──► [idle] (retry after 5 min)
 *
 * Triggers (never awaited by their callers): a non-authoritative cooldown
 * (429 without a provider reset, a stall) reported for a Claude row, and
 * GET /api/compute-accounts for a Claude row with no usage, usage older than
 * USAGE_STALE_AFTER_MS, or a non-authoritative cooldown. The result appears on
 * the next list. Codex has no usage endpoint; its windows come only from
 * response headers and usage_limit_reached bodies.
 *
 * 10k agents: per account row, not per agent. At most one refresh per row per
 * REFRESH_MIN_INTERVAL_MS per backend process, each at most one GET plus one
 * one-token request (an inference-only row: the one request only), nothing on
 * the completion path, and a response that already carried usage headers keeps
 * the row fresh so this never fires for busy accounts.
 */

import { randomUUID } from 'node:crypto';

import { readClaudeUsageCredential } from './computeCredentials';
import {
  parseUsagePayload,
  recordIntegrationUsage,
  type SubscriptionUsageReport,
} from './computeSubscriptionUsage';
import { createLogger } from './logger';
import { claudeQuotaCheck } from './rose/claudeAuth';
import { analyzeSubscriptionUsage } from './rose/subscriptionUsage';

const log = createLogger('ComputeUsageRefresh');

export const USAGE_ENDPOINT_URL = 'https://api.anthropic.com/api/oauth/usage';
export const USAGE_ENDPOINT_BETA = 'oauth-2025-04-20';
export const USAGE_STALE_AFTER_MS = 30 * 60_000;
export const REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
export const UNAVAILABLE_BACKOFF_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_TRACKED_ROWS = 10_000;

export type RefreshOutcome =
  'stored' | 'not_newer' | 'throttled' | 'no_token' | 'unavailable' | 'empty' | 'error';

export interface UsageCredential {
  accessToken: string;
  /** The grant carries `user:profile`, which the usage endpoint requires. */
  profileScope: boolean;
}

export interface QuotaCheckResponse {
  status: number;
  headers: Pick<Headers, 'get'>;
  body?: string;
}

export interface RefreshDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readToken: (integrationId: string) => Promise<UsageCredential | null>;
  quotaCheck: (accessToken: string) => Promise<QuotaCheckResponse>;
  store: (report: SubscriptionUsageReport) => Promise<boolean>;
  now: () => Date;
}

const defaultDeps: RefreshDeps = {
  fetch: (url, init) => fetch(url, init),
  readToken: readClaudeUsageCredential,
  quotaCheck: (accessToken) =>
    claudeQuotaCheck({ token: accessToken, requestId: `usage-quota-${randomUUID()}` }),
  store: (report) => recordIntegrationUsage('claude_code', report),
  now: () => new Date(),
};

/** Next time each row may be fetched (ms epoch); bounded, insertion-ordered. */
const nextAttemptAt = new Map<string, number>();

function setNextAttempt(integrationId: string, at: number): void {
  nextAttemptAt.delete(integrationId);
  nextAttemptAt.set(integrationId, at);
  if (nextAttemptAt.size > MAX_TRACKED_ROWS) {
    const oldest = nextAttemptAt.keys().next().value;
    if (oldest !== undefined) nextAttemptAt.delete(oldest);
  }
}

/** Claim a fetch slot for this row now; false when one ran recently. */
function claimAttempt(integrationId: string, nowMs: number): boolean {
  const next = nextAttemptAt.get(integrationId);
  if (next !== undefined && next > nowMs) return false;
  setNextAttempt(integrationId, nowMs + REFRESH_MIN_INTERVAL_MS);
  return true;
}

export function resetUsageRefreshStateForTests(): void {
  nextAttemptAt.clear();
}

/**
 * Whether a Claude row's usage should be fetched: never measured, measured over
 * USAGE_STALE_AFTER_MS ago, or cooling down on Rose's own backoff (no provider
 * reset), so the bar can show the real windows instead.
 */
export function usageNeedsRefresh(
  row: {
    usageObservedAt: Date | null;
    rateLimitedUntil: Date | null;
    rateLimitAuthoritative: boolean | null;
  },
  now = new Date()
): boolean {
  const nowMs = now.getTime();
  if (row.usageObservedAt === null) return true;
  if (nowMs - row.usageObservedAt.getTime() > USAGE_STALE_AFTER_MS) return true;
  const cooling = row.rateLimitedUntil !== null && row.rateLimitedUntil.getTime() > nowMs;
  return cooling && row.rateLimitAuthoritative !== true;
}

function endpointWindow(value: unknown): { usedPct: number; resetsAt: Date | null } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const utilization = record.utilization;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  const reset = typeof record.resets_at === 'string' ? Date.parse(record.resets_at) : NaN;
  return {
    // The endpoint reports PERCENT (0-100), unlike the 0-1 response headers.
    usedPct: Math.min(100, Math.max(0, utilization)),
    resetsAt: Number.isNaN(reset) ? null : new Date(reset),
  };
}

/** The endpoint body → a usage report; null when it names neither account window. */
export function parseUsageEndpointBody(
  body: unknown,
  integrationId: string,
  now: Date
): SubscriptionUsageReport | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const fiveHour = endpointWindow(record.five_hour);
  const sevenDay = endpointWindow(record.seven_day);
  if (fiveHour === undefined && sevenDay === undefined) return null;
  return {
    integrationId,
    observedAt: now,
    fiveHour,
    sevenDay,
    source: 'usage_endpoint',
    // The endpoint gives utilization, not the unified allow/reject status.
    status: null,
  };
}

/** One user:profile token's usage-endpoint read; 'refused' when it rejects the token. */
async function readUsageEndpoint(
  integrationId: string,
  accessToken: string,
  now: Date,
  deps: RefreshDeps
): Promise<RefreshOutcome | 'refused'> {
  let response: Response;
  try {
    response = await deps.fetch(USAGE_ENDPOINT_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': USAGE_ENDPOINT_BETA,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log.info('usage_endpoint.request_failed', {
      integrationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
  if (response.status === 401 || response.status === 403) {
    // The endpoint does not accept this token (scope, or an access token the
    // device has not refreshed yet): ask the inference endpoint instead.
    log.info('usage_endpoint.refused', { integrationId, status: response.status });
    return 'refused';
  }
  if (!response.ok) {
    log.info('usage_endpoint.http_error', { integrationId, status: response.status });
    return 'error';
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return 'error';
  }
  const report = parseUsageEndpointBody(body, integrationId, now);
  if (report === null) return 'empty';
  return (await deps.store(report)) ? 'stored' : 'not_newer';
}

/** The quota check's unified headers → the row's windows (the chat path's own parser). */
async function readQuotaHeaders(
  integrationId: string,
  accessToken: string,
  now: Date,
  deps: RefreshDeps
): Promise<RefreshOutcome> {
  let response: QuotaCheckResponse;
  try {
    response = await deps.quotaCheck(accessToken);
  } catch (error) {
    log.info('quota_check.request_failed', {
      integrationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
  const { snapshot } = analyzeSubscriptionUsage('claude', response.headers, {
    status: response.status,
    body: response.body,
    now,
  });
  const report = snapshot === null ? null : parseUsagePayload(snapshot, integrationId, now);
  if (report !== null) return (await deps.store(report)) ? 'stored' : 'not_newer';
  if (response.status === 401 || response.status === 403) {
    // A refused token. Never an auth failure here: the lease path owns that
    // classification; the account keeps its state and we stop asking a while.
    setNextAttempt(integrationId, now.getTime() + UNAVAILABLE_BACKOFF_MS);
    log.info('quota_check.unavailable', { integrationId, status: response.status });
    return 'unavailable';
  }
  log.info('quota_check.no_usage', { integrationId, status: response.status });
  return response.status >= 400 ? 'error' : 'empty';
}

/** Fetch and store one Claude row's usage now (subject to the per-row throttle). */
export async function refreshClaudeUsage(
  integrationId: string,
  deps: RefreshDeps = defaultDeps
): Promise<RefreshOutcome> {
  const now = deps.now();
  if (!claimAttempt(integrationId, now.getTime())) return 'throttled';
  const credential = await deps.readToken(integrationId);
  if (credential === null || credential.accessToken === '') return 'no_token';
  if (credential.profileScope) {
    const outcome = await readUsageEndpoint(integrationId, credential.accessToken, now, deps);
    if (outcome !== 'refused') return outcome;
  }
  return readQuotaHeaders(integrationId, credential.accessToken, now, deps);
}

/**
 * Fire-and-forget refresh: returns immediately, never throws, never blocks the
 * caller (a completion's cooldown report or GET /api/compute-accounts).
 */
export function scheduleClaudeUsageRefresh(
  integrationId: string | null | undefined,
  deps: RefreshDeps = defaultDeps
): void {
  if (typeof integrationId !== 'string' || integrationId === '') return;
  const next = nextAttemptAt.get(integrationId);
  if (next !== undefined && next > deps.now().getTime()) return;
  void refreshClaudeUsage(integrationId, deps).catch((error: unknown) => {
    log.warn('usage_endpoint.refresh_failed', {
      integrationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
