import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { IntegrationStatus, EmailProvider, MessageChannel } from '@prisma/client';
import {
  fetchGmailEmails,
  fetchGmailHistory,
  fetchMessagesByIds,
  getGmailProfile,
  ParsedEmail,
} from './gmailParser';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';
import {
  classifyEmailAuthFailure,
  markCredentialFailure,
  markCredentialHealthy,
  type EmailAuthFailure,
} from './emailCredentialHealth';
import { missingGoogleScopes } from '../../domains/integrations/googleScopes';
import { googleClientId, googleClientSecret } from '../../domains/integrations/config';
import { reportProgressBestEffort } from '../../domains/integrations/service.progress';
import type { ProgressWriteInput } from '../../domains/integrations/syncAccountsContract';
import { encryptGoogleToken, readGoogleToken } from '../../providers/googleCredentials';

const log = createLogger('GmailSync');

// Sync interval: 1 hour
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

// Google OAuth token endpoint
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface IntegrationConfig {
  provider?: string;
  historyId?: string;
  historyIds?: Record<string, string>;
  userEmail?: string;
  contacts?: number;
  messages?: number;
  [key: string]: unknown;
}

/**
 * Refresh an expired Google access token using the refresh token
 */
async function refreshGoogleAccessToken(
  refreshToken: string
): Promise<
  { ok: true; accessToken: string; expiresAt: Date } | { ok: false; failure: EmailAuthFailure }
> {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();

  if (!clientId) {
    log.error('Missing GOOGLE_CLIENT_ID');
    // Our misconfiguration, not the user's. Never ask them to reconnect for this.
    return {
      ok: false,
      failure: { state: 'sync_failed', reason: 'Email sync is misconfigured on our side.' },
    };
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      ...(clientSecret && { client_secret: clientSecret }),
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Token refresh failed', {
        status: response.status,
      });
      return {
        ok: false,
        failure: classifyEmailAuthFailure({ status: response.status, body: errorText }),
      };
    }

    const json = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    return {
      ok: true,
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  } catch {
    log.error('Error refreshing token');
    // Network/DNS failure: transient by construction.
    return {
      ok: false,
      failure: { state: 'sync_failed', reason: 'Could not reach Google. Will retry.' },
    };
  }
}

/**
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(credential: {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes?: string[];
}): Promise<string | null> {
  if (credential.scopes !== undefined && missingGoogleScopes(credential.scopes).length > 0) {
    await markCredentialFailure(credential.id, {
      state: 'needs_reconnect',
      reason: 'Reconnect Google to grant the current permissions.',
    });
    return null;
  }
  // Check if current token is still valid (with 5 min buffer)
  if (
    credential.accessToken &&
    credential.expiresAt &&
    credential.expiresAt > new Date(Date.now() + 5 * 60 * 1000)
  ) {
    return readGoogleToken(credential.accessToken);
  }

  // Need to refresh
  if (!credential.refreshToken) {
    log.error('No refresh token available');
    await markCredentialFailure(credential.id, {
      state: 'needs_reconnect',
      reason: 'This account has no saved refresh token. Reconnect it to restore access.',
    });
    return null;
  }

  log.info('Refreshing expired access token...');
  const refreshed = await refreshGoogleAccessToken(readGoogleToken(credential.refreshToken));

  if (!refreshed.ok) {
    await markCredentialFailure(credential.id, refreshed.failure);
    return null;
  }

  // Update credential in database, clearing any prior failure: a successful
  // refresh is the authoritative signal that the account is healthy again.
  await prisma.emailIntegrationCredential.update({
    where: { id: credential.id },
    data: {
      accessToken: encryptGoogleToken(refreshed.accessToken),
      expiresAt: refreshed.expiresAt,
      state: 'connected',
      lastErrorReason: null,
    },
  });

  return refreshed.accessToken;
}

/**
 * Strip HTML tags and decode entities
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transform emails to contacts format, filtering by contacts user has sent to
 */
