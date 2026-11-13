/**
 * Subscription usage from the backend's own Rose completions (chat, supervisor,
 * schema and classifier calls): the TypeScript twin of
 * agents/providers/rose/subscription_usage.py.
 *
 * Claude and Codex report the account's 5h / 7d windows on every response,
 * success or failure (Anthropic `anthropic-ratelimit-unified-*`, Codex
 * `x-codex-{primary,secondary}-*` plus a `usage_limit_reached` body). The
 * agents deliver them on their lease heartbeat; this process holds the token
 * itself, so it writes the snapshot straight onto the Integration row that
 * served it, in the background.
 *
 *   fetchComputeTokenForUser ──rememberSubscriptionCredential──► credentials[fp]
 *                                                   { name, integrationId }
 *   claudeAuth / gptAuth response ──observeSubscriptionUsage──►
 *        ├─ headers (+ failure body) → snapshot; nothing when absent
 *        ├─ a rejected window → limitReasons[fp] (names the cooldown marked next)
 *        └─ known credential, and a failure or ≥ WRITE_MIN_INTERVAL_MS since
 *           its last write → void sink.write(recordIntegrationUsage)
 *                            (never awaited, never throws)
 *   markComputeTokenUnavailable ──subscriptionCooldownMeta──► rateLimitReason +
 *        rateLimitAuthoritative (the provider gave the reset, or Rose's backoff)
 *
 * Absent information is never turned into zero quota, and a token this process
 * did not lease names no row, so it records nothing.
 *
 * 10k agents: the maps hold fingerprints (never tokens) and are bounded at
 * MAX_TRACKED_CREDENTIALS; each credential costs at most one conditional UPDATE
 * per WRITE_MIN_INTERVAL_MS, plus one per failure, on its own row only.
 */

import crypto from 'crypto';

import {
  parseUsagePayload,
  recordIntegrationUsage,
  type CooldownReason,
  type UsageStatus,
} from '../computeSubscriptionUsage';
import { createLogger } from '../logger';

const log = createLogger('RoseSubscriptionUsage');

export const MAX_TRACKED_CREDENTIALS = 10_000;
/** Matches the backend's per-account write throttle (USAGE_WRITE_MIN_INTERVAL_MS). */
export const WRITE_MIN_INTERVAL_MS = 15_000;
/** How long a rejected window names the reason of the cooldown that follows it. */
const LIMIT_REASON_TTL_MS = 120_000;
/** Codex reports each window's length: at most this is the 5h window... */
const FIVE_HOUR_MAX_MINUTES = 6 * 60;
/** ...and at least this is the weekly one. */
const SEVEN_DAY_MIN_MINUTES = 6 * 24 * 60;

type TokenType = 'claude' | 'gpt';
type IntegrationName = 'claude_code' | 'gpt_code';
type WindowKey = 'fiveHour' | 'sevenDay';
type HeaderSource = Pick<Headers, 'get'> | null | undefined;

export interface UsageWindowSnapshot {
  usedPct: number;
  resetsAt: string | null;
}

/** Same shape as the agents' heartbeat `usage` (parseUsagePayload validates it). */
export interface SubscriptionUsageSnapshot {
  observedAt: string;
  fiveHour: UsageWindowSnapshot | null;
  sevenDay: UsageWindowSnapshot | null;
  source: 'response' | 'rate_limit';
  status: UsageStatus | null;
}

interface RememberedCredential {
  name: IntegrationName;
  integrationId: string;
}

const STATUSES: readonly UsageStatus[] = ['allowed', 'allowed_warning', 'rejected'];
const CLAIM_WINDOWS: Record<string, WindowKey> = {
  five_hour: 'fiveHour',
  '5h': 'fiveHour',
  seven_day: 'sevenDay',
  '7d': 'sevenDay',
};
const WINDOW_REASONS: Record<WindowKey, CooldownReason> = {
  fiveHour: 'usage_window_5h',
  sevenDay: 'usage_window_7d',
};

const credentials = new Map<string, RememberedCredential>();
const lastWrite = new Map<string, number>();
const limitReasons = new Map<string, { reason: CooldownReason; at: number }>();

/**
 * Where snapshots are written. Production writes the Integration row; the
 * blackbox swaps in a stalled writer to prove a completion never waits on it.
 */
export const subscriptionUsageSink = {
  write: recordIntegrationUsage,
};

function fingerprint(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
}

function bump<V>(store: Map<string, V>, key: string, value: V): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > MAX_TRACKED_CREDENTIALS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function parseNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEpoch(value: unknown): string | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? parseNumber(value) : null;
  if (parsed === null || !Number.isFinite(parsed)) return null;
  const epochSeconds = parsed > 10_000_000_000 ? parsed / 1000 : parsed;
  if (epochSeconds < 1_000_000_000) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

