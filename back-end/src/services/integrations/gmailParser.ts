import { MessageChannel } from '@prisma/client';
import fetch from 'node-fetch';
import { logTruncate } from '../../lib/log';
import { upsertPersonAndMessageRecords, ContactToUpsert } from './personMessageManager';

export interface ParsedEmail {
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  messageId: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailProfileResponse {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

interface GmailHistoryResponse {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
    messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  }>;
  nextPageToken?: string;
  historyId: string;
}

interface GmailMessageResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string; size?: number };
    parts?: GmailMessagePart[];
    mimeType?: string;
  };
  internalDate?: string;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

interface EmailContact {
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get Gmail profile including current historyId
 */
export async function getGmailProfile(accessToken: string): Promise<GmailProfileResponse> {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Gmail] Failed to get profile: ${response.status} - ${logTruncate(errorText)}`);
    throw new Error(`Gmail API error: ${response.status}`);
  }

  return (await response.json()) as GmailProfileResponse;
}

/**
 * Fetch history of changes since a given historyId
 * Returns message IDs that were added since the historyId, and the new historyId
 */
export async function fetchGmailHistory(
  accessToken: string,
  startHistoryId: string
): Promise<{ addedMessageIds: string[]; newHistoryId: string }> {
  const addedMessageIds: string[] = [];
  let pageToken: string | undefined;
  let newHistoryId = startHistoryId;

  console.log(`[Gmail] Fetching history since historyId: ${startHistoryId}`);

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes', 'messageAdded');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 404 means historyId is too old or invalid - need full sync
      if (response.status === 404) {
        console.log('[Gmail] History expired, full sync required');
        return { addedMessageIds: [], newHistoryId: '' };
      }
      console.error(`[Gmail] Failed to fetch history: ${response.status} - ${logTruncate(errorText)}`);
      throw new Error(`Gmail API error: ${response.status}`);
    }

    const data = (await response.json()) as GmailHistoryResponse;

    if (data.history) {
      for (const historyItem of data.history) {
        if (historyItem.messagesAdded) {
          for (const added of historyItem.messagesAdded) {
            addedMessageIds.push(added.message.id);
          }
        }
      }
    }

    newHistoryId = data.historyId;
    pageToken = data.nextPageToken;
  } while (pageToken);

  console.log(`[Gmail] Found ${addedMessageIds.length} new messages, new historyId: ${newHistoryId}`);
  return { addedMessageIds, newHistoryId };
}

/**
 * Fetch specific messages by their IDs
 */
export async function fetchMessagesByIds(
  accessToken: string,
  messageIds: string[]
): Promise<ParsedEmail[]> {
  if (messageIds.length === 0) return [];

  const emails: ParsedEmail[] = [];
  const BATCH_SIZE = 100;

  console.log(`[Gmail] Fetching ${messageIds.length} messages by ID...`);

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);

    try {
      const batchResults = await fetchMessagesBatch(accessToken, batch);
      const validEmails = batchResults.filter((e): e is ParsedEmail => e !== null);
      emails.push(...validEmails);
    } catch (error) {
      console.error(`[Gmail] Batch request failed:`, error);
    }

    // Small delay between batches
    if (i + BATCH_SIZE < messageIds.length) {
      await sleep(100);
    }
  }

  console.log(`[Gmail] Successfully fetched ${emails.length} messages`);
  return emails;
}

/**
 * Fetch emails since a given timestamp using Gmail's search query
 * Returns all emails (no filtering by contact) - useful for OTPs and notifications
 */
export async function fetchGmailMessagesSince(
  accessToken: string,
  since: Date,
  limit: number = 50
): Promise<ParsedEmail[]> {
  const unixSeconds = Math.floor(since.getTime() / 1000);
  const query = `after:${unixSeconds}`;

  console.log(`[Gmail] Fetching messages since ${since.toISOString()} (query: ${query})`);

  const messageIds: string[] = [];
  let pageToken: string | undefined;

  // Fetch message IDs with the after: filter
  do {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', query);
    listUrl.searchParams.set('maxResults', String(Math.min(limit - messageIds.length, 100)));
    if (pageToken) {
      listUrl.searchParams.set('pageToken', pageToken);
    }

    const listResponse = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error(`[Gmail] Failed to list messages: ${listResponse.status} - ${logTruncate(errorText)}`);
      throw new Error(`Gmail API error: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as GmailMessageListResponse;

    if (listData.messages) {
      messageIds.push(...listData.messages.map(m => m.id));
    }

    pageToken = listData.nextPageToken;

    // Stop if we've hit the limit
    if (messageIds.length >= limit) {
      break;
    }
  } while (pageToken);

  console.log(`[Gmail] Found ${messageIds.length} messages since ${since.toISOString()}`);

  if (messageIds.length === 0) {
    return [];
  }

  // Fetch full message details
  return fetchMessagesByIds(accessToken, messageIds.slice(0, limit));
}

/**
 * Fetch multiple messages using Gmail Batch API (up to 100 per request)
 */