async function transformAndFilterEmails(
  emails: ParsedEmail[],
  userEmail: string,
  userId: string
): Promise<ContactToUpsert[]> {
  // Build user email set (same logic as gmailParser.transformEmailsToContacts)
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);
  for (const email of emails) {
    if (email.isSent) {
      userEmailSet.add(email.from.toLowerCase());
    }
  }
  // Detect imported accounts: emails where neither from nor to/cc includes a known
  // user address were imported. The user's imported address dominates the orphan pool.
  let foundNew = true;
  while (foundNew) {
    foundNew = false;
    const fromCounts = new Map<string, number>();
    const toCounts = new Map<string, number>();
    for (const email of emails) {
      const from = email.from.toLowerCase();
      const allRecipients = [...email.to, ...email.cc].map((e) => e.toLowerCase());
      if (userEmailSet.has(from) || allRecipients.some((r) => userEmailSet.has(r))) continue;
      fromCounts.set(from, (fromCounts.get(from) || 0) + 1);
      for (const r of allRecipients) {
        toCounts.set(r, (toCounts.get(r) || 0) + 1);
      }
    }
    const candidates = [...fromCounts.entries()]
      .filter(([addr]) => (toCounts.get(addr) || 0) >= 5)
      .sort((a, b) => b[1] - a[1]);
    if (candidates.length > 0) {
      const [topAddr, topCount] = candidates[0];
      const secondCount = candidates.length > 1 ? candidates[1][1] : 0;
      if (topCount >= 20 && (secondCount === 0 || topCount >= secondCount * 3)) {
        userEmailSet.add(topAddr);
        foundNew = true;
        log.info('Detected imported account', {
          from: topCount,
          to: toCounts.get(topAddr) || 0,
          next: secondCount,
        });
      }
    }
  }
  log.info('userEmailSet computed', { count: userEmailSet.size });

  // Group emails by contact
  const contactMap = new Map<
    string,
    {
      email: string;
      name: string | null;
      sentCount: number;
      receivedCount: number;
      messages: Array<{
        from: string;
        to: string;
        subject: string;
        date: Date;
        body: string | null;
        isFromMe: boolean;
      }>;
    }
  >();

  for (const email of emails) {
    const isFromMe = email.isSent || userEmailSet.has(email.from.toLowerCase());

    // Determine contact emails
    let contactEmails: string[] = [];
    if (isFromMe) {
      contactEmails = [...email.to, ...email.cc].filter((e) => !userEmailSet.has(e.toLowerCase()));
    } else {
      contactEmails = [email.from];
    }

    // Get plain text body
    let bodyContent = email.bodyText;
    if (!bodyContent && email.bodyHtml) {
      bodyContent = stripHtml(email.bodyHtml);
    }
    if (bodyContent && bodyContent.length > 10000) {
      bodyContent = bodyContent.substring(0, 10000) + '...';
    }

    for (const contactEmail of contactEmails) {
      const contactEmailLower = contactEmail.toLowerCase();

      if (!contactMap.has(contactEmailLower)) {
        contactMap.set(contactEmailLower, {
          email: contactEmailLower,
          name: isFromMe ? null : email.fromName,
          sentCount: 0,
          receivedCount: 0,
          messages: [],
        });
      }

      const contact = contactMap.get(contactEmailLower)!;

      if (isFromMe) {
        contact.sentCount++;
      } else {
        contact.receivedCount++;
        if (email.fromName && !contact.name) {
          contact.name = email.fromName;
        }
      }

      contact.messages.push({
        from: email.from,
        to: isFromMe ? contactEmail : userEmail,
        subject: email.subject,
        date: email.date,
        body: bodyContent,
        isFromMe,
      });
    }
  }

  // Get unique contact emails from this batch
  const batchContactEmails = Array.from(contactMap.keys());

  if (batchContactEmails.length === 0) {
    return [];
  }

  // Query database to find contacts user has ever sent to
  const sentToContacts = await prisma.messageRecord.findMany({
    where: {
      channel: MessageChannel.EMAIL,
      to: { in: batchContactEmails },
      userId,
    },
    select: { to: true },
    distinct: ['to'],
  });

  const historicallySentTo = new Set(
    sentToContacts.map((m) => m.to?.toLowerCase()).filter(Boolean)
  );

  // Also include contacts we sent to in THIS batch
  for (const [email, contact] of contactMap) {
    if (contact.sentCount > 0) {
      historicallySentTo.add(email);
    }
  }

  // Filter to only contacts user has sent to
  const validContacts = Array.from(contactMap.entries())
    .filter(([email]) => historicallySentTo.has(email))
    .map(([, contact]) => contact);

  log.info('Filtered contacts (user has sent to them)', { count: validContacts.length });

  // Transform to ContactToUpsert format
  return validContacts.map((contact) => {
    let firstName = '';
    let lastName = '';
    if (contact.name) {
      const nameParts = contact.name.split(' ');
      firstName = nameParts[0] || '';
      lastName = nameParts.slice(1).join(' ') || '';
    }

    return {
      identifier: contact.email,
      identifierType: 'email' as const,
      firstName,
      lastName,
      email: contact.email,
      emailAddresses: [contact.email],
      messages: contact.messages.map((msg) => ({
        channel: MessageChannel.EMAIL,
        from: msg.from,
        to: msg.to,
        timestamp: msg.date,
        message: msg.subject + (msg.body ? '\n\n' + msg.body : ''),
      })),
    };
  });
}

