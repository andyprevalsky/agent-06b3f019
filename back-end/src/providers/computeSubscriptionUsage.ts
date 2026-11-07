/**
 * Subscription usage windows (5h / 7d), reported by the agents that use a token.
 *
 * Providers return the account's remaining quota on every response (Anthropic
 * `anthropic-ratelimit-unified-{5h,7d}-*`, Codex `x-codex-{primary,secondary}-*`).
 * Agents keep the latest snapshot per token and carry it on the lineage
 * heartbeat they already send before each LLM attempt, so recording usage adds
 * no request: this module only validates that payload and stores it on the
 * Integration row that served the token.
 *
 * 10k agents: one PK read of the lease plus one conditional UPDATE per
 * heartbeat that carries a snapshot. The UPDATE matches only when the row's
 * stored observation is older than USAGE_WRITE_MIN_INTERVAL_MS, so a busy
 * account is written at most about once per interval no matter how many agents
 * share it, and an older snapshot can never overwrite a newer one.
 */

import { prisma } from './database';

export const USAGE_WRITE_MIN_INTERVAL_MS = 15_000;
/** Worker clocks drift; an observation from the future is clamped to now. */
const MAX_FUTURE_SKEW_MS = 60_000;

export interface UsageWindowReport {
  usedPct: number;
  resetsAt: Date | null;
}

export interface SubscriptionUsageReport {
  integrationId: string;
  observedAt: Date;
  fiveHour?: UsageWindowReport | null;
  sevenDay?: UsageWindowReport | null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** undefined = window absent from the report (leave stored value); null = invalid. */
function parseWindow(value: unknown): UsageWindowReport | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const used = record.usedPct;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return {
    usedPct: Math.min(100, Math.max(0, used)),
    resetsAt: parseDate(record.resetsAt),
  };
}

/**
 * The optional `integrationId` + `usage` fields of a heartbeat body. Returns
 * null when the body carries no usable snapshot; a malformed snapshot is
 * dropped rather than failing the heartbeat it rides on.
 */
export function parseSubscriptionUsageReport(
  body: Record<string, unknown>,
  now = new Date()
): SubscriptionUsageReport | null {
  const integrationId = typeof body.integrationId === 'string' ? body.integrationId.trim() : '';
  const usage = body.usage;
  if (integrationId === '' || usage === null || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const observed = parseDate(record.observedAt);
  if (observed === null) return null;
  const fiveHour = parseWindow(record.fiveHour);
  const sevenDay = parseWindow(record.sevenDay);
  if (fiveHour === null || sevenDay === null) return null;
  if (fiveHour === undefined && sevenDay === undefined) return null;
  const latest = now.getTime() + MAX_FUTURE_SKEW_MS;
  return {
    integrationId,
    observedAt: observed.getTime() > latest ? now : observed,
    fiveHour,
    sevenDay,
  };
}

function integrationNameForTokenType(tokenType: string): 'claude_code' | 'gpt_code' | null {
  if (tokenType === 'claude') return 'claude_code';
  if (tokenType === 'gpt') return 'gpt_code';
  return null;
}

/**
 * Store a snapshot on the Integration that served the lease. The row must be
 * the lease's own token (its user's rows, or the exact pool row), so a worker
 * cannot write usage onto another account.
 */
export async function recordSubscriptionUsage(
  lineageKey: string,
  report: SubscriptionUsageReport
): Promise<boolean> {
  const lease = await prisma.computeTokenLineageLease.findUnique({
    where: { lineageKey },
    select: { tokenType: true, tokenSource: true, tokenIdentity: true, releasedAt: true },
  });
  if (lease === null || lease.releasedAt !== null) return false;
  const name = integrationNameForTokenType(lease.tokenType);
  if (name === null) return false;
  let owner: { id: string } | { userId: string };
  if (lease.tokenSource === 'pool') {
    if (lease.tokenIdentity !== report.integrationId) return false;
    owner = { id: lease.tokenIdentity };
  } else if (lease.tokenSource === 'user') {
    owner = { userId: lease.tokenIdentity };
  } else {
    return false;
  }
  const staleBefore = new Date(report.observedAt.getTime() - USAGE_WRITE_MIN_INTERVAL_MS);
  const result = await prisma.integration.updateMany({
    where: {
      id: report.integrationId,
      name,
      ...owner,
      OR: [{ usageObservedAt: null }, { usageObservedAt: { lte: staleBefore } }],
    },
    data: {
      usageObservedAt: report.observedAt,
      ...(report.fiveHour
        ? { usage5hUsedPct: report.fiveHour.usedPct, usage5hResetsAt: report.fiveHour.resetsAt }
        : {}),
      ...(report.sevenDay
        ? { usage7dUsedPct: report.sevenDay.usedPct, usage7dResetsAt: report.sevenDay.resetsAt }
        : {}),
    },
  });
  return result.count > 0;
}

/**
 * Usage + cooldown of a user's compute Integration rows, keyed by (name,
 * accountId) like their account connections. One indexed read per list.
 */
export async function listComputeIntegrationUsage(userId: string, provider?: string) {
  const names =
    provider === 'claude' ? ['claude_code'] : provider === 'codex' ? ['gpt_code'] : undefined;
  return prisma.integration.findMany({
    where: { userId, name: { in: names ?? ['claude_code', 'gpt_code'] } },
    select: {
      name: true,
      accountId: true,
      rateLimitedUntil: true,
      usage5hUsedPct: true,
      usage5hResetsAt: true,
      usage7dUsedPct: true,
      usage7dResetsAt: true,
      usageObservedAt: true,
    },
  });
}