async function fetchMessagesBatch(
  accessToken: string,
  messageIds: string[]
): Promise<(ParsedEmail | null)[]> {
  const boundary = `batch_gmail_${Date.now()}`;

  // Build multipart request body
  const parts = messageIds.map(
    id =>
      `--${boundary}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <${id}>\r\n\r\n` +
      `GET /gmail/v1/users/me/messages/${id}?format=full\r\n`
  );
  const body = parts.join('') + `--${boundary}--`;

  const response = await fetch('https://www.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/mixed; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Gmail] Batch request failed: ${response.status} - ${logTruncate(errorText)}`);
    throw new Error(`Gmail batch API error: ${response.status}`);
  }

  // Parse multipart response
  const responseText = await response.text();
  const responseBoundary = response.headers.get('content-type')?.match(/boundary=(.+)/)?.[1];

  if (!responseBoundary) {
    console.error('[Gmail] Could not find boundary in batch response');
    return messageIds.map(() => null);
  }

  const results: (ParsedEmail | null)[] = [];
  const responseParts = responseText.split(`--${responseBoundary}`);

  for (const part of responseParts) {
    if (!part.trim() || part.trim() === '--') continue;

    // Find the JSON body in each part (after the HTTP status line and headers)
    const jsonMatch = part.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;

    try {
      const msgData = JSON.parse(jsonMatch[0]) as GmailMessageResponse;
      if (msgData.id && msgData.payload) {
        results.push(parseGmailMessage(msgData));
      } else if (msgData.id) {
        // Might be an error response
        results.push(null);
      }
    } catch {
      // Skip malformed responses
      results.push(null);
    }
  }

  return results;
}

/**
 * Fetch ALL emails from Gmail API, paginating through all pages
 */