function usageWindow(usedPct: number | null, resetsAt: string | null): UsageWindowSnapshot | null {
  if (usedPct === null) return null;
  return { usedPct: Math.round(Math.min(100, Math.max(0, usedPct)) * 100) / 100, resetsAt };
}

function header(headers: HeaderSource, name: string): string | null {
  try {
    return headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

type Windows = Record<WindowKey, UsageWindowSnapshot | null>;

function claudeWindows(headers: HeaderSource): Windows {
  const window = (key: string) => {
    const utilization = parseNumber(
      header(headers, `anthropic-ratelimit-unified-${key}-utilization`)
    );
    return usageWindow(
      utilization === null ? null : utilization * 100,
      parseEpoch(header(headers, `anthropic-ratelimit-unified-${key}-reset`))
    );
  };
  return { fiveHour: window('5h'), sevenDay: window('7d') };
}

/** The window a `rejected` unified status names, marked 100% used in place. */
function claudeRejectedWindow(headers: HeaderSource, windows: Windows): WindowKey | null {
  const claim = (header(headers, 'anthropic-ratelimit-unified-representative-claim') ?? '')
    .trim()
    .toLowerCase();
  let key: WindowKey | null = CLAIM_WINDOWS[claim] ?? null;
  if (key === null) {
    const exhausted = (Object.keys(windows) as WindowKey[]).filter(
      (k) => (windows[k]?.usedPct ?? 0) >= 100
    );
    key = exhausted.length === 1 ? exhausted[0] : null;
  }
  if (key === null) return null;
  const resetsAt =
    windows[key]?.resetsAt ?? parseEpoch(header(headers, 'anthropic-ratelimit-unified-reset'));
  windows[key] = { usedPct: 100, resetsAt };
  return key;
}

function codexWindows(headers: HeaderSource, now: Date): Windows {
  const windows: Windows = { fiveHour: null, sevenDay: null };
  for (const [slot, defaultKey] of [
    ['primary', 'fiveHour'],
    ['secondary', 'sevenDay'],
  ] as const) {
    const prefix = `x-codex-${slot}`;
    let resetsAt = parseEpoch(header(headers, `${prefix}-reset-at`));
    if (resetsAt === null) {
      const after = parseNumber(header(headers, `${prefix}-reset-after-seconds`));
      if (after !== null && after >= 0)
        resetsAt = new Date(now.getTime() + after * 1000).toISOString();
    }
    const window = usageWindow(parseNumber(header(headers, `${prefix}-used-percent`)), resetsAt);
    if (window === null) continue;
    const minutes = parseNumber(header(headers, `${prefix}-window-minutes`));
    const key: WindowKey | null =
      minutes === null
        ? defaultKey
        : minutes <= FIVE_HOUR_MAX_MINUTES
          ? 'fiveHour'
          : minutes >= SEVEN_DAY_MIN_MINUTES
            ? 'sevenDay'
            : null;
    if (key !== null) windows[key] = window;
  }
  return windows;
}

/** `resets_at` of a Codex usage-limit body; '' when it is one without a reset; null otherwise. */
function codexLimitReset(body: string | undefined, now: Date): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const error =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).error
      : undefined;
  if (error === null || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  if (record.type !== 'usage_limit_reached' && record.type !== 'usage_limit_exceeded') return null;
  const resetsAt = parseEpoch(record.resets_at);
  if (resetsAt !== null) return resetsAt;
  const resetsIn =
    typeof record.resets_in_seconds === 'number' ? record.resets_in_seconds : Number.NaN;
  if (Number.isFinite(resetsIn) && resetsIn >= 0) {
    return new Date(now.getTime() + resetsIn * 1000).toISOString();
  }
  return '';
}

/** Which Codex window a usage-limit failure exhausted, when the headers say. */
function codexRejectedWindow(windows: Windows, resetsAt: string | null): WindowKey | null {
  const exhausted = (Object.keys(windows) as WindowKey[]).filter(
    (k) => (windows[k]?.usedPct ?? 0) >= 100
  );
  if (exhausted.length !== 1) return null;
  const key = exhausted[0];
  windows[key] = { usedPct: 100, resetsAt: resetsAt ?? windows[key]?.resetsAt ?? null };
  return key;
}

/**
 * The usage snapshot one provider response carries (headers, plus a failure
 * body for Codex), and the cooldown reason a rejection names. Both null when
 * the response says nothing about the account's windows.
 */
export function analyzeSubscriptionUsage(
  type: TokenType,
  headers: HeaderSource,
  options: { status: number; body?: string; now?: Date }
): { snapshot: SubscriptionUsageSnapshot | null; reason: CooldownReason | null } {
  const now = options.now ?? new Date();
  const failed = options.status >= 400;
  let status: UsageStatus | null = null;
  let reason: CooldownReason | null = null;
  let windows: Windows;
  if (type === 'claude') {
    windows = claudeWindows(headers);
    const raw = (header(headers, 'anthropic-ratelimit-unified-status') ?? '').trim().toLowerCase();
    status = (STATUSES as readonly string[]).includes(raw) ? (raw as UsageStatus) : null;
    if (status === 'rejected') {
      const key = claudeRejectedWindow(headers, windows);
      reason = key === null ? 'usage_window' : WINDOW_REASONS[key];
    }
  } else {
    windows = codexWindows(headers, now);
    const limitReset = failed ? codexLimitReset(options.body, now) : null;
    if (limitReset !== null) {
      status = 'rejected';
      const key = codexRejectedWindow(windows, limitReset === '' ? null : limitReset);
      reason = key === null ? 'usage_window' : WINDOW_REASONS[key];
    }
  }
  if (windows.fiveHour === null && windows.sevenDay === null) return { snapshot: null, reason };
  return {
    snapshot: {
      observedAt: now.toISOString(),
      ...windows,
      source: failed || status === 'rejected' ? 'rate_limit' : 'response',
      status,
    },
    reason,
  };
}

/**
 * Name the Integration row a leased token came from, so this process's own
 * responses on that token can be recorded against it. Never stores the token.
 */
export function rememberSubscriptionCredential(token: {
  type: TokenType;
  accessToken: string;
  integrationId?: string;
  poolTokenId?: string;
}): void {
  const integrationId = token.integrationId ?? token.poolTokenId ?? '';
  if (!token.accessToken || integrationId === '') return;
  bump(credentials, fingerprint(token.accessToken), {
    name: token.type === 'claude' ? 'claude_code' : 'gpt_code',
    integrationId,
  });
}

/**
 * Record what one response said about its subscription, in the background.
 * Called on every claudeAuth / gptAuth response, success or failure. Never
 * throws and never waits for the database.
 */
export function observeSubscriptionUsage(
  type: TokenType,
  accessToken: string | null | undefined,
  headers: HeaderSource,
  options: { status: number; body?: string }
): void {
  if (!accessToken) return;
  try {
    const now = new Date();
    const { snapshot, reason } = analyzeSubscriptionUsage(type, headers, { ...options, now });
    const key = fingerprint(accessToken);
    if (reason !== null) bump(limitReasons, key, { reason, at: now.getTime() });
    if (snapshot === null) return;
    const credential = credentials.get(key);
    if (credential === undefined) return;
    const urgent = options.status >= 400 || snapshot.status === 'rejected';
    const last = lastWrite.get(key);
    if (!urgent && last !== undefined && now.getTime() - last < WRITE_MIN_INTERVAL_MS) return;
    const report = parseUsagePayload(snapshot, credential.integrationId, now);
    if (report === null) return;
    bump(lastWrite, key, now.getTime());
    const write = subscriptionUsageSink.write;
    void Promise.resolve()
      .then(() => write(credential.name, report))
      .catch((error: unknown) => {
        log.warn('subscription_usage.write_failed', {
          integrationId: credential.integrationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } catch (error) {
    log.warn('subscription_usage.observe_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Cooldown metadata for a mark on this token: why (the window a recent
 * rejection named, else a plain rate limit or an auth failure) and whether the
 * reset came from the provider rather than Rose's default backoff.
 */
export function subscriptionCooldownMeta(
  accessToken: string,
  failure: 'auth_error' | 'rate_limit',
  providerReset: string | null | undefined
): { rateLimitReason: CooldownReason; rateLimitAuthoritative: boolean } {
  const authoritative = typeof providerReset === 'string' && providerReset !== '';
  if (failure === 'auth_error') return { rateLimitReason: 'auth', rateLimitAuthoritative: false };
  const key = fingerprint(accessToken);
  const entry = limitReasons.get(key);
  if (entry !== undefined && Date.now() - entry.at > LIMIT_REASON_TTL_MS) limitReasons.delete(key);
  const named = entry !== undefined && Date.now() - entry.at <= LIMIT_REASON_TTL_MS;
  return {
    rateLimitReason: named ? entry.reason : 'rate_limit',
    rateLimitAuthoritative: authoritative,
  };
}

/** Test seam: forget every remembered credential and observation. */
export function resetSubscriptionUsageState(): void {
  credentials.clear();
  lastWrite.clear();
  limitReasons.clear();
  subscriptionUsageSink.write = recordIntegrationUsage;
}
