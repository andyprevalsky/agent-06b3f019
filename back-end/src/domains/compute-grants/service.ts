/**
 * Compute-grants service: wires recovery into the completion path.
 *
 * This is the piece that turns the orchestrator into a live behaviour. At
 * bootstrap, `installGrantRecovery()` registers a hook that the Rose completion
 * path calls when a provider reports a REVOKED grant; the hook mints a
 * replacement from the stored account connection and hands the token back so the
 * request can be retried on the subscription instead of falling onto paid models.
 *
 * The minter is injected rather than imported. In production it drives a remote
 * browser (Steel) via `cloudRemint`; in tests it is a stub. Keeping it behind an
 * interface means this file -- and everything that imports it -- stays free of
 * browser dependencies.
 */

import { listComputeIntegrationUsage } from '../../providers/computeSubscriptionUsage';
import { reconcileConnectionStatesFromIntegrations } from '../../providers/integrationConnectionSync';
import { createLogger } from '../../providers/logger';
import {
  ComputeGrantReminter,
  type GrantMinter,
  type RemintCoordination,
} from '../../providers/computeGrantRemint';
import { getEphemeral, putEphemeral, withSerializedLock } from '../../providers/sharedState';
import { registerGrantRecovery, type GrantRecoveryHook } from '../../providers/rose/grantRecovery';
import {
  createPrismaGrantStore,
  getConnectionSession,
  listConnections,
  removeConnection,
  upsertAccountConnection,
} from './repo';
import type {
  AccountUsageDto,
  ConnectAccountInput,
  ConnectedAccountDto,
  UsageWindowDto,
} from './types';

const log = createLogger('ComputeGrants');

export class NotFoundError extends Error {}

/**
 * A minter that refuses to mint.
 *
 * The deliberate default: until a browser-backed minter is installed, recovery
 * reports `needs_reconnect` rather than pretending to succeed. Silently doing
 * nothing here would look identical to a healthy system while every request
 * quietly fell through to paid models.
 */
export const unavailableMinter: GrantMinter = {
  async mint() {
    throw new Error(
      'no compute-grant minter installed; cannot mint from the account session. ' +
        'Install a browser-backed minter at bootstrap to enable automatic recovery.'
    );
  },
};

const REMINT_LOCK_WAIT_MS = 5 * 60_000;

/** Re-mints are single-flight and cooled down per account across every instance. */
const sharedRemintCoordination: RemintCoordination = {
  serialize: (key, fn) => withSerializedLock(key, fn, { waitMs: REMINT_LOCK_WAIT_MS }),
  cooldownUntil: async (key) =>
    (await getEphemeral<{ until: number }>('compute-grant-cooldown', key))?.until,
  startCooldown: (key, until, ttlMs) =>
    putEphemeral('compute-grant-cooldown', key, { until }, ttlMs),
};

export interface InstallRecoveryOptions {
  /** Mints a grant from an account session. Production supplies a Steel-backed one. */
  minter?: GrantMinter;
  surface?: string;
}

/**
 * Register the recovery hook. Idempotent; pass `null` minter to disable.
 *
 * Returns the hook so tests can drive it directly without going through Rose.
 */
export function installGrantRecovery(opts: InstallRecoveryOptions = {}): GrantRecoveryHook {
  const store = createPrismaGrantStore(opts.surface ?? 'cloud');
  const minter = opts.minter ?? unavailableMinter;
  const reminter = new ComputeGrantReminter({
    store,
    minter,
    coordination: sharedRemintCoordination,
    log: (event, fields) => log.info(event, fields),
  });

  const hook: GrantRecoveryHook = async (req) => {
    const outcome = await reminter.onCompletionFailure({
      userId: req.userId,
      provider: req.provider,
      accountId: req.accountId,
      grantId: req.grantId,
      status: req.status,
      body: req.body,
    });
    return {
      accessToken: outcome.accessToken,
      status: outcome.status,
      reason: outcome.reason,
    };
  };

  registerGrantRecovery(hook);
  log.info('grant_recovery.installed', { minter: opts.minter === undefined ? 'none' : 'browser' });
  return hook;
}

