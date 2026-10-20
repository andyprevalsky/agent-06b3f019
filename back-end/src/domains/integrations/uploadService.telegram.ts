/**
 * Telegram multi-account connect, upload and account cleanup (plan row I8).
 *
 *   Mac session (Telegram user id A)
 *     ├─ POST /telegram/connect {accountId: A, label, claimLegacy?} → Integration(telegram, A)
 *     ├─ POST /telegram/upload  {accountId: A, contacts}           → MessageRecord(sourceAccountId A)
 *     └─ POST /telegram/accounts/A/progress (generic I0 route)     → IntegrationSyncProgress
 *   DELETE /api/integrations/telegram/accounts/A → deleteTelegramAccountData → only A's rows
 *
 * Requests without `accountId` keep the legacy single-account behaviour
 * (uploadService.messaging.ts) so older Mac builds keep working.
 *
 * 10k rule: one Integration row per Telegram account; per upload batch one
 * guarded createMany plus one row update; deletion is bounded batches of one
 * user's own rows. No cross-user fan-in.
 */

import { z } from 'zod';
import { createLogger } from '../../providers/logger';
import { MessageAccountRemovedError } from '../../services/integrations/personMessageManager';
import {
  parseTelegramData,
  type TelegramContactWithMessages,
} from '../../services/integrations/telegramParser';
import { findIntegrationAccount, upsertIntegrationAccount } from './repo.accounts';
import {
  adoptLegacyTelegramMessages,
  databaseNow,
  deleteTelegramAccountRow,
  deleteTelegramMessageBatch,
  markTelegramUploadFailed,
  TELEGRAM_INTEGRATION_NAME,
} from './repo.telegram';
import { IntegrationStatus, IntegrationType } from './types';

const log = createLogger('TelegramAccounts');

const DELETE_BATCH_SIZE = 5_000;

/** A Telegram account id is the account's numeric Telegram user id. */
export const telegramAccountIdSchema = z
  .string()
  .regex(/^\d{1,20}$/, 'accountId must be a numeric Telegram user id');

/** Body of POST /api/integrations/telegram/connect (empty = legacy single account). */
export const telegramConnectSchema = z
  .object({
    accountId: telegramAccountIdSchema.optional(),
    /** Shown on the account chip (@username or display name). */
    label: z.string().trim().min(1).max(200).nullable().optional(),
    /**
     * The Mac is migrating its legacy single-session login to this account:
     * adopt the legacy row and its unattributed messages.
     */
    claimLegacy: z.boolean().optional(),
  })
  .strict();

export type TelegramConnectInput = z.infer<typeof telegramConnectSchema>;

export async function connectTelegramAccount(
  userId: string,
  input: TelegramConnectInput & { accountId: string }
) {
  log.info('Connecting Telegram account', { userId, claimLegacy: input.claimLegacy === true });
  return upsertIntegrationAccount({
    userId,
    name: TELEGRAM_INTEGRATION_NAME,
    accountId: input.accountId,
    type: IntegrationType.DATA_SOURCE,
    legacy: input.claimLegacy === true ? 'claim' : 'separate',
    ...(input.label !== undefined && { accountEmail: input.label }),
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    adoptLegacyData: (tx, accountId) => adoptLegacyTelegramMessages(tx, userId, accountId),
  });
}

/**
 * Accept one batch for a connected account and store it in the background.
 * Resolves null for an unknown (never connected or removed) account, so a Mac
 * that is still uploading can never resurrect an account the user deleted.
 */
export async function uploadTelegramAccountBatch(
  userId: string,
  accountId: string,
  contacts: TelegramContactWithMessages[],
  accessedAt?: string
) {
  const integration = await findIntegrationAccount(userId, TELEGRAM_INTEGRATION_NAME, accountId);
  if (integration === null) return null;
  const messages = contacts.reduce((sum, contact) => sum + (contact.messages?.length ?? 0), 0);
  log.info('Received Telegram account batch', { userId, contacts: contacts.length, messages });

  const jobId = `telegram-upload-${userId}-${accountId}-${Date.now()}`;
  void (async () => {
    try {
      await parseTelegramData(userId, contacts, jobId, {
        accountId,
        integrationId: integration.id,
        ...(accessedAt !== undefined && { accessedAt }),
      });
    } catch (error: unknown) {
      if (error instanceof MessageAccountRemovedError) {
        log.info('Telegram account removed during upload; batch dropped', { userId, jobId });
        return;
      }
      const reason = error instanceof Error ? error.message : 'Unknown error';
      log.error('Error processing Telegram account batch', { userId, jobId, error: reason });
      await markTelegramUploadFailed(integration.id, reason).catch(() => undefined);
    }
  })();
  return { integration, jobId };
}

/**
 * Account cleanup hook: remove ONE Telegram account's row and messages
 * (`accountId = ''` = the legacy account and its unattributed messages).
 * People rows are shared across channels and are kept, like the Gmail purge.
 * Resolves false when the account had neither a row nor messages.
 */
export async function deleteTelegramAccountData(ctx: {
  userId: string;
  accountId: string;
}): Promise<boolean> {
  if (ctx.accountId !== '' && !telegramAccountIdSchema.safeParse(ctx.accountId).success) {
    return false;
  }
  const deletedAt = await deleteTelegramAccountRow(ctx.userId, ctx.accountId);
  const notAfter = deletedAt ?? (await databaseNow());
  const sourceAccountId = ctx.accountId === '' ? null : ctx.accountId;
  let removed = 0;
  for (;;) {
    const batch = await deleteTelegramMessageBatch(
      ctx.userId,
      sourceAccountId,
      notAfter,
      DELETE_BATCH_SIZE
    );
    removed += batch;
    if (batch < DELETE_BATCH_SIZE) break;
  }
  log.info('Telegram account data deleted', {
    userId: ctx.userId,
    rowExisted: deletedAt !== null,
    messagesRemoved: removed,
  });
  return deletedAt !== null || removed > 0;
}
