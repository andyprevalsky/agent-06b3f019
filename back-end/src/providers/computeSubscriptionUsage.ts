/**
 * Subscription usage windows (5h / 7d), reported by the agents that use a token.
 *
 * Providers return the account's remaining quota on every response, success or
 * failure (Anthropic `anthropic-ratelimit-unified-{5h,7d}-*`, Codex
 * `x-codex-{primary,secondary}-*`). Agents keep the latest snapshot per token
 * and flush it on the lineage heartbeat right after the response (and before
 * each LLM attempt), so recording usage adds no provider request: this module
 * only validates that payload and stores it on the Integration row that served
 * the token. Code sessions report the CLI's rate_limit_event by task, and the
 * Claude usage endpoint or a one-token quota check (computeUsageRefresh) fills
 * accounts nothing measured.
 *
 *   source        response | rate_limit | usage_endpoint | code_session
 *   status        allowed | allowed_warning | rejected | null (provider's unified status)
 *   cooldown      Integration.rateLimitedUntil + rateLimitReason + rateLimitAuthoritative
 *   nextResetAt   earliest future reset of a spent window, else an authoritative cooldown
 *
 * A heartbeat that cannot name its login (the agent loop's lease carries no
 * integration id) names its token by credential fingerprint instead: the
 * lease's own user rows are matched against it (computeLoginFailure
 * resolveUserLoginByCredential), never another user's rows.
 *
 * 10k agents: one PK read of the lease plus one conditional UPDATE per
 * heartbeat that carries a snapshot. The UPDATE matches only when the row's
 * stored observation is older than USAGE_WRITE_MIN_INTERVAL_MS, so a busy
 * account is written at most about once per interval no matter how many agents
 * share it, and an older snapshot can never overwrite a newer one. A rejection
 * (status `rejected`) skips the interval — it is the observation the bar most
 * needs — but still never overwrites a newer one.
 */

import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('ComputeSubscriptionUsage');

export const USAGE_WRITE_MIN_INTERVAL_MS = 15_000;
/** Worker clocks drift; an observation from the future is clamped to now. */
const MAX_FUTURE_SKEW_MS = 60_000;
/**
 * A snapshot flushed as its lease is released (the last response of an agent)
 * still names that lease's token; it is accepted this long after the release.
 */
export const USAGE_RELEASED_LEASE_GRACE_MS = 120_000;

export const USAGE_SOURCES = ['response', 'rate_limit', 'usage_endpoint', 'code_session'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];
export const USAGE_STATUSES = ['allowed', 'allowed_warning', 'rejected'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];
export const COOLDOWN_REASONS = [
  'usage_window_5h',
  'usage_window_7d',
  'usage_window',
  'rate_limit',
  'stall',
  'auth',
] as const;
export type CooldownReason = (typeof COOLDOWN_REASONS)[number];

export interface UsageWindowReport {
  usedPct: number;
  resetsAt: Date | null;
}

export interface SubscriptionUsageReport {
  /** The login that served the lease; '' when only `credential` names it. */
  integrationId: string;
  /** Fingerprint of the token the agent held (codeLoginRejection credentialFingerprint). */
  credential?: string;
  observedAt: Date;
  fiveHour?: UsageWindowReport | null;
  sevenDay?: UsageWindowReport | null;
  source: UsageSource;
  status: UsageStatus | null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
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
 * The `usage` object of a report ({ observedAt, fiveHour?, sevenDay?, source?,
 * status? }), validated. Returns null when it carries no usable window; a
 * missing `source` is a response observation (older agents).
 */
export function parseUsagePayload(
  usage: unknown,
  integrationId: string,
  now = new Date()
): SubscriptionUsageReport | null {
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
    source: oneOf(USAGE_SOURCES, record.source) ?? 'response',
    status: oneOf(USAGE_STATUSES, record.status),
  };
}

/** parseUsagePayload's placeholder for a report its credential names (never stored). */
const UNNAMED_LOGIN = 'unnamed-login';

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
  if (integrationId !== '') return parseUsagePayload(body.usage, integrationId, now);
  // No login id: a token fingerprint still names it within the lease's own rows.
  const credential = typeof body.credential === 'string' ? body.credential.trim() : '';
  if (!/^[0-9a-f]{16}$/.test(credential)) return null;
  const report = parseUsagePayload(body.usage, UNNAMED_LOGIN, now);
  return report === null ? null : { ...report, integrationId: '', credential };
}

function integrationNameForTokenType(tokenType: string): 'claude_code' | 'gpt_code' | null {
  if (tokenType === 'claude') return 'claude_code';
  if (tokenType === 'gpt') return 'gpt_code';
  return null;
}

