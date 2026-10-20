/**
 * Multi-account read/delete surface for integrations.
 *
 *   GET    /api/integrations                         getIntegrationsWithAccounts
 *   GET    /api/integrations/progress?since=         getAccountsDelta
 *   DELETE /api/integrations/:provider/accounts/:id  deleteIntegrationAccount
 *   DELETE /api/integrations/:name (legacy)          deleteLegacyIntegration
 *
 * 10k rule: one list call adds two indexed per-user reads (progress rows, Plaid
 * items) in parallel with the existing query; the delta poll is five indexed
 * existence probes when nothing changed. Nothing fans in across users.
 */

import { createLogger } from '../../providers/logger';
import { withGoogleScopeHealth } from './integrationScopeHealth';
import {
  findIntegrationAccount,
  listAccountRowSources,
  listActivePlaidItemSources,
  listCookieProfileSources,
} from './repo.accounts';
import { accountSourcesChangedSince, listProgressForUser } from './repo.progress';
import * as service from './service';
import {
  isContainerProvider,
  resolveAccountAdapter,
  type IntegrationLane,
} from './service.accountRegistry';
import { buildAccountsView, type AccountViewRow } from './service.accountsView';
import { LINKEDIN_INTEGRATION_NAME, settleLinkedInSync } from './service.linkedinSync';
import { clearAccountProgress, clearProviderProgress } from './service.progress';
import {
  assertProviderSlug,
  InvalidAccountKeyError,
  toStorageAccountId,
  toWireAccountId,
  type IntegrationAccount,
  type ProgressDeltaResponse,
} from './syncAccountsContract';

const log = createLogger('IntegrationAccounts');

export class IntegrationAccountNotFoundError extends Error {
  constructor(provider: string, accountId: string) {
    super(`Integration account not found: ${provider}/${accountId}`);
  }
}

export class AccountCleanupNotImplementedError extends Error {
  constructor(
    readonly provider: string,
    readonly owner: IntegrationLane,
    readonly reason: string
  ) {
    super(`Account-scoped deletion is not implemented for ${provider} (${reason})`);
  }
}

export { InvalidAccountKeyError };

/**
 * The legacy list plus, on every row, `accounts`: ALL accounts of that row's
 * provider (rows sharing a provider carry the same list), and the same lists in
 * `accountsByProvider`, which also covers providers that so far only reported
 * progress.
 */
export async function getIntegrationsWithAccounts(userId: string) {
  const [base, progress, plaidItems, cookieProfiles] = await Promise.all([
    service.getIntegrations(userId),
    listProgressForUser(userId),
    listActivePlaidItemSources(userId),
    listCookieProfileSources(userId),
  ]);
  const rows: AccountViewRow[] = base.integrations;
  const accountsByProvider = buildAccountsView({ rows, plaidItems, cookieProfiles, progress });
  const integrations = base.integrations.map((integration) => ({
    ...integration,
    accounts: accountsByProvider[integration.name] ?? ([] as IntegrationAccount[]),
  }));
  return { ...base, integrations, accountsByProvider };
}

/**
 * Cheap poll for chips: `changed: false` unless a progress row, Integration row,
 * email credential or Plaid item of this user changed after `since`. The cursor
 * trails the server clock by a small margin so a write committed concurrently
 * with this read is reported again rather than missed.
 */
export async function getAccountsDelta(
  userId: string,
  since: Date | null
): Promise<ProgressDeltaResponse> {
  const cursor = new Date(Date.now() - 2_000).toISOString();
  const settled = [LINKEDIN_INTEGRATION_NAME];
  if (since !== null && !(await accountSourcesChangedSince(userId, since, settled))) {
    return { cursor, changed: false };
  }
  // Same Google scope-health and LinkedIn settle derivations as the full list,
  // so both views agree.
  const [rows, plaidItems, cookieProfiles, progress] = await Promise.all([
    listAccountRowSources(userId)
      .then(withGoogleScopeHealth)
      .then((light) => settleLightLinkedInRow(userId, light)),
    listActivePlaidItemSources(userId),
    listCookieProfileSources(userId),
    listProgressForUser(userId),
  ]);
  return {
    cursor,
    changed: true,
    accountsByProvider: buildAccountsView({ rows, plaidItems, cookieProfiles, progress }),
  };
}

/**
 * A SYNCING LinkedIn row whose export agent ended reads SYNC_FAILED in the full
 * list (settleLinkedInSync); apply the same read-time settle to the light rows.
 * Only that row's config is read, and only while it is SYNCING.
 */
async function settleLightLinkedInRow<T extends AccountViewRow>(
  userId: string,
  rows: T[]
): Promise<T[]> {
  const syncing = rows.find(
    (row) => row.name === LINKEDIN_INTEGRATION_NAME && row.status === 'SYNCING'
  );
  if (syncing === undefined) return rows;
  const stored = await findIntegrationAccount(userId, syncing.name, syncing.accountId);
  if (stored === null) return rows;
  const [settled] = await settleLinkedInSync(userId, [stored]);
  return rows.map((row) =>
    row === syncing ? { ...row, status: settled.status, failureReason: settled.failureReason } : row
  );
}

export async function deleteIntegrationAccount(
  userId: string,
  provider: string,
  wireAccountId: string
): Promise<{ provider: string; accountId: string }> {
  assertProviderSlug(provider);
  const accountId = toStorageAccountId(wireAccountId);
  const adapter = resolveAccountAdapter(provider);
  if (adapter.cleanup.status === 'todo') {
    throw new AccountCleanupNotImplementedError(
      provider,
      adapter.cleanup.owner,
      adapter.cleanup.reason
    );
  }
  const existed = await adapter.cleanup.deleteAccountData({ userId, provider, accountId });
  const progressRemoved = await clearAccountProgress(userId, provider, accountId);
  if (!existed && progressRemoved === 0) {
    throw new IntegrationAccountNotFoundError(provider, toWireAccountId(accountId));
  }
  log.info('Integration account deleted', { userId, provider, existed, progressRemoved });
  return { provider, accountId: toWireAccountId(accountId) };
}

/**
 * Legacy whole-row DELETE /api/integrations/:name. The `''` row of a container
 * provider (gmail, plaid) holds every account, so all its progress goes too.
 */
export async function deleteLegacyIntegration(userId: string, name: string): Promise<void> {
  await service.deleteIntegration(userId, name);
  if (isContainerProvider(name)) await clearProviderProgress(userId, name);
  else await clearAccountProgress(userId, name, '');
}