/**
 * Sync Gmail for a single user
 */
async function syncGmailForUser(
  userId: string,
  credential: {
    id: string;
    email: string | null;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date | null;
    metadata: unknown;
  },
  integrationId: string
): Promise<{ success: boolean; contacts: number; messages: number; messagesTotal?: number }> {
  const credentialEmail = credential.email || '';
  log.info('Starting sync for user', { userId, credentialId: credential.id });

  // Get valid access token
  const accessToken = await getValidAccessToken(credential);
  if (!accessToken) {
    log.error('Failed to get valid access token', { credentialId: credential.id });
    return { success: false, contacts: 0, messages: 0 };
  }

  // Re-fetch integration from DB to get the latest config.
  // Without this, sequential credential syncs clobber each other's historyIds
  // and counts because they all spread from the same stale config snapshot.
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, config: true },
  });
  if (!integration) {
    log.error('Integration not found', { integrationId });
    return { success: false, contacts: 0, messages: 0 };
  }

  const config = (integration.config || {}) as IntegrationConfig;

  // Per-credential historyId: stored in config.historyIds[credentialEmail]
  // Falls back to legacy config.historyId for the primary account
  const historyIds = config.historyIds;
  const historyId =
    historyIds?.[credentialEmail] ||
    (credentialEmail === config.userEmail ? config.historyId : undefined);

  // Use the credential's own email for sender detection
  let userEmail = credentialEmail;
  if (!userEmail) {
    try {
      const profile = await getGmailProfile(accessToken);
      userEmail = profile.emailAddress;
    } catch {
      log.error('Failed to get user email', { credentialId: credential.id });
      return { success: false, contacts: 0, messages: 0 };
    }
  }

  let emails: ParsedEmail[] = [];
  let newHistoryId: string;
  // The mailbox size Google reports on a full sync (the progress bar's total).
  let messagesTotal: number | undefined;

  if (historyId) {
    // Incremental sync using History API
    log.info('Performing incremental sync', { credentialId: credential.id });

    const historyResult = await fetchGmailHistory(accessToken, historyId);

    if (historyResult.newHistoryId === '') {
      // History expired, need full sync
      log.info('History expired, falling back to full sync', { credentialId: credential.id });
      emails = await fetchGmailEmails(accessToken, userEmail);
      const profile = await getGmailProfile(accessToken);
      newHistoryId = profile.historyId;
      messagesTotal = profile.messagesTotal;
    } else if (historyResult.addedMessageIds.length === 0) {
      // No new messages
      log.info('No new messages', { credentialId: credential.id });
      newHistoryId = historyResult.newHistoryId;
    } else {
      // Fetch the new messages
      log.info('New messages found', {
        credentialId: credential.id,
        count: historyResult.addedMessageIds.length,
      });
      emails = await fetchMessagesByIds(accessToken, historyResult.addedMessageIds);
      newHistoryId = historyResult.newHistoryId;
    }
  } else {
    // Full sync (first time for this credential)
    log.info('Performing full sync (no historyId)', { credentialId: credential.id });
    emails = await fetchGmailEmails(accessToken, userEmail);
    const profile = await getGmailProfile(accessToken);
    newHistoryId = profile.historyId;
    messagesTotal = profile.messagesTotal;
  }

  let contactCount = 0;
  let messageCount = 0;

  if (emails.length > 0) {
    // Transform and filter emails (import detection is built into transformAndFilterEmails)
    const contactsToUpsert = await transformAndFilterEmails(emails, userEmail, userId);

    if (contactsToUpsert.length > 0) {
      // Use shared manager for DB operations
      const result = await upsertPersonAndMessageRecords(
        userId,
        contactsToUpsert,
        `gmail-sync-${credential.id}-${Date.now()}`,
        credentialEmail,
        credential.id
      );
      contactCount = result.contacts;
      messageCount = result.messages;
    }
  }

  // Get existing counts and add new counts
  const existingContacts = config.contacts || 0;
  const existingMessages = config.messages || 0;

  // Update integration with per-credential historyId
  const updatedHistoryIds = { ...(historyIds || {}), [credentialEmail]: newHistoryId };

  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      // Status stays SYNCING (the job's claim) until every credential is done;
      // runGmailSyncJob sets CONNECTED once, so no instance re-claims mid-run.
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      config: {
        ...config,
        historyIds: updatedHistoryIds,
        // Keep legacy historyId for backwards compat with primary account
        ...(credentialEmail === config.userEmail ? { historyId: newHistoryId } : {}),
        contacts: existingContacts + contactCount,
        messages: existingMessages + messageCount,
      },
    },
  });

  // A completed sync clears any prior failure. getValidAccessToken only clears
  // it when it actually refreshed; a credential whose access token was still
  // valid would otherwise stay marked failed from an earlier transient error.
  await markCredentialHealthy(credential.id);

  log.info('Sync complete', {
    credentialId: credential.id,
    newContacts: contactCount,
    newMessages: messageCount,
  });
  return { success: true, contacts: contactCount, messages: messageCount, messagesTotal };
}