/**
 * The conditional write shared by every source. Matches only the named row and
 * only when its stored observation is older (by the throttle interval, unless
 * this is a rejection), so concurrent writers converge on the newest snapshot.
 */
async function applyUsageReport(
  where: Record<string, unknown>,
  report: SubscriptionUsageReport
): Promise<boolean> {
  const urgent = report.status === 'rejected';
  const staleBefore = urgent
    ? new Date(report.observedAt.getTime() - 1)
    : new Date(report.observedAt.getTime() - USAGE_WRITE_MIN_INTERVAL_MS);
  const result = await prisma.integration.updateMany({
    where: {
      ...where,
      id: report.integrationId,
      OR: [{ usageObservedAt: null }, { usageObservedAt: { lte: staleBefore } }],
    },
    data: {
      usageObservedAt: report.observedAt,
      usageSource: report.source,
      usageStatus: report.status,
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
 * Store a snapshot on the Integration that served the lease. The row must be
 * the lease's own token (its user's rows, or the exact pool row), so a worker
 * cannot write usage onto another account. A lease released moments ago still
 * names its token (the flush of an agent's last response races the release).
 */
export async function recordSubscriptionUsage(
  lineageKey: string,
  report: SubscriptionUsageReport,
  now = new Date(),
  resolveLogin: ResolveUserLogin = async () => null
): Promise<boolean> {
  const lease = await prisma.computeTokenLineageLease.findUnique({
    where: { lineageKey },
    select: { tokenType: true, tokenSource: true, tokenIdentity: true, releasedAt: true },
  });
  if (lease === null) return false;
  if (
    lease.releasedAt !== null &&
    now.getTime() - lease.releasedAt.getTime() > USAGE_RELEASED_LEASE_GRACE_MS
  ) {
    return false;
  }
  const name = integrationNameForTokenType(lease.tokenType);
  if (name === null) return false;
  let owner: { id: string } | { userId: string };
  let integrationId = report.integrationId;
  if (lease.tokenSource === 'pool') {
    // A pool lease names its own row; a report may only confirm it.
    if (integrationId === '') integrationId = lease.tokenIdentity;
    if (lease.tokenIdentity !== integrationId) return false;
    owner = { id: lease.tokenIdentity };
  } else if (lease.tokenSource === 'user') {
    owner = { userId: lease.tokenIdentity };
    if (integrationId === '') {
      const resolved =
        report.credential === undefined
          ? null
          : await resolveLogin(lease.tokenType, lease.tokenIdentity, report.credential);
      if (resolved === null) return false;
      integrationId = resolved;
    }
  } else {
    return false;
  }
  return applyUsageReport({ name, ...owner }, { ...report, integrationId });
}

/** The user's login (Integration id) whose stored token has this fingerprint, or null. */
export type ResolveUserLogin = (
  tokenType: string,
  userId: string,
  credential: string
) => Promise<string | null>;

/**
 * Store a snapshot measured outside a lease (the Claude usage endpoint, a code
 * session's CLI) on an Integration row the caller already resolved.
 */
export async function recordIntegrationUsage(
  name: 'claude_code' | 'gpt_code',
  report: SubscriptionUsageReport
): Promise<boolean> {
  return applyUsageReport({ name }, report);
}

/**
 * Reconcile a row's Rose backoff with what the provider just said about it.
 * Only Rose's own non-authoritative cooldown (a 429 without a reset, a stall,
 * or an older row with no metadata) is ever changed; a provider reset and an
 * auth cooldown never are:
 *   - allowed, no window spent → the backoff is lifted (the account serves again)
 *   - rejected with the spent window's reset → the cooldown becomes that reset,
 *     authoritative, so the account returns exactly when the provider says
 * Production on 2026-11-13: rows cooled to 2026-12-01 on Rose's backoff while
 * the provider reported 7d utilization 0 (allowed) or a 7d reset that day.
 *
 * 10k agents: one conditional UPDATE per usage refresh (at most one per row
 * per refresh interval), never on the completion path.
 */
export async function reconcileRoseCooldown(
  name: 'claude_code' | 'gpt_code',
  report: SubscriptionUsageReport,
  reason: CooldownReason | null,
  now = new Date()
): Promise<'lifted' | 'provider_reset' | 'unchanged'> {
  const windows = [report.fiveHour, report.sevenDay].filter(
    (w): w is UsageWindowReport => w !== null && w !== undefined
  );
  const spent = windows.filter((w) => w.usedPct >= 100);
  const where = {
    id: report.integrationId,
    name,
    rateLimitedUntil: { gt: now },
    AND: [
      { OR: [{ rateLimitAuthoritative: null }, { rateLimitAuthoritative: false }] },
      { OR: [{ rateLimitReason: null }, { rateLimitReason: { not: 'auth' } }] },
    ],
  };
  if (report.status === 'rejected') {
    const named =
      reason === 'usage_window_7d'
        ? report.sevenDay
        : reason === 'usage_window_5h'
          ? report.fiveHour
          : undefined;
    const resets = (named ? [named] : spent)
      .map((w) => w.resetsAt?.getTime() ?? NaN)
      .filter((t) => Number.isFinite(t) && t > now.getTime());
    if (resets.length === 0) return 'unchanged';
    const result = await prisma.integration.updateMany({
      where,
      data: {
        rateLimitedUntil: new Date(Math.max(...resets)),
        rateLimitReason: reason ?? 'usage_window',
        rateLimitAuthoritative: true,
      },
    });
    return result.count > 0 ? 'provider_reset' : 'unchanged';
  }
  if (windows.length === 0 || spent.length > 0) return 'unchanged';
  const result = await prisma.integration.updateMany({
    where,
    data: { rateLimitedUntil: null, rateLimitReason: null, rateLimitAuthoritative: null },
  });
  return result.count > 0 ? 'lifted' : 'unchanged';
}

/**
 * Record the subscription usage a code session's CLI reported (Claude Code's
 * rate_limit_event, every status) on the claude_code row the task ran on, so
 * code sessions feed the compute screen's usage bars like Rose calls do. A
 * task without a subscription login (funded key, Mac without a row) records
 * nothing; a malformed payload is dropped.
 */
export async function recordCodeTaskSubscriptionUsage(
  taskId: string,
  usage: unknown
): Promise<{ recorded: boolean }> {
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { claudeTokenSource: true, claudeTokenIntegrationId: true },
  });
  const integrationId = task?.claudeTokenIntegrationId ?? '';
  if (task === null || integrationId === '') return { recorded: false };
  if (task.claudeTokenSource !== 'user' && task.claudeTokenSource !== 'pool') {
    return { recorded: false };
  }
  const report = parseUsagePayload(usage, integrationId);
  if (report === null) return { recorded: false };
  return {
    recorded: await recordIntegrationUsage('claude_code', { ...report, source: 'code_session' }),
  };
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
      id: true,
      name: true,
      accountId: true,
      rateLimitedUntil: true,
      rateLimitReason: true,
      rateLimitAuthoritative: true,
      usage5hUsedPct: true,
      usage5hResetsAt: true,
      usage7dUsedPct: true,
      usage7dResetsAt: true,
      usageObservedAt: true,
      usageSource: true,
      usageStatus: true,
    },
  });
}

