import { prisma, runTransactionWithRetry } from './database';

/**
 * Shared Azure Foundry rate-limit cooldown per (region host, deployment).
 *
 * Every agent worker process (8+ production Fly Machines, every benchmark
 * guest through the compute-token authority) reads and reports one row per
 * deployment here, so a rejection seen by one process stops the others from
 * re-hitting that deployment until it expires (RCA
 * 2026-10-20-foundry-deployment-cooldown-per-process).
 *
 * Length: the provider's own retry advice when the caller reports one
 * (codex-rs/codex-api/src/sse/responses_error.rs:90-125), otherwise an
 * escalating hold of 30 s, 60 s, then 300 s per deployment
 * (openclaw/src/agents/auth-profiles/usage-failure-state.ts:18-27). The strike
 * count survives expiry and resets when a request is served, or after 24 h
 * without a failure (openclaw FAILURE_WINDOW_MS).
 */
export const FOUNDRY_COOLDOWN_LADDER_SECONDS = [30, 60, 300] as const;
const STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS_PER_READ = 64;
const SENTINEL_USER_ID = '00000000-0000-0000-0000-000000000000';
const SENTINEL_NAME = 'foundry_deployment_cooldown';

export class InvalidFoundryCooldownRequest extends Error {}

/** `<region host>:<deployment>`; never an endpoint path or a key. */
function foundryCooldownKey(region: string, deployment: string): string {
  if (
    region.length > 253 ||
    !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(region) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(deployment)
  ) {
    throw new InvalidFoundryCooldownRequest('Invalid Foundry region host or deployment');
  }
  return `${region}:${deployment}`;
}

function identity(accountId: string) {
  return { userId: SENTINEL_USER_ID, name: SENTINEL_NAME, accountId };
}

function strikesOf(config: unknown, now: number): number {
  if (typeof config !== 'object' || config === null) return 0;
  const { strikes, lastFailureAt } = config as { strikes?: unknown; lastFailureAt?: unknown };
  if (typeof strikes !== 'number' || !Number.isInteger(strikes) || strikes < 0) return 0;
  if (typeof lastFailureAt !== 'string') return 0;
  const last = Date.parse(lastFailureAt);
  return Number.isFinite(last) && now - last <= STRIKE_WINDOW_MS ? strikes : 0;
}

export interface FoundryCooldownState {
  rateLimitedUntil: string | null;
  strikes: number;
}

/** One indexed read for every (region, deployment) a route plan may try. */
export async function getFoundryDeploymentCooldowns(
  keys: string[]
): Promise<Record<string, FoundryCooldownState>> {
  if (keys.length === 0 || keys.length > MAX_KEYS_PER_READ) {
    throw new InvalidFoundryCooldownRequest(`Provide 1-${MAX_KEYS_PER_READ} Foundry cooldown keys`);
  }
  const accountIds = keys.map((key) => {
    const separator = key.lastIndexOf(':');
    return foundryCooldownKey(key.slice(0, separator), key.slice(separator + 1));
  });
  const rows = await prisma.integration.findMany({
    where: { userId: SENTINEL_USER_ID, name: SENTINEL_NAME, accountId: { in: accountIds } },
    select: { accountId: true, rateLimitedUntil: true, config: true },
  });
  const now = Date.now();
  const result: Record<string, FoundryCooldownState> = {};
  for (const row of rows) {
    const until = row.rateLimitedUntil;
    result[row.accountId] = {
      rateLimitedUntil: until !== null && until.getTime() > now ? until.toISOString() : null,
      strikes: strikesOf(row.config, now),
    };
  }
  return result;
}

/**
 * Record a rate-limit rejection and return the shared expiry.
 *
 * A rejection reported while the deployment is already cooling is the same
 * failure generation (requests already in flight when the first one failed):
 * it neither adds a strike nor shortens the window, and only a later provider
 * deadline extends it.
 */
export async function markFoundryDeploymentCooldown(
  region: string,
  deployment: string,
  retryAfterSeconds?: number
): Promise<FoundryCooldownState & { cooldownSeconds: number }> {
  const accountId = foundryCooldownKey(region, deployment);
  let hint: number | undefined;
  if (retryAfterSeconds !== undefined) {
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      throw new InvalidFoundryCooldownRequest('retryAfterSeconds must be a positive number');
    }
    hint = retryAfterSeconds;
  }
  return runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`foundry-cooldown:${accountId}`}))`;
    const where = { userId_name_accountId: identity(accountId) };
    const row = await tx.integration.findUnique({
      where,
      select: { rateLimitedUntil: true, config: true },
    });
    const now = Date.now();
    const priorStrikes = strikesOf(row?.config, now);
    const activeUntil =
      row?.rateLimitedUntil !== null &&
      row?.rateLimitedUntil !== undefined &&
      row.rateLimitedUntil.getTime() > now
        ? row.rateLimitedUntil.getTime()
        : null;

    let strikes = priorStrikes;
    let untilMs: number;
    if (activeUntil !== null) {
      untilMs = hint !== undefined ? Math.max(activeUntil, now + hint * 1000) : activeUntil;
    } else {
      strikes = priorStrikes + 1;
      const ladder = FOUNDRY_COOLDOWN_LADDER_SECONDS;
      const seconds = hint ?? ladder[Math.min(strikes, ladder.length) - 1];
      untilMs = now + seconds * 1000;
    }
    const until = new Date(untilMs);
    const config = { strikes, lastFailureAt: new Date(now).toISOString() };
    await tx.integration.upsert({
      where,
      create: {
        ...identity(accountId),
        type: 'TOOL_SETUP',
        status: 'NOT_CONNECTED',
        rateLimitedUntil: until,
        config,
      },
      update: { rateLimitedUntil: until, config },
    });
    return {
      rateLimitedUntil: until.toISOString(),
      strikes,
      cooldownSeconds: Math.round((untilMs - now) / 1000),
    };
  });
}

/** A served request closes the escalation: the next rejection starts at 30 s. */
export async function markFoundryDeploymentServed(
  region: string,
  deployment: string
): Promise<{ reset: boolean }> {
  const accountId = foundryCooldownKey(region, deployment);
  const { count } = await prisma.integration.updateMany({
    where: {
      ...identity(accountId),
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lte: new Date() } }],
    },
    data: { config: { strikes: 0 } },
  });
  return { reset: count > 0 };
}
