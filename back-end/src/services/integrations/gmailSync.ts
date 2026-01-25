import { prisma } from '../../lib/prisma';
import { IntegrationStatus, EmailProvider, MessageChannel } from '@prisma/client';
import {
  fetchGmailEmails,
  fetchGmailHistory,
  fetchMessagesByIds,
  getGmailProfile,
  ParsedEmail,
} from './gmailParser';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';

// Sync interval: 1 hour
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

// Google OAuth token endpoint
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface IntegrationConfig {
  provider?: string;
  historyId?: string;
  userEmail?: string;
  [key: string]: unknown;
}

/**
 * Refresh an expired Google access token using the refresh token
 */
async function refreshGoogleAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  const clientId = process.env.GMAIL_WEB_CLIENT_ID;
  const clientSecret = process.env.GMAIL_WEB_CLIENT_SECRET;

  if (!clientId) {
    console.error('[GmailSync] Missing GMAIL_WEB_CLIENT_ID');
    return null;
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
      console.error(`[GmailSync] Token refresh failed: ${response.status} - ${errorText}`);
      return null;
    }

    const json = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    return {
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  } catch (error) {
    console.error('[GmailSync] Error refreshing token:', error);
    return null;
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
}): Promise<string | null> {
  // Check if current token is still valid (with 5 min buffer)
  if (
    credential.accessToken &&
    credential.expiresAt &&
    credential.expiresAt > new Date(Date.now() + 5 * 60 * 1000)
  ) {
    return credential.accessToken;
  }

  // Need to refresh
  if (!credential.refreshToken) {
    console.error('[GmailSync] No refresh token available');
    return null;
  }

  console.log('[GmailSync] Refreshing expired access token...');
  const refreshed = await refreshGoogleAccessToken(credential.refreshToken);

  if (!refreshed) {
    return null;
  }

  // Update credential in database
  await prisma.emailIntegrationCredential.update({
    where: { id: credential.id },
    data: {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
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
  const userEmailLower = userEmail.toLowerCase();
  
  // Group emails by contact
  const contactMap = new Map<string, {
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
  }>();

  for (const email of emails) {
    const isFromMe = email.from.toLowerCase() === userEmailLower;
    
    // Determine contact emails
    let contactEmails: string[] = [];
    if (isFromMe) {
      contactEmails = [...email.to, ...email.cc].filter(e => e.toLowerCase() !== userEmailLower);
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
        to: contactEmail,
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
  // MessageRecord.to contains the recipient, and we need to find messages sent by the user
  const sentToContacts = await prisma.messageRecord.findMany({
    where: {
      channel: MessageChannel.EMAIL,
      to: { in: batchContactEmails },
      person: {
        userId,
      },
    },
    select: { to: true },
    distinct: ['to'],
  });

  const historicallySentTo = new Set(sentToContacts.map(m => m.to?.toLowerCase()).filter(Boolean));
  
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

  console.log(`[GmailSync] Filtered to ${validContacts.length} contacts (user has sent to them)`);

  // Transform to ContactToUpsert format
  return validContacts.map(contact => {
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
      messages: contact.messages.map(msg => ({
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
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date | null;
    metadata: unknown;
  },
  integration: {
    id: string;
    config: unknown;
  }
): Promise<{ success: boolean; contacts: number; messages: number }> {
  console.log(`[GmailSync] Starting sync for user ${userId}`);

  // Get valid access token
  const accessToken = await getValidAccessToken(credential);
  if (!accessToken) {
    console.error(`[GmailSync] Failed to get valid access token for user ${userId}`);
    return { success: false, contacts: 0, messages: 0 };
  }

  const config = (integration.config || {}) as IntegrationConfig;
  const historyId = config.historyId;
  
  // Get user email from metadata or profile
  let userEmail = config.userEmail || (credential.metadata as { email?: string })?.email;
  if (!userEmail) {
    try {
      const profile = await getGmailProfile(accessToken);
      userEmail = profile.emailAddress;
    } catch (error) {
      console.error(`[GmailSync] Failed to get user email:`, error);
      return { success: false, contacts: 0, messages: 0 };
    }
  }

  let emails: ParsedEmail[] = [];
  let newHistoryId: string;

  if (historyId) {
    // Incremental sync using History API
    console.log(`[GmailSync] Performing incremental sync from historyId: ${historyId}`);
    
    const historyResult = await fetchGmailHistory(accessToken, historyId);
    
    if (historyResult.newHistoryId === '') {
      // History expired, need full sync
      console.log(`[GmailSync] History expired, falling back to full sync`);
      emails = await fetchGmailEmails(accessToken);
      const profile = await getGmailProfile(accessToken);
      newHistoryId = profile.historyId;
    } else if (historyResult.addedMessageIds.length === 0) {
      // No new messages
      console.log(`[GmailSync] No new messages`);
      newHistoryId = historyResult.newHistoryId;
    } else {
      // Fetch the new messages
      emails = await fetchMessagesByIds(accessToken, historyResult.addedMessageIds);
      newHistoryId = historyResult.newHistoryId;
    }
  } else {
    // Full sync (first time)
    console.log(`[GmailSync] Performing full sync (no historyId)`);
    emails = await fetchGmailEmails(accessToken);
    const profile = await getGmailProfile(accessToken);
    newHistoryId = profile.historyId;
  }

  let contactCount = 0;
  let messageCount = 0;

  if (emails.length > 0) {
    // Transform and filter emails
    const contactsToUpsert = await transformAndFilterEmails(emails, userEmail, userId);

    if (contactsToUpsert.length > 0) {
      // Use shared manager for DB operations
      const result = await upsertPersonAndMessageRecords(
        userId,
        contactsToUpsert,
        `gmail-sync-${Date.now()}`
      );
      contactCount = result.contacts;
      messageCount = result.messages;
    }
  }

  // Get existing counts and add new counts
  const existingContacts = (config.contacts as number) || 0;
  const existingMessages = (config.messages as number) || 0;

  // Update integration with new historyId and lastSyncAt
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      status: IntegrationStatus.CONNECTED,
      config: {
        ...config,
        historyId: newHistoryId,
        userEmail,
        contacts: existingContacts + contactCount,
        messages: existingMessages + messageCount,
      },
    },
  });

  console.log(`[GmailSync] ✅ Sync complete for user ${userId}: ${contactCount} new contacts, ${messageCount} new messages (total: ${existingContacts + contactCount} contacts, ${existingMessages + messageCount} messages)`);
  return { success: true, contacts: contactCount, messages: messageCount };
}

/**
 * Run the Gmail sync job - finds all integrations due for sync and processes them
 */
export async function runGmailSyncJob(): Promise<void> {
  console.log('[GmailSync] Starting sync job...');

  const cutoff = new Date(Date.now() - SYNC_INTERVAL_MS);

  // Find Gmail integrations that are due for sync
  const dueIntegrations = await prisma.integration.findMany({
    where: {
      name: 'gmail',
      isActive: true,
      status: IntegrationStatus.CONNECTED,
      OR: [
        { lastSyncAt: null },
        { lastSyncAt: { lt: cutoff } },
      ],
    },
    include: {
      emailCredentials: {
        where: { provider: EmailProvider.GMAIL },
      },
    },
  });

  console.log(`[GmailSync] Found ${dueIntegrations.length} integrations due for sync`);

  let successCount = 0;
  let failCount = 0;

  for (const integration of dueIntegrations) {
    const credential = integration.emailCredentials[0];
    
    if (!credential || !credential.refreshToken) {
      console.log(`[GmailSync] Skipping integration ${integration.id} - no valid credentials`);
      continue;
    }

    // Immediately mark as syncing to prevent other servers from picking it up
    await prisma.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date() },
    });

    try {
      const result = await syncGmailForUser(integration.userId, credential, integration);
      
      if (result.success) {
        successCount++;
      } else {
        failCount++;
        // Update integration status on failure
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            lastSyncAt: new Date(),
            lastFailedSyncAt: new Date(),
            status: IntegrationStatus.SYNC_FAILED,
            failureReason: 'Sync failed - check logs',
          },
        });
      }
    } catch (error) {
      console.error(`[GmailSync] Error syncing integration ${integration.id}:`, error);
      failCount++;
      
      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          lastSyncAt: new Date(),
          lastFailedSyncAt: new Date(),
          status: IntegrationStatus.SYNC_FAILED,
          failureReason: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  console.log(`[GmailSync] ✅ Sync job complete: ${successCount} succeeded, ${failCount} failed`);
}