/** One best-effort sync-progress write for a Gmail row (never fails the sync). */
function reportGmailProgress(
  integration: { userId: string; accountId: string },
  input: ProgressWriteInput
): Promise<void> {
  return reportProgressBestEffort({
    userId: integration.userId,
    provider: 'gmail',
    accountId: integration.accountId,
    input,
  });
}

/**
 * Run the Gmail sync job - finds all integrations due for sync and processes them
 */
/**
 * Atomically claim an integration for this sync: flip it to SYNCING only while
 * it is still due (CONNECTED / SYNC_FAILED, or a SYNCING row abandoned for
 * longer than the sync interval). Exactly one caller wins across overlapping
 * ticks and backend instances; lastSyncAt then fences crash recovery.
 */
export async function claimGmailIntegrationForSync(integrationId: string): Promise<boolean> {
  const syncIntervalCutoff = new Date(Date.now() - SYNC_INTERVAL_MS);
  const claimed = await prisma.integration.updateMany({
    where: {
      id: integrationId,
      OR: [
        { status: { in: [IntegrationStatus.CONNECTED, IntegrationStatus.SYNC_FAILED] } },
        { status: IntegrationStatus.SYNCING, lastSyncAt: { lt: syncIntervalCutoff } },
      ],
    },
    data: { status: IntegrationStatus.SYNCING, lastSyncAt: new Date() },
  });
  if (claimed.count === 0) {
    log.info('Integration already claimed by another sync; skipping', { integrationId });
  }
  return claimed.count === 1;
}

