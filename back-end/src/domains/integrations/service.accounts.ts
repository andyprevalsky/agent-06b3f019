/**
 * Sync-progress read/delete surface: each Integration row is ONE account.
 *
 *   GET    /api/integrations                         getIntegrationsWithAccounts
 *   GET    /api/integrations/progress?since=         getAccountsDelta
 *   DELETE /api/integrations/:provider/accounts/:id  deleteIntegrationAccount (alias)
 *   DELETE /api/integrations/:name                   deleteLegacyIntegration
 *
 * 10k rule: the list adds one indexed per-user progress read in parallel with
 * the existing query; the poll is two indexed per-user reads (light rows,
 * progress rows) bounded by the user's Integration rows. Nothing fans in across
 * users, and no work scales with synced items.
 */

import { createLogger } from '../../providers/logger';
import { withGoogleScopeHealth } from './integrationScopeHealth';
import { findIntegrationAccount, listAccountRowSources } from './repo.accounts';
import { listProgressForUser, type ProgressRow } from './repo.progress';
import * as service from './service';
import { accountOfRow, buildAccountsView, type AccountViewRow } from './service.accountsView';
import { LINKEDIN_INTEGRATION_NAME, settleLinkedInSync } from './service.linkedinSync';
import { clearAccountProgress } from './service.progress';
import {
  assertProviderSlug,
  InvalidAccountKeyError,
  TERMINAL_SYNC_STATES,
  toStorageAccountId,
  toWireAccountId,
  type ProgressDeltaResponse,
  type SyncState,
} from './syncAccountsContract';

const log = createLogger('IntegrationAccounts');

export class IntegrationAccountNotFoundError extends Error {
  constructor(provider: string, accountId: string) {
    super(`Integration account not found: ${provider}/${accountId}`);
  }
}

/** Only the default row has a whole-row delete to alias (DELETE /api/integrations/:name). */
export class AccountDeleteUnsupportedError extends Error {
  constructor(provider: string, accountId: string) {
    super(`Account ${provider}/${accountId} is removed through its provider's own flow`);
  }
}

export { InvalidAccountKeyError };

const progressKey = (provider: string, accountId: string) => `${provider}\u0000${accountId}`;

/**
 * The legacy list plus, on every row, `accounts`: exactly that row's one
 * account, and `accountsByProvider` with every row's account by row name.
 */
export async function getIntegrationsWithAccounts(userId: string) {
  const [base, progress] = await Promise.all([
    service.getIntegrations(userId),
    listProgressForUser(userId),
  ]);
  const now = new Date();
  const rows: AccountViewRow[] = base.integrations;
  const byKey = new Map(progress.map((p) => [progressKey(p.provider, p.accountId), p]));
  const integrations = base.integrations.map((integration) => ({
    ...integration,
    accounts: [
      accountOfRow(
        integration,
        byKey.get(progressKey(integration.name, integration.accountId)) ?? null,
        now
      ),
    ],
  }));
  const accountsByProvider = buildAccountsView({ rows, progress, now });
  return { ...base, integrations, accountsByProvider };
}

/**
 * A SYNCING LinkedIn row whose export agent ended reads SYNC_FAILED in the full
 * list (settleLinkedInSync); apply the same read-time settle to the light rows.
 * Only SYNCING LinkedIn rows are re-read (one per user).
 */
async function settleLightLinkedInRows<T extends AccountViewRow>(
  userId: string,
  rows: T[]
): Promise<T[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.name !== LINKEDIN_INTEGRATION_NAME || row.status !== 'SYNCING') return row;
      const stored = await findIntegrationAccount(userId, row.name, row.accountId);
      if (stored === null) return row;
      const [settled] = await settleLinkedInSync(userId, [stored]);
      return { ...row, status: settled.status, failureReason: settled.failureReason };
    })
  );
}

const isLiveRun = (row: ProgressRow) => !TERMINAL_SYNC_STATES.includes(row.state as SyncState);

/**
 * The bar poll. `accountsByProvider` is always the user's full account map (the
 * list's derivation); `changed` is false only when nothing it is derived from
 * changed after `since` and no run or row is mid-sync (a live run's view can
 * change with time alone, e.g. when its writer goes stale). The cursor trails
 * the server clock so a write committed concurrently with this read is seen again.
 */
export async function getAccountsDelta(
  userId: string,
  since: Date | null
): Promise<ProgressDeltaResponse> {
  const cursor = new Date(Date.now() - 2_000).toISOString();
  const [light, progress] = await Promise.all([
    listAccountRowSources(userId),
    listProgressForUser(userId),
  ]);
  const rows = await settleLightLinkedInRows(userId, withGoogleScopeHealth(light));
  const after = (at: Date) => since === null || at > since;
  const changed =
    since === null ||
    progress.some((row) => after(row.updatedAt) || isLiveRun(row)) ||
    light.some(
      (row) =>
        after(row.updatedAt) ||
        row.status === 'SYNCING' ||
        row.emailCredentials.some((credential) => after(credential.updatedAt))
    );
  return {
    cursor,
    changed,
    accountsByProvider: buildAccountsView({ rows, progress, now: new Date() }),
  };
}

/**
 * DELETE /api/integrations/:provider/accounts/:accountId — an alias of the
 * whole-row DELETE /api/integrations/:name for the row's default account.
 */
export async function deleteIntegrationAccount(
  userId: string,
  provider: string,
  wireAccountId: string
): Promise<{ provider: string; accountId: string }> {
  assertProviderSlug(provider);
  const accountId = toStorageAccountId(wireAccountId);
  if (accountId !== '') {
    const row = await findIntegrationAccount(userId, provider, accountId);
    if (row === null) throw new IntegrationAccountNotFoundError(provider, wireAccountId);
    throw new AccountDeleteUnsupportedError(provider, wireAccountId);
  }
  await deleteLegacyIntegration(userId, provider);
  log.info('Integration account deleted', { userId, provider });
  return { provider, accountId: toWireAccountId(accountId) };
}

/** Whole-row DELETE /api/integrations/:name, plus that row's progress. */
export async function deleteLegacyIntegration(userId: string, name: string): Promise<void> {
  await service.deleteIntegration(userId, name);
  await clearAccountProgress(userId, name, '');
}
