// Blackbox cases that cool a shared funded key (GPT_API_KEY / ANTHROPIC_API_KEY)
// mutate state the whole backend under test reads: the server caches the
// cooldown in memory and only re-reads the shared row once per recheck
// interval (15s). Restoring the DB row is therefore not enough — a later case
// (e.g. the Codex E2B smoke, which may have no credential but the funded key)
// would still see the key cooled. Cases must wait until the server itself
// reports the restored state before handing the backend to the next case.

import { __resetAnthropicApiKeyCooldown } from '../../providers/computeCredentials';
import { prisma } from '../../providers/database';
import { __clearGptApiKeyCooldownCache } from '../../providers/gptCredentials';
import { retryWithBackoff } from '../../providers/retry';

type FundedKey = 'gpt' | 'anthropic';

const SHARED_KEY_COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';

interface CooldownRowData {
  rateLimitedUntil?: Date | null;
  failureReason?: string | null;
}

interface IntegrationCooldownDelegate {
  findUnique: (...args: unknown[]) => Promise<unknown>;
  upsert: (...args: unknown[]) => Promise<unknown>;
  deleteMany: (...args: unknown[]) => Promise<unknown>;
}

function sharedCooldownName(args: unknown[]): string | undefined {
  const where = (args[0] as { where?: unknown } | undefined)?.where as
    | {
        userId?: unknown;
        name?: unknown;
        userId_name_accountId?: { userId?: unknown; name?: unknown };
      }
    | undefined;
  const key = where?.userId_name_accountId ?? where;
  if (key?.userId !== SHARED_KEY_COOLDOWN_USER_ID || typeof key.name !== 'string') return undefined;
  return key.name;
}

/**
 * Run in-process cases against a private copy of the funded-key cooldown rows.
 *
 * Those rows are singletons that every process on the local database shares: the
 * `integrations` cooldown cases hold a real mark for a full server recheck, and a
 * deploy stack that gets a provider's payment-required response holds one for 30
 * minutes. A case that asserts which provider served a request must not inherit
 * those marks, and its resets must not delete a mark another case is asserting.
 */
export async function beginIsolatedFundedKeyCooldowns(): Promise<() => Promise<void>> {
  const integration = prisma.integration as unknown as IntegrationCooldownDelegate;
  const shared: IntegrationCooldownDelegate = {
    findUnique: integration.findUnique,
    upsert: integration.upsert,
    deleteMany: integration.deleteMany,
  };
  const rows = new Map<string, { rateLimitedUntil: Date | null; failureReason: string | null }>();
  integration.findUnique = async (...args: unknown[]) => {
    const name = sharedCooldownName(args);
    if (name === undefined) return shared.findUnique.apply(prisma.integration, args);
    return rows.get(name) ?? null;
  };
  integration.upsert = async (...args: unknown[]) => {
    const name = sharedCooldownName(args);
    if (name === undefined) return shared.upsert.apply(prisma.integration, args);
    const { create, update } = args[0] as { create?: CooldownRowData; update?: CooldownRowData };
    const data = rows.has(name) ? update : create;
    const row = {
      rateLimitedUntil: data?.rateLimitedUntil ?? null,
      failureReason: data?.failureReason ?? null,
    };
    rows.set(name, row);
    return row;
  };
  integration.deleteMany = async (...args: unknown[]) => {
    const name = sharedCooldownName(args);
    if (name === undefined) return shared.deleteMany.apply(prisma.integration, args);
    return { count: rows.delete(name) ? 1 : 0 };
  };
  const resetCaches = async (): Promise<void> => {
    __clearGptApiKeyCooldownCache();
    await __resetAnthropicApiKeyCooldown();
  };
  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      await resetCaches();
    } finally {
      integration.findUnique = shared.findUnique;
      integration.upsert = shared.upsert;
      integration.deleteMany = shared.deleteMany;
    }
  };
  try {
    await resetCaches();
    return finish;
  } catch (error) {
    await finish();
    throw error;
  }
}

export async function withIsolatedFundedKeyCooldowns<T>(run: () => Promise<T>): Promise<T> {
  const finish = await beginIsolatedFundedKeyCooldowns();
  try {
    return await run();
  } finally {
    await finish();
  }
}

const COOLDOWN_PATHS: Record<FundedKey, string> = {
  gpt: '/api/integrations/compute-code/gpt-key/cooldown',
  anthropic: '/api/integrations/compute-code/anthropic-key/cooldown',
};

// The server re-reads the shared row every 15s; 40 polls 500ms apart cover one
// full recheck interval plus slack.
const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 500;

export function cooldownIsLive(row: { rateLimitedUntil: Date | null } | null): boolean {
  return row?.rateLimitedUntil instanceof Date && row.rateLimitedUntil.getTime() > Date.now();
}

export async function waitForServerFundedKeyCooldown(options: {
  baseUrl: string;
  apiKey: string;
  key: FundedKey;
  onCooldown: boolean;
}): Promise<void> {
  const reportsExpected = (state: { ok: boolean; onCooldown: unknown }) =>
    state.ok && state.onCooldown === options.onCooldown;
  const last = await retryWithBackoff(
    async () => {
      const res = await fetch(`${options.baseUrl}${COOLDOWN_PATHS[options.key]}`, {
        headers: { 'X-API-Key': options.apiKey },
      });
      const body = (await res.json().catch(() => null)) as { onCooldown?: unknown } | null;
      return { ok: res.ok, status: res.status, onCooldown: body?.onCooldown };
    },
    {
      maxRetries: POLL_ATTEMPTS,
      fixedDelays: Array.from({ length: POLL_ATTEMPTS }, () => POLL_INTERVAL_MS),
      shouldRetryResult: (state) => !reportsExpected(state),
      component: 'FundedKeyCooldownWait',
    }
  );
  if (!reportsExpected(last)) {
    throw new Error(
      `backend never reported ${options.key} funded key onCooldown=${options.onCooldown} after the shared row was restored (last: ${last.status} onCooldown=${String(last.onCooldown)})`
    );
  }
}
