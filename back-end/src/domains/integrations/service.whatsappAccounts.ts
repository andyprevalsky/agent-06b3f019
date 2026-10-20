/**
 * WhatsApp multi-account (plan row I2): one Integration row per linked phone.
 *
 *   Mac connect / upload { accountId: '+1555…' }
 *     └─ upsertWhatsAppAccount ─► Integration(whatsapp, accountId)
 *          the first phone claims the legacy '' row (its pre-multi-account
 *          history came from that phone) and is marked `legacyHistory`
 *   DELETE /api/integrations/whatsapp/accounts/:accountId
 *     └─ deleteWhatsAppAccount
 *          1. messages attributed to the phone (+ NULL rows if it holds legacy history)
 *          2. contacts a WhatsApp sync created that nothing references any more
 *          3. the account's Integration row
 *
 * 10k rule: connect/upload add one advisory-locked upsert per batch (plus one
 * update on the one-time legacy claim); deletion walks one user's WhatsApp rows
 * in bounded batches. Nothing fans in across users or accounts.
 */

import { createLogger } from '../../providers/logger';
import { findIntegrationAccount, upsertIntegrationAccount } from './repo.accounts';
import * as repo from './repo.integration';
import {
  deleteOrphanedWhatsAppContacts,
  deleteWhatsAppAccountMessages,
} from './repo.whatsappAccounts';
import { type IntegrationStatus, IntegrationType, type Prisma } from './types';

const log = createLogger('WhatsAppAccounts');

export const WHATSAPP_INTEGRATION = 'whatsapp';
/** Config flag: this account adopted the legacy row, so NULL-attributed history is its own. */
const LEGACY_HISTORY = 'legacyHistory';

function configObject(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export interface WhatsAppAccountWrite {
  status: IntegrationStatus;
  isActive?: boolean;
  lastSyncAt?: Date;
  label?: string | null;
  /** Merged over the account's stored config. */
  config: Prisma.JsonObject;
  /** Kept only where the stored config has no value yet (e.g. `connectedAt`). */
  defaults?: Prisma.JsonObject;
}

/** Create or update one linked phone's Integration row. */
export async function upsertWhatsAppAccount(
  userId: string,
  accountId: string,
  write: WhatsAppAccountWrite
) {
  const [exact, legacy] = await Promise.all([
    findIntegrationAccount(userId, WHATSAPP_INTEGRATION, accountId),
    findIntegrationAccount(userId, WHATSAPP_INTEGRATION, ''),
  ]);
  const row = await upsertIntegrationAccount({
    userId,
    name: WHATSAPP_INTEGRATION,
    accountId,
    type: IntegrationType.DATA_SOURCE,
    legacy: 'claim',
    status: write.status,
    ...(write.isActive !== undefined && { isActive: write.isActive }),
    ...(write.lastSyncAt !== undefined && { lastSyncAt: write.lastSyncAt }),
    ...(write.label !== undefined && { accountEmail: write.label }),
    config: { ...write.defaults, ...configObject(exact?.config), ...write.config },
  });
  if (exact !== null || legacy === null || row.id !== legacy.id) return row;
  // This phone adopted the pre-multi-account row (the claim is exclusive under
  // the account lock): keep that row's config and mark its history as ours.
  log.info('WhatsApp account claimed the legacy row', { userId, integrationId: row.id });
  return repo.updateIntegration(row.id, {
    config: { ...configObject(legacy.config), ...configObject(row.config), [LEGACY_HISTORY]: true },
  });
}

/**
 * Account cleanup hook (service.accountRegistry): delete exactly this
 * account's messages and the contacts only WhatsApp created, then its row.
 * `accountId` is the storage key (`''` = the legacy default account).
 */
export async function deleteWhatsAppAccount(ctx: {
  userId: string;
  accountId: string;
}): Promise<boolean> {
  const row = await findIntegrationAccount(ctx.userId, WHATSAPP_INTEGRATION, ctx.accountId);
  const legacyAccount = ctx.accountId === '';
  if (legacyAccount && row === null) return false;
  const includeLegacy = legacyAccount || configObject(row?.config)[LEGACY_HISTORY] === true;
  const { messages, personIds } = await deleteWhatsAppAccountMessages(
    ctx.userId,
    legacyAccount ? null : ctx.accountId,
    includeLegacy
  );
  const contacts = await deleteOrphanedWhatsAppContacts(ctx.userId, personIds);
  if (row !== null) await repo.deleteIntegration(row.id);
  log.info('WhatsApp account deleted', {
    userId: ctx.userId,
    existed: row !== null,
    includeLegacy,
    messages,
    contacts,
  });
  return row !== null || messages > 0;
}