export type ComputeUsageRow = Awaited<ReturnType<typeof listComputeIntegrationUsage>>[number];

export interface UsageWindowView {
  usedPct: number;
  resetsAt: string | null;
}

export interface AccountUsageView {
  usage: {
    fiveHour: UsageWindowView | null;
    sevenDay: UsageWindowView | null;
    observedAt: string;
    source: UsageSource;
    status: UsageStatus | null;
  } | null;
  rateLimitedUntil: string | null;
  cooldown: { until: string; reason: CooldownReason; authoritative: boolean } | null;
  nextResetAt: string | null;
}

type UsageViewRow = Pick<
  ComputeUsageRow,
  | 'rateLimitedUntil'
  | 'rateLimitReason'
  | 'rateLimitAuthoritative'
  | 'usage5hUsedPct'
  | 'usage5hResetsAt'
  | 'usage7dUsedPct'
  | 'usage7dResetsAt'
  | 'usageObservedAt'
  | 'usageSource'
  | 'usageStatus'
>;

function windowView(usedPct: number | null, resetsAt: Date | null): UsageWindowView | null {
  return usedPct === null ? null : { usedPct, resetsAt: resetsAt?.toISOString() ?? null };
}

/**
 * What GET /api/compute-accounts returns for one account (contract with the
 * usage bar). Absent data stays absent: no usage → `usage: null` (unknown, never
 * "full" or "empty"); a cooldown is only `authoritative` when the provider gave
 * its reset; `nextResetAt` is the earliest future reset of a spent window (100%
 * used), else an authoritative cooldown's end — never Rose's own backoff.
 */