/**
 * Connect an account, or refresh an existing one's session.
 *
 * This is "Add account" behind the FE chips, and the documented recovery for a
 * connection in `needs_reconnect`: supplying a fresh session heals it, and every
 * grant minted afterwards flows from the new session.
 *
 * Multi-account is structural, not special-cased -- connections are keyed by
 * (userId, provider, accountId), so a second Claude or Codex account is just
 * another row. Nothing here is keyed by provider alone.
 */
export async function connectAccount(
  userId: string,
  input: ConnectAccountInput
): Promise<ConnectedAccountDto> {
  const row = await upsertAccountConnection({
    userId,
    provider: input.provider,
    accountId: input.accountId,
    accountEmail: input.accountEmail,
    session: input.session,
    sessionExpiresAt: input.sessionExpiresAt,
  });
  log.info('connection.upserted', {
    provider: input.provider,
    account_id: input.accountId,
    has_session: input.session !== undefined,
  });
  return {
    provider: row.provider,
    accountId: row.accountId,
    accountEmail: row.accountEmail,
    state: row.state,
    lastErrorReason: row.lastErrorReason,
    connectedAt: row.createdAt.toISOString(),
    usage: null,
    rateLimitedUntil: null,
  };
}

type UsageRow = Awaited<ReturnType<typeof listComputeIntegrationUsage>>[number];

function windowDto(usedPct: number | null, resetsAt: Date | null): UsageWindowDto | null {
  return usedPct === null ? null : { usedPct, resetsAt: resetsAt?.toISOString() ?? null };
}

function usageDto(row: UsageRow | undefined): AccountUsageDto | null {
  if (row === undefined || row.usageObservedAt === null) return null;
  return {
    fiveHour: windowDto(row.usage5hUsedPct, row.usage5hResetsAt),
    sevenDay: windowDto(row.usage7dUsedPct, row.usage7dResetsAt),
    observedAt: row.usageObservedAt.toISOString(),
  };
}

const PROVIDER_INTEGRATION: Record<string, string> = { claude: 'claude_code', codex: 'gpt_code' };

/**
 * Accounts for the FE rows. Grants are intentionally not exposed; each account
 * carries the usage agents last reported for the Integration row it mints into.
 */
export async function listConnectedAccounts(
  userId: string,
  provider?: string
): Promise<ConnectedAccountDto[]> {
  await reconcileConnectionStatesFromIntegrations(userId);
  const [rows, usageRows] = await Promise.all([
    listConnections(userId, provider),
    listComputeIntegrationUsage(userId, provider),
  ]);
  const usageByAccount = new Map(usageRows.map((u) => [`${u.name}:${u.accountId}`, u]));
  return rows.map((r) => {
    const usage = usageByAccount.get(`${PROVIDER_INTEGRATION[r.provider] ?? ''}:${r.accountId}`);
    return {
      provider: r.provider,
      accountId: r.accountId,
      accountEmail: r.accountEmail,
      state: r.state,
      lastErrorReason: r.lastErrorReason,
      connectedAt: r.createdAt.toISOString(),
      usage: usageDto(usage),
      rateLimitedUntil: usage?.rateLimitedUntil?.toISOString() ?? null,
    };
  });
}

/**
 * Disconnect one account.
 *
 * Scoped to a single accountId: removing one chip must never disturb another,
 * which is the eviction class this whole design exists to avoid.
 */
export async function disconnectAccount(
  userId: string,
  provider: string,
  accountId: string
): Promise<void> {
  const removed = await removeConnection(userId, provider, accountId);
  if (removed.count === 0) {
    throw new NotFoundError(`no connected ${provider} account ${accountId}`);
  }
  log.info('connection.removed', { provider, account_id: accountId });
}

/** Whether an account still has a usable session (i.e. can mint unattended). */
export async function connectionCanMint(
  userId: string,
  provider: string,
  accountId: string
): Promise<boolean> {
  const session = await getConnectionSession(userId, provider, accountId);
  return session !== null && session.length > 0;
}
