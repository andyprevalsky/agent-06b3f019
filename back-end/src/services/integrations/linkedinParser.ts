import { MessageChannel } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

// ── Types ──────────────────────────────────────────────

interface LinkedInConnection {
  firstName: string;
  lastName: string;
  url: string;
  emailAddress: string;
  company: string;
  position: string;
  connectedOn: string;
}

interface LinkedInMessage {
  conversationId: string;
  conversationTitle: string;
  from: string;
  senderProfileUrl: string;
  to: string;
  recipientProfileUrls: string;
  date: string;
  subject: string;
  content: string;
  folder: string;
}

interface LinkedInProfile {
  firstName: string;
  lastName: string;
  headline: string;
  summary: string;
  industry: string;
  geoLocation: string;
}

interface LinkedInPosition {
  companyName: string;
  title: string;
  description: string;
  location: string;
  startedOn: string;
  finishedOn: string;
}

export interface LinkedInExportData {
  connections: LinkedInConnection[];
  messages: LinkedInMessage[];
  profile: LinkedInProfile | null;
  positions: LinkedInPosition[];
}

// ── Date Parsing ────────────────────────────────────────

function parseLinkedInDate(dateStr: string): Date {
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed;

  // LinkedIn sometimes uses "YYYY/MM/DD HH:mm:ss" or other non-ISO formats
  const isoAttempt = new Date(dateStr.replace(/\//g, '-'));
  if (!isNaN(isoAttempt.getTime())) return isoAttempt;

  console.warn(`[LinkedInParser] Unparseable date "${dateStr}", using current time`);
  return new Date();
}

// ── CSV Parsing Helpers ──────────────────────────────────

function parseCsvBuffer(buffer: Buffer, columns: string[]): Record<string, string>[] {
  const content = buffer.toString('utf-8');
  // LinkedIn exports sometimes have notes/disclaimers before the header row
  // Find the actual header line by looking for the expected columns
  const lines = content.split('\n');
  let headerIndex = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (columns.some(col => lines[i].includes(col))) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return [];

  const csvContent = lines.slice(headerIndex).join('\n');
  try {
    return parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch (err) {
    console.error('[LinkedInParser] CSV parse error:', err);
    return [];
  }
}

// ── ZIP Extraction ──────────────────────────────────────

export function parseLinkedInZip(zipPath: string): LinkedInExportData {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  const result: LinkedInExportData = {
    connections: [],
    messages: [],
    profile: null,
    positions: [],
  };

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.split('/').pop() || entry.entryName;
    const buffer = entry.getData();

    switch (name) {
      case 'Connections.csv': {
        const rows = parseCsvBuffer(buffer, ['First Name', 'Last Name', 'URL']);
        result.connections = rows.map(r => ({
          firstName: r['First Name'] || '',
          lastName: r['Last Name'] || '',
          url: r['URL'] || '',
          emailAddress: r['Email Address'] || '',
          company: r['Company'] || '',
          position: r['Position'] || '',
          connectedOn: r['Connected On'] || '',
        }));
        break;
      }
      case 'messages.csv': {
        const rows = parseCsvBuffer(buffer, ['CONVERSATION ID', 'FROM', 'CONTENT']);
        result.messages = rows.map(r => ({
          conversationId: r['CONVERSATION ID'] || '',
          conversationTitle: r['CONVERSATION TITLE'] || '',
          from: r['FROM'] || '',
          senderProfileUrl: r['SENDER PROFILE URL'] || '',
          to: r['TO'] || '',
          recipientProfileUrls: r['RECIPIENT PROFILE URLS'] || '',
          date: r['DATE'] || '',
          subject: r['SUBJECT'] || '',
          content: r['CONTENT'] || '',
          folder: r['FOLDER'] || '',
        }));
        break;
      }
      case 'Profile.csv': {
        const rows = parseCsvBuffer(buffer, ['First Name', 'Last Name']);
        if (rows.length > 0) {
          const r = rows[0];
          result.profile = {
            firstName: r['First Name'] || '',
            lastName: r['Last Name'] || '',
            headline: r['Headline'] || '',
            summary: r['Summary'] || '',
            industry: r['Industry'] || '',
            geoLocation: r['Geo Location'] || '',
          };
        }
        break;
      }
      case 'Positions.csv': {
        const rows = parseCsvBuffer(buffer, ['Company Name', 'Title']);
        result.positions = rows.map(r => ({
          companyName: r['Company Name'] || '',
          title: r['Title'] || '',
          description: r['Description'] || '',
          location: r['Location'] || '',
          startedOn: r['Started On'] || '',
          finishedOn: r['Finished On'] || '',
        }));
        break;
      }
    }
  }

  console.log(`[LinkedInParser] Extracted: ${result.connections.length} connections, ${result.messages.length} messages, ${result.positions.length} positions`);
  return result;
}

// ── Transform to ContactToUpsert ────────────────────────

function buildProfileUrlIndex(connections: LinkedInConnection[]): Map<string, LinkedInConnection> {
  const index = new Map<string, LinkedInConnection>();
  for (const conn of connections) {
    if (conn.url) {
      // Normalize URL: strip trailing slash, lowercase
      const normalized = conn.url.replace(/\/$/, '').toLowerCase();
      index.set(normalized, conn);
    }
  }
  return index;
}

export function transformLinkedInContacts(
  data: LinkedInExportData,
  userProfileUrl?: string
): ContactToUpsert[] {
  const urlIndex = buildProfileUrlIndex(data.connections);

  // Group messages by sender profile URL (excluding messages from the user themselves)
  const messagesBySender = new Map<string, LinkedInMessage[]>();
  for (const msg of data.messages) {
    if (!msg.senderProfileUrl || !msg.content) continue;
    const normalizedUrl = msg.senderProfileUrl.replace(/\/$/, '').toLowerCase();
    // Skip messages from the user
    if (userProfileUrl && normalizedUrl === userProfileUrl.replace(/\/$/, '').toLowerCase()) continue;
    if (!messagesBySender.has(normalizedUrl)) {
      messagesBySender.set(normalizedUrl, []);
    }
    messagesBySender.get(normalizedUrl)!.push(msg);
  }

  const contacts: ContactToUpsert[] = [];

  // Process each connection
  for (const conn of data.connections) {
    if (!conn.firstName && !conn.lastName) continue;

    const normalizedUrl = conn.url?.replace(/\/$/, '').toLowerCase() || '';
    const senderMessages = normalizedUrl ? (messagesBySender.get(normalizedUrl) || []) : [];

    // Build identifier: prefer email, fall back to LinkedIn URL
    const identifier = conn.emailAddress || conn.url;
    if (!identifier) continue;
    const identifierType: 'email' | 'linkedin_url' = conn.emailAddress ? 'email' : 'linkedin_url';

    contacts.push({
      identifier,
      identifierType,
      firstName: conn.firstName,
      lastName: conn.lastName,
      company: conn.company,
      title: conn.position,
      email: conn.emailAddress || undefined,
      emailAddresses: conn.emailAddress ? [conn.emailAddress] : undefined,
      messages: senderMessages.map((msg, idx) => ({
        channel: MessageChannel.LINKEDIN,
        from: msg.from || 'unknown',
        to: 'me',
        timestamp: parseLinkedInDate(msg.date),
        message: msg.content,
        externalId: `${msg.conversationId}_${idx}`,
      })),
    });

    // Remove from messagesBySender so we can handle orphan messages later
    if (normalizedUrl) {
      messagesBySender.delete(normalizedUrl);
    }
  }

  // Handle messages from non-connections (orphan messages)
  for (const [senderUrl, messages] of messagesBySender) {
    if (!messages.length) continue;
    const firstMsg = messages[0];

    contacts.push({
      identifier: senderUrl,
      identifierType: 'linkedin_url',
      firstName: firstMsg.from?.split(' ')[0],
      lastName: firstMsg.from?.split(' ').slice(1).join(' '),
      messages: messages.map((msg, idx) => ({
        channel: MessageChannel.LINKEDIN,
        from: msg.from || 'unknown',
        to: 'me',
        timestamp: parseLinkedInDate(msg.date),
        message: msg.content,
        externalId: `${msg.conversationId}_${idx}`,
      })),
    });
  }

  // Also add messages FROM the user (to the respective recipients)
  for (const msg of data.messages) {
    if (!msg.senderProfileUrl || !msg.content) continue;
    const normalizedUrl = msg.senderProfileUrl.replace(/\/$/, '').toLowerCase();
    // Only process messages FROM the user
    if (!userProfileUrl || normalizedUrl !== userProfileUrl.replace(/\/$/, '').toLowerCase()) continue;

    // LinkedIn exports comma-separated URLs for group conversations
    const recipientUrls = (msg.recipientProfileUrls || '')
      .split(',')
      .map(u => u.trim().replace(/\/$/, '').toLowerCase())
      .filter(Boolean);

    for (const recipientUrl of recipientUrls) {
      const existingContact = contacts.find(c => {
        const cUrl = (c.identifier || '').replace(/\/$/, '').toLowerCase();
        return cUrl === recipientUrl;
      });

      if (existingContact) {
        existingContact.messages.push({
          channel: MessageChannel.LINKEDIN,
          from: 'me',
          to: msg.to || 'unknown',
          timestamp: parseLinkedInDate(msg.date),
          message: msg.content,
          externalId: `${msg.conversationId}_sent_${existingContact.messages.length}`,
        });
      }
    }
  }

  return contacts;
}

// ── Main Import Function ────────────────────────────────

export async function importLinkedInData(
  userId: string,
  zipPath: string,
  jobId: string
): Promise<{ contacts: number; messages: number }> {
  console.log(`[Job ${jobId}] Parsing LinkedIn ZIP: ${zipPath}`);

  const data = parseLinkedInZip(zipPath);

  // Determine user's profile URL
  let userProfileUrl: string | undefined;

  // Strategy 1: Match profile name against message senders
  if (data.profile?.firstName && data.profile?.lastName) {
    const userName = `${data.profile.firstName} ${data.profile.lastName}`;
    const userMsg = data.messages.find(m => m.from === userName);
    if (userMsg?.senderProfileUrl) {
      userProfileUrl = userMsg.senderProfileUrl;
    }
  }

  // Strategy 2 (fallback): The user is the sender who appears in the most
  // distinct conversations — no other contact appears in every conversation.
  if (!userProfileUrl && data.messages.length > 0) {
    const convoBySender = new Map<string, Set<string>>();
    for (const msg of data.messages) {
      if (!msg.senderProfileUrl) continue;
      const url = msg.senderProfileUrl.replace(/\/$/, '').toLowerCase();
      if (!convoBySender.has(url)) convoBySender.set(url, new Set());
      convoBySender.get(url)!.add(msg.conversationId);
    }
    let maxConvos = 0;
    for (const [url, convos] of convoBySender) {
      if (convos.size > maxConvos) {
        maxConvos = convos.size;
        userProfileUrl = url;
      }
    }
    if (userProfileUrl) {
      console.log(`[Job ${jobId}] Detected user profile URL via frequency heuristic: ${userProfileUrl}`);
    }
  }

  const contactsToUpsert = transformLinkedInContacts(data, userProfileUrl);
  const totalMessages = contactsToUpsert.reduce((sum, c) => sum + c.messages.length, 0);

  console.log(`[Job ${jobId}] Processing ${totalMessages} LinkedIn messages from ${contactsToUpsert.length} contacts for user ${userId}`);

  // Upsert via shared manager
  const result = await upsertPersonAndMessageRecords(userId, contactsToUpsert, jobId);

  // Update integration metadata
  const integration = await prisma.integration.findUnique({
    where: { userId_name: { userId, name: 'linkedin' } },
  });

  if (integration) {
    const existingConfig = (integration.config as any) || {};
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        config: {
          ...existingConfig,
          lastUploadedAt: new Date().toISOString(),
          totalMessagesProcessed: (existingConfig.totalMessagesProcessed || 0) + totalMessages,
          totalContactsProcessed: (existingConfig.totalContactsProcessed || 0) + contactsToUpsert.length,
          batchesReceived: (existingConfig.batchesReceived || 0) + 1,
          profile: data.profile,
          positions: data.positions,
        },
      },
    });
  }

  console.log(`[Job ${jobId}] ✅ LinkedIn sync complete: ${result.contacts} contacts, ${result.messages} messages`);
  return result;
}
