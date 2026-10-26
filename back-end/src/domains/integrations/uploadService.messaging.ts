/**
 * Integrations upload service — messaging platform uploads (iMessage, WhatsApp, Telegram).
 * Split from uploadService.ts for max-lines compliance.
 */

import { IntegrationType, IntegrationStatus, type Prisma } from './types';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import type { ContactWithMessages } from '../../services/integrations/iMessageParser';
import type { WhatsAppContactWithMessages } from '../../services/integrations/whatsappParser';
import type { TelegramContactWithMessages } from '../../services/integrations/telegramParser';
import { enqueueMessagingUpload, type MessagingPlatform } from './uploadService.messagingJobs';

export { runMessagingUploadJobs } from './uploadService.messagingJobs';

// Re-export types needed by routes
export type { ContactWithMessages } from '../../services/integrations/iMessageParser';
export type { WhatsAppContactWithMessages } from '../../services/integrations/whatsappParser';
export type { TelegramContactWithMessages } from '../../services/integrations/telegramParser';

const log = createLogger('Integrations');

/**
 * Accept a messaging history upload: record it on the integration and store it
 * as durable parts (see uploadService.messagingJobs). Parsing never runs inside
 * the request, so the acknowledgement survives a deploy, crash or OOM.
 *
 * `syncComplete: false` marks a non-final request of a chunked client sync: it
 * keeps the previous incremental-read cursor until the final request arrives.
 */
async function acceptMessagingUpload(
  platform: MessagingPlatform,
  userId: string,
  contacts: Array<{ messages?: unknown[] }>,
  accessedAt: string | undefined,
  syncComplete: boolean
) {
  const totalMessages = contacts.reduce((sum, contact) => sum + (contact.messages?.length ?? 0), 0);
  log.info(`Received ${platform} payload`, {
    userId,
    contacts: contacts.length,
    messages: totalMessages,
    syncComplete,
  });

  const existing = await repo.findIntegrationByUserAndName(userId, platform);
  const existingConfig = (existing?.config as Prisma.JsonObject | null) ?? {};
  const cursor = syncComplete ? (accessedAt ?? new Date().toISOString()) : undefined;
  const integration = await repo.upsertIntegrationForUpload({
    userId,
    name: platform,
    config: {
      ...existingConfig,
      contacts: contacts.length,
      messages: totalMessages,
      uploadedAt: new Date().toISOString(),
      ...(cursor !== undefined ? { lastFrontendAccessAt: cursor } : {}),
    },
  });

  const jobId = await enqueueMessagingUpload({
    userId,
    integrationId: integration.id,
    platform,
    contacts,
    totalMessages,
    accessedAt: cursor ?? null,
    syncComplete,
  });
  return { integration, jobId };
}

/** Process an iMessage upload (durable background processing). */
export async function processIMessageUpload(
  userId: string,
  contacts: ContactWithMessages[],
  accessedAt?: string,
  syncComplete = true
) {
  return acceptMessagingUpload('imessage', userId, contacts, accessedAt, syncComplete);
}

/** Process a WhatsApp upload (durable background processing). */
export async function processWhatsAppUpload(
  userId: string,
  contacts: WhatsAppContactWithMessages[],
  accessedAt?: string,
  syncComplete = true
) {
  return acceptMessagingUpload('whatsapp', userId, contacts, accessedAt, syncComplete);
}

/**
 * Process WhatsApp connect.
 *
 * The mac-app calls this the moment the Baileys socket pairs, before any
 * messages exist. Without it the integration row is only ever created by an
 * upload, while the mac-app's uploader refuses to upload until the integration
 * reads as CONNECTED — a deadlock that silently drops every synced message.
 */
export async function processWhatsAppConnect(userId: string) {
  log.info('Creating WhatsApp integration', { userId });

  // Re-pairing is routine (a 515 restart, a new device). Merge rather than
  // overwrite so reconnecting can't silently drop stored integration settings.
  const existing = await repo.findIntegrationByUserAndName(userId, 'whatsapp');
  const existingConfig = (existing?.config as Prisma.JsonObject | null) ?? {};
  const now = new Date();

  return repo.upsertIntegration({
    userId,
    name: 'whatsapp',
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: now,
    config: {
      connectedAt: now.toISOString(),
      ...existingConfig,
      lastConnectedAt: now.toISOString(),
    },
  });
}

/**
 * Process Telegram connect.
 */
export async function processTelegramConnect(userId: string) {
  log.info('Creating Telegram integration', { userId });

  return repo.upsertIntegration({
    userId,
    name: 'telegram',
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    config: {
      connectedAt: new Date().toISOString(),
    },
  });
}

/** Process a Telegram upload (durable background processing). */
export async function processTelegramUpload(
  userId: string,
  contacts: TelegramContactWithMessages[],
  accessedAt?: string,
  syncComplete = true
) {
  return acceptMessagingUpload('telegram', userId, contacts, accessedAt, syncComplete);
}
