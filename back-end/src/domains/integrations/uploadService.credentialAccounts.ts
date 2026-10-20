/**
 * Per-account progress and Integration rows for one password/passkey upload
 * (plan row I7).
 *
 *   upload batch ─► group by account ─► progress `syncing` (done 0 / total n)
 *        ─► store rows + upsert one Integration row per account
 *        ─► progress `synced` (done n / total n)   | on failure: `failed`, rethrow
 *
 * `total` is the number of items this upload carries for the account, so the
 * chip shows real counts rather than a guess. One run id per upload; a later
 * upload starts a new run. 10k rule: two O(1) progress writes and one row
 * upsert per account per upload, each under that account's own lock.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../providers/logger';
import { upsertIntegrationAccount } from './repo.accounts';
import { countPasswordsForProfile } from './repo.credentialAccounts';
import * as repo from './repo';
import { passwordSourcesForProvider } from './service.credentialAccounts';
import { ProgressAccountLimitError, reportIntegrationProgress } from './service.progress';
import { toWireAccountId } from './syncAccountsContract';
import { IntegrationStatus, IntegrationType, type Prisma } from './types';

const log = createLogger('Integrations');

export interface CredentialUploadAccount {
  provider: string;
  /** Storage account id: `<source>:<profile>` for passwords, `''` for none. */
  accountId: string;
  count: number;
}

/** Wire summary of one uploaded account, returned to the uploader. */
export interface UploadedCredentialAccount {
  provider: string;
  accountId: string;
  count: number;
}

type ProgressInput = Parameters<typeof reportIntegrationProgress>[0]['input'];

async function writeProgress(
  userId: string,
  account: CredentialUploadAccount,
  input: ProgressInput
): Promise<void> {
  try {
    await reportIntegrationProgress({
      userId,
      provider: account.provider,
      accountId: account.accountId,
      input,
    });
  } catch (error: unknown) {
    // The per-user progress cap bounds chips, not credential storage.
    if (!(error instanceof ProgressAccountLimitError)) throw error;
    log.warn('Upload progress not recorded: account cap reached', {
      userId,
      provider: account.provider,
    });
  }
}

/** Run `store` while each account reports syncing → synced (or failed). */
export async function trackCredentialUpload(
  userId: string,
  accounts: CredentialUploadAccount[],
  unit: 'passwords' | 'passkeys',
  store: () => Promise<void>
): Promise<UploadedCredentialAccount[]> {
  const runId = `upload-${randomUUID()}`;
  for (const account of accounts) {
    await writeProgress(userId, account, {
      runId,
      state: 'syncing',
      done: 0,
      total: account.count,
      unit,
    });
  }
  try {
    await store();
  } catch (error: unknown) {
    for (const account of accounts) {
      await writeProgress(userId, account, {
        runId,
        state: 'failed',
        error: `${unit} upload failed`,
      }).catch((progressError: unknown) => {
        log.warn('Failed to record upload failure progress', {
          userId,
          provider: account.provider,
          error: progressError instanceof Error ? progressError.message : String(progressError),
        });
      });
    }
    throw error;
  }
  for (const account of accounts) {
    await writeProgress(userId, account, {
      runId,
      state: 'synced',
      done: account.count,
      total: account.count,
      unit,
    });
  }
  return accounts.map((account) => ({
    provider: account.provider,
    accountId: toWireAccountId(account.accountId),
    count: account.count,
  }));
}

/**
 * One Integration row per account. A profile-less account is the legacy `''`
 * row. A profile account claims the legacy row only when no profile-less
 * passwords of that source remain, i.e. when that row described the profiles
 * of a pre-profile upload rather than data of its own.
 */
export async function upsertCredentialAccountRow(
  userId: string,
  account: CredentialUploadAccount,
  config: Prisma.InputJsonValue
): Promise<void> {
  const now = new Date();
  const fields = {
    userId,
    name: account.provider,
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: now,
    lastSuccessfulSyncAt: now,
    config,
  };
  if (account.accountId === '') {
    await repo.upsertIntegration(fields);
    return;
  }
  const sources = passwordSourcesForProvider(account.provider);
  const legacyOwnsRows = (await countPasswordsForProfile(userId, sources, '')) > 0;
  await upsertIntegrationAccount({
    ...fields,
    accountId: account.accountId,
    legacy: legacyOwnsRows ? 'separate' : 'claim',
  });
}