export async function fetchGmailEmails(accessToken: string): Promise<ParsedEmail[]> {
  const emails: ParsedEmail[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;

  console.log('[Gmail] Starting to fetch all emails...');

  // First, get list of all message IDs
  const allMessageIds: string[] = [];

  do {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('maxResults', '500'); // Max allowed per request
    if (pageToken) {
      listUrl.searchParams.set('pageToken', pageToken);
    }

    const listResponse = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error(`[Gmail] Failed to list messages: ${listResponse.status} - ${logTruncate(errorText)}`);
      throw new Error(`Gmail API error: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as GmailMessageListResponse;

    if (listData.messages) {
      allMessageIds.push(...listData.messages.map(m => m.id));
    }

    pageToken = listData.nextPageToken;
    pageCount++;

    console.log(`[Gmail] Fetched page ${pageCount}, got ${listData.messages?.length || 0} message IDs (total: ${allMessageIds.length})`);
  } while (pageToken);

  console.log(`[Gmail] Found ${allMessageIds.length} total messages, fetching details via batch API...`);

  // Fetch message details using Gmail Batch API (up to 100 per batch request)
  const BATCH_SIZE = 100;
  for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
    const batch = allMessageIds.slice(i, i + BATCH_SIZE);

    try {
      const batchResults = await fetchMessagesBatch(accessToken, batch);
      const validEmails = batchResults.filter((e): e is ParsedEmail => e !== null);
      emails.push(...validEmails);
    } catch (error) {
      console.error(`[Gmail] Batch request failed:`, error);
    }

    const processed = Math.min(i + BATCH_SIZE, allMessageIds.length);
    if (processed % 1000 === 0 || processed >= allMessageIds.length) {
      console.log(`[Gmail] Processed ${processed}/${allMessageIds.length} messages (${emails.length} valid)`);
    }

    // Small delay between batches to be nice to the API
    if (i + BATCH_SIZE < allMessageIds.length) {
      await sleep(100);
    }
  }

  console.log(`[Gmail] Successfully parsed ${emails.length} emails`);
  return emails;
}

/**
 * Parse a Gmail API message response into our ParsedEmail format
 */
function parseGmailMessage(msg: GmailMessageResponse): ParsedEmail | null {
  try {
    const headers = msg.payload?.headers || [];

    const getHeader = (name: string): string | null => {
      const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
      return header?.value || null;
    };

    const fromHeader = getHeader('From') || '';
    const from = extractEmailAddress(fromHeader);
    if (!from) return null;

    const fromName = extractName(fromHeader);
    const toHeader = getHeader('To') || '';
    const ccHeader = getHeader('Cc') || '';
    const to = extractEmailAddresses(toHeader);
    const cc = extractEmailAddresses(ccHeader);
    const subject = decodeHeader(getHeader('Subject') || '(No Subject)');
    const messageId = getHeader('Message-ID');

    // Parse date from internalDate (milliseconds since epoch)
    let date: Date;
    if (msg.internalDate) {
      date = new Date(parseInt(msg.internalDate, 10));
    } else {
      const dateHeader = getHeader('Date');
      date = dateHeader ? new Date(dateHeader) : new Date();
    }

    if (isNaN(date.getTime())) {
      date = new Date();
    }

    // Extract body content
    const { text: bodyText, html: bodyHtml } = extractBody(msg.payload);

    return {
      from,
      fromName,
      to,
      cc,
      subject,
      date,
      messageId,
      bodyText,
      bodyHtml,
    };
  } catch (error) {
    console.error('[Gmail] Error parsing message:', error);
    return null;
  }
}

/**
 * Extract body text and HTML from Gmail message payload
 */
function extractBody(payload?: GmailMessageResponse['payload']): { text: string | null; html: string | null } {
  if (!payload) return { text: null, html: null };

  let text: string | null = null;
  let html: string | null = null;

  // Check if body is directly in payload
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/html') {
      html = decoded;
    } else {
      text = decoded;
    }
  }

  // Check parts recursively
  if (payload.parts) {
    const result = extractBodyFromParts(payload.parts);
    if (!text && result.text) text = result.text;
    if (!html && result.html) html = result.html;
  }

  return { text, html };
}

function extractBodyFromParts(parts: GmailMessagePart[]): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;

  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data && !text) {
      text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    } else if (part.parts) {
      // Nested multipart
      const nested = extractBodyFromParts(part.parts);
      if (!text && nested.text) text = nested.text;
      if (!html && nested.html) html = nested.html;
    }
  }

  return { text, html };
}

function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractEmailAddress(str: string): string | null {
  // Match email in angle brackets: "Name <email@domain.com>"
  const angleMatch = str.match(/<([^>]+@[^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase();

  // Match plain email
  const plainMatch = str.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (plainMatch) return plainMatch[0].toLowerCase();

  return null;
}

function extractEmailAddresses(str: string): string[] {
  const emails: string[] = [];

  // Split by comma, handling quoted names
  const parts = str.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);

  for (const part of parts) {
    const email = extractEmailAddress(part);
    if (email) emails.push(email);
  }

  return emails;
}

function extractName(str: string): string | null {
  // Match name before angle brackets: "Name <email@domain.com>"
  const match = str.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();

  // Match quoted name
  const quotedMatch = str.match(/^"([^"]+)"/);
  if (quotedMatch) return quotedMatch[1].trim();

  return null;
}

function decodeHeader(str: string): string {
  // Decode RFC 2047 encoded words: =?charset?encoding?text?=
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      } else if (encoding.toUpperCase() === 'Q') {
        return decodeQuotedPrintable(text.replace(/_/g, ' '));
      }
    } catch {
      return text;
    }
    return text;
  });
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // Soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

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
 * Transform emails into ContactToUpsert format grouped by contact
 */
function transformEmailsToContacts(emails: ParsedEmail[], userEmail: string): ContactToUpsert[] {
  const userEmailSet = new Set([userEmail.toLowerCase()]);
  const contactMap = new Map<string, EmailContact>();

  for (const email of emails) {
    const isFromMe = userEmailSet.has(email.from);

    // Determine the contact email(s)
    let contactEmails: string[] = [];

    if (isFromMe) {
      // User sent this email - contacts are recipients
      contactEmails = [...email.to, ...email.cc].filter(e => !userEmailSet.has(e));
    } else {
      // User received this email - contact is sender
      contactEmails = [email.from];
    }

    // Get plain text body, stripping HTML if needed
    let bodyContent = email.bodyText;
    if (!bodyContent && email.bodyHtml) {
      bodyContent = stripHtml(email.bodyHtml);
    }

    // Truncate body to reasonable length
    if (bodyContent && bodyContent.length > 10000) {
      bodyContent = bodyContent.substring(0, 10000) + '...';
    }

    for (const contactEmail of contactEmails) {
      if (!contactMap.has(contactEmail)) {
        contactMap.set(contactEmail, {
          email: contactEmail,
          name: isFromMe ? null : email.fromName,
          sentCount: 0,
          receivedCount: 0,
          messages: [],
        });
      }

      const contact = contactMap.get(contactEmail)!;

      if (isFromMe) {
        contact.sentCount++;
      } else {
        contact.receivedCount++;
        // Update name if we have one
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

  // Filter contacts: user must have SENT at least one email to them
  const validContacts = Array.from(contactMap.values()).filter(c => c.sentCount > 0);

  // Transform to ContactToUpsert format
  return validContacts.map(contact => {
    // Parse name into firstName/lastName
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
 * Import Gmail emails into the database using the shared manager
 */
export async function parseGmailOAuthEmails(
  userId: string,
  userEmail: string,
  emails: ParsedEmail[],
  jobId: string
): Promise<{ contacts: number; messages: number }> {
  console.log(`[Job ${jobId}] Processing ${emails.length} Gmail emails for user ${userId}`);

  // Transform emails to contacts format
  const contactsToUpsert = transformEmailsToContacts(emails, userEmail);
  console.log(`[Job ${jobId}] Found ${contactsToUpsert.length} valid contacts (sent at least one email)`);

  // Use shared manager for DB operations
  const result = await upsertPersonAndMessageRecords(userId, contactsToUpsert, jobId);

  console.log(`[Job ${jobId}] ✅ Gmail sync complete: ${result.contacts} contacts, ${result.messages} messages`);
  return result;
}