export function accountUsageView(
  row: UsageViewRow | undefined,
  now = new Date()
): AccountUsageView {
  if (row === undefined) {
    return { usage: null, rateLimitedUntil: null, cooldown: null, nextResetAt: null };
  }
  const nowMs = now.getTime();
  const usage =
    row.usageObservedAt === null
      ? null
      : {
          fiveHour: windowView(row.usage5hUsedPct, row.usage5hResetsAt),
          sevenDay: windowView(row.usage7dUsedPct, row.usage7dResetsAt),
          observedAt: row.usageObservedAt.toISOString(),
          source: oneOf(USAGE_SOURCES, row.usageSource) ?? 'response',
          status: oneOf(USAGE_STATUSES, row.usageStatus),
        };
  const until = row.rateLimitedUntil;
  const active = until !== null && until.getTime() > nowMs;
  const cooldown = active
    ? {
        until: until.toISOString(),
        reason: oneOf(COOLDOWN_REASONS, row.rateLimitReason) ?? 'rate_limit',
        authoritative: row.rateLimitAuthoritative === true,
      }
    : null;
  const windows: Array<[number | null, Date | null]> = [
    [row.usage5hUsedPct, row.usage5hResetsAt],
    [row.usage7dUsedPct, row.usage7dResetsAt],
  ];
  const spentResets = windows
    .filter(
      (entry): entry is [number, Date] =>
        entry[0] !== null && entry[0] >= 100 && entry[1] !== null && entry[1].getTime() > nowMs
    )
    .map(([, resetsAt]) => resetsAt.getTime());
  const nextResetMs =
    spentResets.length > 0
      ? Math.min(...spentResets)
      : cooldown?.authoritative === true
        ? until!.getTime()
        : null;
  return {
    usage,
    rateLimitedUntil: until?.toISOString() ?? null,
    cooldown,
    nextResetAt: nextResetMs === null ? null : new Date(nextResetMs).toISOString(),
  };
}

/** Optional cooldown metadata a rate-limit report may carry (agents, code sessions). */
export interface CooldownMeta {
  rateLimitReason?: string | null;
  rateLimitAuthoritative?: boolean | null;
}

/**
 * The cooldown a code session's structured CLI usage limit puts on its login: a
 * usage window, authoritative when the CLI carried the provider's reset (else
 * the writers' default backoff, flagged non-authoritative).
 */
export function cliUsageLimitCooldown(resetsAt: Date | null): {
  rateLimitedUntil: Date | undefined;
  rateLimitReason: CooldownReason;
  rateLimitAuthoritative: boolean;
} {
  return {
    rateLimitedUntil: resetsAt ?? undefined,
    rateLimitReason: 'usage_window',
    rateLimitAuthoritative: resetsAt !== null,
  };
}

/**
 * Integration columns for a cooldown's metadata. Written together with the
 * `rateLimitedUntil` they describe; a report that does not say leaves both
 * null (unknown → shown as a non-authoritative cooldown, never as exhausted).
 */
export function cooldownMetaFields(meta: CooldownMeta | undefined): {
  rateLimitReason: CooldownReason | null;
  rateLimitAuthoritative: boolean | null;
} {
  return {
    rateLimitReason: oneOf(COOLDOWN_REASONS, meta?.rateLimitReason),
    rateLimitAuthoritative:
      typeof meta?.rateLimitAuthoritative === 'boolean' ? meta.rateLimitAuthoritative : null,
  };
}

/**
 * The row filter of a user-source cooldown. With an integration or account id
 * it names that login. Without one it may only land on the user's single row of
 * `name`; with several rows it would cool down every sibling subscription
 * (all usage bars red at once), so it returns null and the report is dropped.
 * No row at all returns {} so the caller's own "nothing to rate-limit" path runs.
 */
export async function scopeUnnamedUserCooldown(
  userId: string,
  name: 'claude_code' | 'gpt_code',
  statuses: Array<'CONNECTED' | 'EXPIRED'>,
  options: { integrationId?: string | null; accountId?: string | null } | undefined
): Promise<{ id?: string; accountId?: string } | null> {
  if (options?.integrationId) {
    return {
      id: options.integrationId,
      ...(options.accountId ? { accountId: options.accountId } : {}),
    };
  }
  if (options?.accountId) return { accountId: options.accountId };
  const rows = await prisma.integration.findMany({
    where: { userId, name, status: { in: statuses } },
    select: { id: true },
    take: 2,
  });
  if (rows.length === 1) return { id: rows[0].id };
  if (rows.length === 0) return {};
  log.warn(`${name} cooldown for ${userId} names no login and the user has several; dropped`);
  return null;
}
