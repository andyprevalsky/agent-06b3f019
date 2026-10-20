/**
 * iMessage device accounts (plan row I1): one account per Mac.
 *
 *   POST /api/integrations/imessage/upload { contacts, account: { id, label, mode } }
 *     connect ─► own row? ─no─► legacy row? ─yes─► adopt legacy messages, claim the row
 *        │                         └─no──► create the device row
 *     sync ───► own row? ─no─► IMessageAccountRemovedError (410, nothing stored)
 *     store the batch (keys `<id>:<ROWID>`, sourceAccountId = id) BEFORE answering;
 *     inserts hold KEY SHARE on the account row, so a racing delete stops them (410)
 *
 *   DELETE /api/integrations/imessage/accounts/:id ─► deleteIMessageAccount
 *     row first (waits for in-flight inserts), then exactly its messages.
 *
 * 10k rule: per batch one row lookup, one upsert and the batch's own inserts;
 * deletes and the one-time legacy adoption touch only that account's rows.
 */

import { z } from 'zod';
import { createLogger } from '../../providers/logger';
import {
  parseIMessageData,
  type ContactWithMessages,
} from '../../services/integrations/iMessageParser';
import { MessageAccountRemovedError } from '../../services/integrations/personMessageManager';
import { findIntegrationAccount, upsertIntegrationAccount } from './repo.accounts';
import { adoptLegacyIMessages, deleteIMessagesForAccount } from './repo.imessageAccounts';
import * as integrationRepo from './repo.integration';
import { DEFAULT_ACCOUNT_ID } from './syncAccountsContract';
import { IntegrationStatus, IntegrationType } from './types';

const log = createLogger('IMessageAccounts');
const PROVIDER = 'imessage';

/** `account` of a device-scoped iMessage upload. */
export const imessageDeviceAccountSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .refine((id) => id !== DEFAULT_ACCOUNT_ID, 'account id `default` is reserved'),
    label: z.string().trim().max(120).nullable().optional(),
    mode: z.enum(['connect', 'sync']),
  })
  .strict();

export type IMessageDeviceAccount = z.infer<typeof imessageDeviceAccountSchema>;

export class IMessageAccountRemovedError extends Error {
  constructor(readonly accountId: string) {
    super(`iMessage account ${accountId} was removed`);
  }
}

/** Create, claim (legacy row + its messages) or refresh this Mac's account row. */
async function connectDevice(userId: string, account: IMessageDeviceAccount): Promise<void> {
  const own = await findIntegrationAccount(userId, PROVIDER, account.id);
  if (own === null && (await findIntegrationAccount(userId, PROVIDER, '')) !== null) {
    // Adopt BEFORE claiming: an interrupted adoption is simply redone by the
    // next connect, which still sees the legacy row.
    const adopted = await adoptLegacyIMessages(userId, account.id);
    log.info('Adopted legacy iMessage rows', { userId, accountId: account.id, adopted });
  }
  await upsertIntegrationAccount({
    userId,
    name: PROVIDER,
    accountId: account.id,
    type: IntegrationType.DATA_SOURCE,
    legacy: 'claim',
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    ...(account.label !== undefined && { accountEmail: account.label }),
  });
}

export interface DeviceUploadResult {
  accountId: string;
  jobId: string;
  stored: { contacts: number; messages: number };
}

/** Store one device batch synchronously (the Mac advances its cursor on 200). */
export async function processIMessageDeviceUpload(
  userId: string,
  contacts: ContactWithMessages[],
  account: IMessageDeviceAccount
): Promise<DeviceUploadResult> {
  if (account.mode === 'connect') {
    await connectDevice(userId, account);
  } else if ((await findIntegrationAccount(userId, PROVIDER, account.id)) === null) {
    throw new IMessageAccountRemovedError(account.id);
  }
  const jobId = `imessage-upload-${userId}-${account.id}-${Date.now()}`;
  let stored: { contacts: number; messages: number };
  try {
    stored = await parseIMessageData(userId, contacts, jobId, account.id);
  } catch (error: unknown) {
    if (error instanceof MessageAccountRemovedError) {
      throw new IMessageAccountRemovedError(account.id);
    }
    const row = await findIntegrationAccount(userId, PROVIDER, account.id);
    if (row === null) throw new IMessageAccountRemovedError(account.id);
    await integrationRepo.updateIntegration(row.id, {
      status: IntegrationStatus.SYNC_FAILED,
      lastSyncAt: new Date(),
      failureReason: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
  const row = await findIntegrationAccount(userId, PROVIDER, account.id);
  // Deleted after the last insert: the delete removed this batch's rows too.
  if (row === null) throw new IMessageAccountRemovedError(account.id);
  const now = new Date();
  await integrationRepo.updateIntegration(row.id, {
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: now,
    lastSuccessfulSyncAt: now,
    failureReason: null,
  });
  return { accountId: account.id, jobId, stored };
}

/**
 * Account cleanup hook: remove one Mac's account row and exactly its messages
 * (`''` = the legacy account and its device-less messages).
 */
export async function deleteIMessageAccount(ctx: {
  userId: string;
  accountId: string;
}): Promise<boolean> {
  const row = await findIntegrationAccount(ctx.userId, PROVIDER, ctx.accountId);
  if (row !== null) await integrationRepo.deleteIntegration(row.id);
  const removed = await deleteIMessagesForAccount(
    ctx.userId,
    ctx.accountId === '' ? null : ctx.accountId
  );
  log.info('iMessage account deleted', {
    userId: ctx.userId,
    accountId: ctx.accountId,
    rowExisted: row !== null,
    messagesRemoved: removed,
  });
  return row !== null || removed > 0;
}
