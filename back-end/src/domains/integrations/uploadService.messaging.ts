/**
 * Integrations upload service — messaging platform uploads (iMessage, WhatsApp, Telegram).
 * Split from uploadService.ts for max-lines compliance.
 */

import { IntegrationType, IntegrationStatus, type Prisma } from './types';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import {
  type ContactWithMessages,
  parseIMessageData,
} from '../../services/integrations/iMessageParser';
import {
  type WhatsAppContactWithMessages,
  parseWhatsAppData,
} from '../../services/integrations/whatsappParser';
import {
  type TelegramContactWithMessages,
  parseTelegramData,
} from '../../services/integrations/telegramParser';

// Re-export types needed by routes
export type { ContactWithMessages } from '../../services/integrations/iMessageParser';
export type { WhatsAppContactWithMessages } from '../../services/integrations/whatsappParser';
export type { TelegramContactWithMessages } from '../../services/integrations/telegramParser';

const log = createLogger('Integrations');

/** Update integration after successful messaging import. */
async function updateMessagingIntegration(
  integrationId: string,
  existingConfig: Record<string, unknown>,
  contacts: { length: number },
  totalMessages: number,
  jobId: string,
  accessedAt: string | undefined
) {
  await repo.updateIntegration(integrationId, {
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: {
      ...existingConfig,
      contacts: contacts.length,
      messages: totalMessages,
      lastJobId: jobId,
      lastUploadedAt: new Date().toISOString(),
      lastFrontendAccessAt:
        accessedAt ??
        (typeof existingConfig.lastFrontendAccessAt === 'string'
          ? existingConfig.lastFrontendAccessAt
          : new Date().toISOString()),
    },
  });
}

/** Handle failed messaging import. */
async function handleMessagingFailure(integrationId: string, error: unknown, platform: string) {
  log.error(`Error processing ${platform} payload`, {
    error: error instanceof Error ? error.message : String(error),
  });
  await repo.updateIntegrationStatus(integrationId, IntegrationStatus.SYNC_FAILED, {
    lastSyncAt: new Date(),
    lastFailedSyncAt: new Date(),
    failureReason: error instanceof Error ? error.message : 'Unknown error',
  });
}

/**
 * Process iMessage upload (async background processing).
 */
export async function processIMessageUpload(
  userId: string,
  contacts: ContactWithMessages[],
  accessedAt?: string
) {
  const totalMessages = contacts.reduce((sum, contact) => sum + (contact.messages?.length ?? 0), 0);

  log.info('Received iMessage payload', {
    userId,
    contacts: contacts.length,
    messages: totalMessages,
  });

  const integration = await repo.upsertIntegrationForUpload({
    userId,
    name: 'imessage',
    config: {
      contacts: contacts.length,
      messages: totalMessages,
      uploadedAt: new Date().toISOString(),
      lastFrontendAccessAt: accessedAt ?? new Date().toISOString(),
    },
  });

  const jobId = `imessage-upload-${userId}-${Date.now()}`;

  // Background processing
  void (async () => {
    try {
      await parseIMessageData(userId, contacts, jobId);
      const existingConfig = (integration.config as Record<string, unknown> | null) ?? {};
      await updateMessagingIntegration(
        integration.id,
        existingConfig,
        contacts,
        totalMessages,
        jobId,
        accessedAt
      );
    } catch (error: unknown) {
      await handleMessagingFailure(integration.id, error, 'iMessage');
    }
  })();

  return { integration, jobId };
}

/**
 * Process WhatsApp upload (async background processing).
 */
export async function processWhatsAppUpload(
  userId: string,
  contacts: WhatsAppContactWithMessages[],
  accessedAt?: string
) {
  const totalMessages = contacts.reduce((sum, contact) => sum + (contact.messages?.length ?? 0), 0);

  log.info('Received WhatsApp payload', {
    userId,
    contacts: contacts.length,
    messages: totalMessages,
  });

  const integration = await repo.upsertIntegrationForUpload({
    userId,
    name: 'whatsapp',
    config: {
      contacts: contacts.length,
      messages: totalMessages,
      uploadedAt: new Date().toISOString(),
      lastFrontendAccessAt: accessedAt ?? new Date().toISOString(),
    },
  });

  const jobId = `whatsapp-upload-${userId}-${Date.now()}`;

  void (async () => {
    try {
      await parseWhatsAppData(userId, contacts, jobId);
      const existingConfig = (integration.config as Record<string, unknown> | null) ?? {};
      await updateMessagingIntegration(
        integration.id,
        existingConfig,
        contacts,
        totalMessages,
        jobId,
        accessedAt
      );
    } catch (error: unknown) {
      await handleMessagingFailure(integration.id, error, 'WhatsApp');
    }
  })();

  return { integration, jobId };
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

/**
 * Process Telegram upload (async background processing).
 */
export async function processTelegramUpload(
  userId: string,
  contacts: TelegramContactWithMessages[],
  accessedAt?: string
) {
  const totalMessages = contacts.reduce((sum, contact) => sum + (contact.messages?.length ?? 0), 0);

  log.info('Received Telegram payload', {
    userId,
    contacts: contacts.length,
    messages: totalMessages,
  });

  const integration = await repo.upsertIntegrationForUpload({
    userId,
    name: 'telegram',
    config: {
      contacts: contacts.length,
      messages: totalMessages,
      uploadedAt: new Date().toISOString(),
      lastFrontendAccessAt: accessedAt ?? new Date().toISOString(),
    },
  });

  const jobId = `telegram-upload-${userId}-${Date.now()}`;

  void (async () => {
    try {
      await parseTelegramData(userId, contacts, jobId);
      const existingConfig = (integration.config as Record<string, unknown> | null) ?? {};
      await updateMessagingIntegration(
        integration.id,
        existingConfig,
        contacts,
        totalMessages,
        jobId,
        accessedAt
      );
    } catch (error: unknown) {
      await handleMessagingFailure(integration.id, error, 'Telegram');
    }
  })();

  return { integration, jobId };
}