export async function runGmailSyncJob(): Promise<void> {
  log.info('Starting sync job...');

  const syncIntervalCutoff = new Date(Date.now() - SYNC_INTERVAL_MS);

  // Find Gmail integrations that are due for sync.
  // CONNECTED/SYNC_FAILED: always eligible (sync immediately)
  // SYNCING: only re-pick if lastSyncAt > 1 hour ago (crash recovery)
  const dueIntegrations = await prisma.integration.findMany({
    where: {
      name: 'gmail',
      isActive: true,
      OR: [
        { status: { in: [IntegrationStatus.CONNECTED, IntegrationStatus.SYNC_FAILED] } },
        { status: IntegrationStatus.SYNCING, lastSyncAt: { lt: syncIntervalCutoff } },
      ],
    },
    include: {
      emailCredentials: {
        where: { provider: EmailProvider.GMAIL },
      },
    },
  });

  log.info('Integrations due for sync', { count: dueIntegrations.length });

  let successCount = 0;
  let failCount = 0;

  for (const integration of dueIntegrations) {
    // Skip credentials the user must re-consent to. Their refresh token is gone,
    // so retrying is a guaranteed 400 from Google every cron tick -- pure noise
    // that also kept the whole integration pinned to SYNC_FAILED and starved the
    // healthy accounts sharing this row of a CONNECTED status.
    const allCredentials = integration.emailCredentials.filter((c) => c.refreshToken);
    const validCredentials = allCredentials.filter((c) => c.state !== 'needs_reconnect');
    const needsReconnectCount = allCredentials.length - validCredentials.length;

    if (needsReconnectCount > 0) {
      log.info('Skipping credentials awaiting reconnection', {
        integrationId: integration.id,
        count: needsReconnectCount,
      });
    }

    if (validCredentials.length === 0) {
      log.info('Skipping integration - no syncable credentials', { integrationId: integration.id });
      continue;
    }

    if (!(await claimGmailIntegrationForSync(integration.id))) continue;

    // Sync progress: messages saved / the mailboxes' messagesTotal (null until
    // every synced address reported one, e.g. an incremental history sync).
    const runId = `gmail-sync:${integration.id}:${Date.now()}`;
    let saved = 0;
    let total: number | null = 0;
    await reportGmailProgress(integration, {
      runId,
      state: 'syncing',
      unit: 'messages',
      done: 0,
      total: null,
    });

    // Sync each credential (email account) separately
    let allSucceeded = true;
    let lastError: string | null = null;

    for (const credential of validCredentials) {
      try {
        log.info('Syncing credential', {
          credentialId: credential.id,
          integrationId: integration.id,
        });
        const result = await syncGmailForUser(integration.userId, credential, integration.id);

        if (!result.success) {
          allSucceeded = false;
          lastError = 'Gmail sync failed';
        }
        saved += result.messages;
        total =
          total === null || result.messagesTotal === undefined
            ? null
            : total + result.messagesTotal;
        await reportGmailProgress(integration, { runId, state: 'syncing', done: saved, total });
      } catch (error) {
        log.error('Error syncing credential', {
          credentialId: credential.id,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        allSucceeded = false;
        lastError = 'Gmail sync failed';
      }
    }

    await reportGmailProgress(integration, {
      runId,
      state: allSucceeded ? 'synced' : 'failed',
      done: saved,
      total,
      error: allSucceeded ? null : lastError,
    });

    if (allSucceeded) {
      successCount++;
      await prisma.integration.update({
        where: { id: integration.id },
        data: { status: IntegrationStatus.CONNECTED },
      });
    } else {
      failCount++;
      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          lastFailedSyncAt: new Date(),
          status: IntegrationStatus.SYNC_FAILED,
          failureReason: lastError || 'Sync failed - check logs',
        },
      });
    }
  }

  log.info('Sync job complete', { succeeded: successCount, failed: failCount });
}
