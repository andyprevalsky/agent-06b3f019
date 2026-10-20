/**
 * WhatsApp multi-account (plan row I2): one Integration row per linked phone.
 *
 *   Mac connect { accountId: '+1555…', label, claimLegacy? }
 *     └─ connectWhatsAppAccount ─► Integration(whatsapp, accountId)
 *          claimLegacy (the phone of the Mac's legacy single auth dir) adopts the
 *          legacy '' row and re-attributes its history inside the claim
 *   Mac upload { contacts, accountId }
 *     └─ uploadWhatsAppAccountBatch ─► guarded insert (stops once the row is gone);
 *          an unknown/removed account is refused, so an in-flight Mac upload can
 *          never resurrect an account the user deleted
 *   DELETE /api/integrations/whatsapp/accounts/:accountId
 *     └─ deleteWhatsAppAccount: row, then its messages, then the contacts only
 *          WhatsApp created that nothing references any more
 *
 * 10k rule: connect is one advisory-locked upsert (plus the one-time legacy
 * adoption: indexed per-user UPDATEs); each upload batch is one guarded
 * createMany per contact chunk; deletion walks one user's WhatsApp rows in
 * bounded batches. Nothing fans in across users or accounts.
 */

import { createLogger } from '../../providers/logger';
import { MessageAccountRemovedError } from '../../services/integrations/personMessageManager';
import {
  parseWhatsAppData,
  type WhatsAppContactWithMessages,
} from '../../services/integrations/whatsappParser';
import { findIntegrationAccount, upsertIntegrationAccount } from './repo.accounts';
import * as repo from './repo.integration';
import {
  adoptLegacyWhatsAppMessages,
  deleteOrphanedWhatsAppContacts,
  deleteWhatsAppAccountMessages,
  deleteWhatsAppAccountRow,
  WHATSAPP_INTEGRATION_NAME,
} from './repo.whatsappAccounts';
import { IntegrationStatus, IntegrationType } from './types';

const log = createLogger('WhatsAppAccounts');

export interface WhatsAppConnectInput {
  /** Storage account id: the linked phone in E.164. */
  accountId: string;
  label: string | null;
  /** The Mac is migrating its legacy single auth dir to this phone. */
  claimLegacy: boolean;
}

/** Mark one linked phone CONNECTED (creating its row on first connect). */
export async function connectWhatsAppAccount(userId: string, input: WhatsAppConnectInput) {
  log.info('Connecting WhatsApp account', { userId, claimLegacy: input.claimLegacy });
  return upsertIntegrationAccount({
    userId,
    name: WHATSAPP_INTEGRATION_NAME,
    accountId: input.accountId,
    type: IntegrationType.DATA_SOURCE,
    legacy: input.claimLegacy ? 'claim' : 'separate',
    accountEmail: input.label ?? input.accountId,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    adoptLegacyData: (tx, accountId) => adoptLegacyWhatsAppMessages(tx, userId, accountId),
  });
}

/**
 * Accept one batch for a connected account and store it in the background.
 * Resolves null for an unknown (never connected or removed) account.
 */
export async function uploadWhatsAppAccountBatch(
  userId: string,
  accountId: string,
  contacts: WhatsAppContactWithMessages[]
) {
  const integration = await findIntegrationAccount(userId, WHATSAPP_INTEGRATION_NAME, accountId);
  if (integration === null) return null;
  const messages = contacts.reduce((sum, contact) => sum + (contact.messages?.length ?? 0), 0);
  log.info('Received WhatsApp account batch', { userId, contacts: contacts.length, messages });

  const jobId = `whatsapp-upload-${userId}-${Date.now()}`;
  void (async () => {
    try {
      await parseWhatsAppData(userId, contacts, jobId, {
        accountId,
        integrationId: integration.id,
      });
    } catch (error: unknown) {
      if (error instanceof MessageAccountRemovedError) {
        log.info('WhatsApp account removed during upload; batch dropped', { userId, jobId });
        return;
      }
      const reason = error instanceof Error ? error.message : 'Unknown error';
      log.error('Error processing WhatsApp account batch', { userId, jobId, error: reason });
      await repo
        .updateIntegration(integration.id, {
          status: IntegrationStatus.SYNC_FAILED,
          lastFailedSyncAt: new Date(),
          failureReason: reason,
        })
        .catch(() => undefined);
    }
  })();
  return { integration, jobId };
}

/**
 * Account cleanup hook (service.accountRegistry): delete exactly this
 * account's messages and the contacts only WhatsApp created, plus its row.
 * `accountId` is the storage key (`''` = the legacy account, NULL-attributed rows).
 * The row goes first: in-flight inserts check it under a key-share lock and stop.
 */
export async function deleteWhatsAppAccount(ctx: {
  userId: string;
  accountId: string;
}): Promise<boolean> {
  const existed = await deleteWhatsAppAccountRow(ctx.userId, ctx.accountId);
  const { messages, personIds } = await deleteWhatsAppAccountMessages(
    ctx.userId,
    ctx.accountId === '' ? null : ctx.accountId
  );
  const contacts = await deleteOrphanedWhatsAppContacts(ctx.userId, personIds);
  log.info('WhatsApp account deleted', { userId: ctx.userId, existed, messages, contacts });
  return existed || messages > 0;
}
