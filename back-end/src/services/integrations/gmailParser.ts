import { MessageChannel } from '@prisma/client';
import fetch, { RequestInit, Response } from 'node-fetch';
import { logTruncate } from '../../utils/log';
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
  isSent: boolean;
  labels: string[];
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

/** Lightweight email metadata (no body content) for contact detection */
interface EmailMetadata {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  isSent: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(
  url: string,
  accessToken: string,
  init?: RequestInit
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...init?.headers },
      });
    } catch (err) {
      // Network error (DNS, timeout, connection reset) — retryable
      const wait = Math.pow(2, attempt) * 2;
      console.warn(`[Gmail] Network error, retrying in ${wait}s (attempt ${attempt + 1}/3):`, err);
      await sleep(wait * 1000);
      continue;
    }
    if (
      response.status === 429 ||
      (response.status === 403 && (await response.clone().text()).includes('rateLimitExceeded'))
    ) {
      const retryAfter = response.headers.get('Retry-After');
      const wait = retryAfter ? Math.min(parseInt(retryAfter), 60) : Math.pow(2, attempt) * 5;
      console.log(
        `[Gmail] Rate limited (${response.status}), waiting ${wait}s (attempt ${attempt + 1}/3)...`
      );
      await sleep(wait * 1000);
      continue;
    }
    if (response.status >= 500) {
      const wait = Math.pow(2, attempt) * 2;
      console.warn(
        `[Gmail] Server error (${response.status}), retrying in ${wait}s (attempt ${attempt + 1}/3)...`
      );
      await sleep(wait * 1000);
      continue;
    }
    return response;
  }
  // Final attempt — let it throw or return whatever happens
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init?.headers },
  });
}

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
      console.error(
        `[Gmail] Failed to fetch history: ${response.status} - ${logTruncate(errorText)}`
      );
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

  console.log(
    `[Gmail] Found ${addedMessageIds.length} new messages, new historyId: ${newHistoryId}`
  );
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

    const listResponse = await fetchWithRetry(listUrl.toString(), accessToken);

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error(
        `[Gmail] Failed to list messages: ${listResponse.status} - ${logTruncate(errorText)}`
      );
      throw new Error(`Gmail API error: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as GmailMessageListResponse;

    if (listData.messages) {
      messageIds.push(...listData.messages.map((m) => m.id));
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
    (id) =>
      `--${boundary}\r\n` +
      `Content-Type: application/http\r\n` +
      `Content-ID: <${id}>\r\n\r\n` +
      `GET /gmail/v1/users/me/messages/${id}?format=full\r\n`
  );
  const body = parts.join('') + `--${boundary}--`;

  const response = await fetchWithRetry('https://www.googleapis.com/batch/gmail/v1', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
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

  const resultMap = new Map<string, ParsedEmail>();
  const rateLimitedIds: string[] = [];
  const cleanBoundary = responseBoundary.replace(/^"(.*)"$/, '$1');
  const responseParts = responseText.split(`--${cleanBoundary}`);

  for (const part of responseParts) {
    if (!part.trim() || part.trim() === '--') continue;

    // Check for rate limiting within sub-response
    const statusMatch = part.match(/HTTP\/\d\.\d (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;

    // Extract message ID from Content-ID header
    const contentIdMatch = part.match(/Content-ID:\s*<response-([^>]+)>/i);
    const msgId = contentIdMatch?.[1];

    if (status === 429 && msgId) {
      rateLimitedIds.push(msgId);
      continue;
    }

    const jsonMatch = part.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;

    try {
      const msgData = JSON.parse(jsonMatch[0]) as GmailMessageResponse;
      if (msgData.id && msgData.payload) {
        const parsed = parseGmailMessage(msgData);
        if (parsed) resultMap.set(msgData.id, parsed);
      }
    } catch {
      // parse error, skip
    }
  }

  // Retry rate-limited messages: only retry if a small number failed (not mass rate limiting)
  if (rateLimitedIds.length > 0 && rateLimitedIds.length <= messageIds.length * 0.5) {
    await sleep(2000);
    for (const id of rateLimitedIds) {
      try {
        const singleRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (singleRes.ok) {
          const msgData = (await singleRes.json()) as GmailMessageResponse;
          if (msgData.id && msgData.payload) {
            const parsed = parseGmailMessage(msgData);
            if (parsed) resultMap.set(msgData.id, parsed);
          }
        }
      } catch {
        // skip individual failures
      }
    }
  }

  // Return results in original order
  return messageIds.map((id) => resultMap.get(id) || null);
}

/**
 * From metadata, determine which message IDs involve contacts the user has sent to.
 * Returns the set of needed message IDs for full content fetch.
 */
function identifyNeededMessageIds(metadata: EmailMetadata[], userEmail: string): Set<string> {
  // Build userEmailSet with import detection
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);
  for (const e of metadata) {
    if (e.isSent) userEmailSet.add(e.from);
  }

  // Detect imported accounts (same dominance logic as transformEmailsToContacts)
  let foundNew = true;
  while (foundNew) {
    foundNew = false;
    const fromCounts = new Map<string, number>();
    const toCounts = new Map<string, number>();
    for (const e of metadata) {
      const allRecipients = [...e.to, ...e.cc];
      if (userEmailSet.has(e.from) || allRecipients.some((r) => userEmailSet.has(r))) continue;
      fromCounts.set(e.from, (fromCounts.get(e.from) || 0) + 1);
      for (const r of allRecipients) toCounts.set(r, (toCounts.get(r) || 0) + 1);
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
        console.log(
          `[Gmail] Detected imported account: ${topAddr} (from=${topCount}, next=${secondCount})`
        );
      }
    }
  }

  // Count sentCount per contact
  const contactSentCount = new Map<string, number>();
  for (const e of metadata) {
    const isFromMe = e.isSent || userEmailSet.has(e.from);
    if (isFromMe) {
      for (const r of [...e.to, ...e.cc]) {
        if (!userEmailSet.has(r)) {
          contactSentCount.set(r, (contactSentCount.get(r) || 0) + 1);
        }
      }
    }
  }

  // Contacts with sentCount > 0
  const validContacts = new Set(
    [...contactSentCount.entries()].filter(([, c]) => c > 0).map(([e]) => e)
  );

  console.log(
    `[Gmail] Contact filter: ${validContacts.size} contacts with sentCount > 0, userEmailSet=${JSON.stringify([...userEmailSet])}`
  );

  // Collect message IDs that involve valid contacts
  const neededIds = new Set<string>();
  for (const e of metadata) {
    const isFromMe = e.isSent || userEmailSet.has(e.from);
    const contactEmails = isFromMe
      ? [...e.to, ...e.cc].filter((addr) => !userEmailSet.has(addr))
      : [e.from];
    if (contactEmails.some((ce) => validContacts.has(ce))) {
      neededIds.add(e.id);
    }
  }

  return neededIds;
}

/**
 * Fetch ALL emails from Gmail API using two-phase approach:
 * Phase 1: Fetch metadata (headers + labels) for all messages — fast, small responses
 * Phase 2: Fetch full content only for messages involving contacts user has sent to
 */
export async function fetchGmailEmails(
  accessToken: string,
  userEmail: string
): Promise<ParsedEmail[]> {
  let pageToken: string | undefined;
  let pageCount = 0;

  console.log(`[Gmail] Starting to fetch all emails...`);

  // List all message IDs
  const allMessageIds: string[] = [];

  do {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('maxResults', '500');
    if (pageToken) {
      listUrl.searchParams.set('pageToken', pageToken);
    }

    const listResponse = await fetchWithRetry(listUrl.toString(), accessToken);

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error(
        `[Gmail] Failed to list messages: ${listResponse.status} - ${logTruncate(errorText)}`
      );
      throw new Error(`Gmail API error: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as GmailMessageListResponse;

    if (listData.messages) {
      allMessageIds.push(...listData.messages.map((m) => m.id));
    }

    pageToken = listData.nextPageToken;
    pageCount++;

    if (pageCount % 10 === 0) {
      console.log(`[Gmail] Listed ${allMessageIds.length} message IDs (page ${pageCount})...`);
    }
  } while (pageToken);

  console.log(`[Gmail] Total ${allMessageIds.length} message IDs listed`);

  // Phase 1: Fetch metadata for all messages using concurrent individual requests
  console.log(`[Gmail] Phase 1: Fetching metadata for ${allMessageIds.length} messages...`);
  const allMetadata: EmailMetadata[] = [];
  const CONCURRENCY = 20;
  let completed = 0;
  let rateLimited = 0;
  let rateLimitedIds: string[] = [];

  for (let i = 0; i < allMessageIds.length; i += CONCURRENCY) {
    const chunk = allMessageIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          const response = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (response.status === 429) {
            rateLimited++;
            return { rateLimited: true, id } as const;
          }
          if (!response.ok) return null;
          const msg = (await response.json()) as GmailMessageResponse;
          if (!msg.id || !msg.payload) return null;
          const headers = msg.payload.headers || [];
          const getHeader = (name: string) =>
            headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
          const from = extractEmailAddress(getHeader('From'));
          if (!from) return null;
          return {
            id: msg.id,
            from,
            to: extractEmailAddresses(getHeader('To')),
            cc: extractEmailAddresses(getHeader('Cc')),
            isSent: (msg.labelIds || []).includes('SENT'),
          } as EmailMetadata;
        } catch {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r && 'rateLimited' in r) {
        rateLimitedIds.push(r.id);
      } else if (r) {
        allMetadata.push(r);
      }
    }
    completed += chunk.length;

    if (completed % 5000 === 0 || completed >= allMessageIds.length) {
      console.log(
        `[Gmail] Metadata: ${completed}/${allMessageIds.length} (${allMetadata.length} valid, ${rateLimited} rate-limited)`
      );
    }

    // Back off if we're getting rate limited
    if (rateLimited > completed * 0.1) {
      await sleep(2000);
    } else {
      await sleep(50);
    }
  }

  // Retry rate-limited messages with exponential backoff
  if (rateLimitedIds.length > 0) {
    console.log(`[Gmail] Retrying ${rateLimitedIds.length} rate-limited messages...`);
    for (let attempt = 0; attempt < 3 && rateLimitedIds.length > 0; attempt++) {
      await sleep(Math.pow(2, attempt) * 5000); // 5s, 10s, 20s
      const stillLimited: string[] = [];

      for (let i = 0; i < rateLimitedIds.length; i += CONCURRENCY) {
        const chunk = rateLimitedIds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          chunk.map(async (id) => {
            try {
              const response = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (response.status === 429) return { rateLimited: true, id } as const;
              if (!response.ok) return null;
              const msg = (await response.json()) as GmailMessageResponse;
              if (!msg.id || !msg.payload) return null;
              const headers = msg.payload.headers || [];
              const getHeader = (name: string) =>
                headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
              const from = extractEmailAddress(getHeader('From'));
              if (!from) return null;
              return {
                id: msg.id,
                from,
                to: extractEmailAddresses(getHeader('To')),
                cc: extractEmailAddresses(getHeader('Cc')),
                isSent: (msg.labelIds || []).includes('SENT'),
              } as EmailMetadata;
            } catch {
              return null;
            }
          })
        );
        for (const r of results) {
          if (r && 'rateLimited' in r) stillLimited.push(r.id);
          else if (r) allMetadata.push(r);
        }
        await sleep(200);
      }

      console.log(
        `[Gmail] Retry attempt ${attempt + 1}: recovered ${rateLimitedIds.length - stillLimited.length}, still limited: ${stillLimited.length}`
      );
      rateLimitedIds = stillLimited;
    }

    if (rateLimitedIds.length > 0) {
      console.warn(
        `[Gmail] ⚠️ ${rateLimitedIds.length} messages could not be fetched after retries`
      );
    }
  }

  console.log(
    `[Gmail] Phase 1 complete: ${allMetadata.length} metadata fetched (${rateLimitedIds.length} unrecoverable)`
  );

  // Phase 2: Identify which messages we actually need
  const neededIds = identifyNeededMessageIds(allMetadata, userEmail);
  console.log(`[Gmail] Phase 2: Need ${neededIds.size} messages with full content`);

  // Phase 3: Fetch full content for needed messages only
  if (neededIds.size === 0) return [];
  const fullEmails = await fetchMessagesByIds(accessToken, [...neededIds]);
  console.log(`[Gmail] Phase 3 complete: ${fullEmails.length} full emails fetched`);
  return fullEmails;
}

/**
 * Parse a Gmail API message response into our ParsedEmail format
 */
function parseGmailMessage(msg: GmailMessageResponse): ParsedEmail | null {
  try {
    const headers = msg.payload?.headers || [];

    const getHeader = (name: string): string | null => {
      const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
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

    const labels = msg.labelIds || [];
    const isSent = labels.includes('SENT');

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
      isSent,
      labels,
    };
  } catch (error) {
    console.error('[Gmail] Error parsing message:', error);
    return null;
  }
}

/**
 * Extract body text and HTML from Gmail message payload
 */
function extractBody(payload?: GmailMessageResponse['payload']): {
  text: string | null;
  html: string | null;
} {
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

function extractBodyFromParts(parts: GmailMessagePart[]): {
  text: string | null;
  html: string | null;
} {
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
  const contactMap = new Map<string, EmailContact>();

  // Build user email set using multiple signals:
  // 1. The connected email address
  // 2. "from" addresses on SENT-labeled emails (Gmail native sent)
  // 3. Imported emails: custom-label-only emails where "from" matches the user's name pattern
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);

  // Collect from SENT-labeled emails
  for (const email of emails) {
    if (email.isSent) {
      userEmailSet.add(email.from.toLowerCase());
    }
  }

  // Detect imported accounts: if an email is in the mailbox but neither the "from"
  // nor any "to"/"cc" contains a known user email, it was imported from another account.
  // The user's imported address will appear frequently in both "from" (sent) and "to"
  // (received) roles. External contacts may also appear in both roles (e.g. emailed you
  // AND was CC'd), but at much lower frequency.
  let foundNew = true;
  while (foundNew) {
    foundNew = false;
    const fromCounts = new Map<string, number>();
    const toCounts = new Map<string, number>();

    for (const email of emails) {
      const from = email.from.toLowerCase();
      const allRecipients = [...email.to, ...email.cc].map((e) => e.toLowerCase());

      // Skip emails that involve a known user address
      if (userEmailSet.has(from) || allRecipients.some((r) => userEmailSet.has(r))) continue;

      // This email involves no known user address — it's imported
      fromCounts.set(from, (fromCounts.get(from) || 0) + 1);
      for (const r of allRecipients) {
        toCounts.set(r, (toCounts.get(r) || 0) + 1);
      }
    }

    // The user's imported address dominates the orphan email pool.
    // Find the top sender by fromCount, and only accept it if:
    // 1. fromCount >= 20 (minimum volume)
    // 2. It also appears as a recipient (toCount >= 5)
    // 3. It sends at least 3x more than the next non-related candidate
    const candidates = [...fromCounts.entries()]
      .filter(([addr]) => (toCounts.get(addr) || 0) >= 5)
      .sort((a, b) => b[1] - a[1]);

    if (candidates.length > 0) {
      const [topAddr, topCount] = candidates[0];
      const secondCount = candidates.length > 1 ? candidates[1][1] : 0;
      if (topCount >= 20 && (secondCount === 0 || topCount >= secondCount * 3)) {
        userEmailSet.add(topAddr);
        foundNew = true;
        console.log(
          `[Gmail] Detected imported account: ${topAddr} (from=${topCount}, to=${toCounts.get(topAddr) || 0}, next=${secondCount})`
        );
      }
    }
  }

  console.log(
    `[Gmail] transformEmailsToContacts: ${emails.length} emails, userEmailSet=${JSON.stringify([...userEmailSet])}`
  );
  const fromMeCount = emails.filter(
    (e) => e.isSent || userEmailSet.has(e.from.toLowerCase())
  ).length;
  console.log(`[Gmail]   isFromMe total: ${fromMeCount}`);

  for (const email of emails) {
    const isFromMe = email.isSent || userEmailSet.has(email.from.toLowerCase());

    // Determine the contact email(s)
    let contactEmails: string[] = [];

    if (isFromMe) {
      // User sent this email - contacts are recipients (exclude user's own addresses)
      contactEmails = [...email.to, ...email.cc].filter((e) => !userEmailSet.has(e.toLowerCase()));
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
  const validContacts = Array.from(contactMap.values()).filter((c) => c.sentCount > 0);

  // Transform to ContactToUpsert format
  return validContacts.map((contact) => {
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
 * Import Gmail emails into the database using the shared manager.
 * Import detection in transformEmailsToContacts handles identifying imported accounts
 * and adding them to userEmailSet automatically.
 */
export async function parseGmailOAuthEmails(
  userId: string,
  userEmail: string,
  emails: ParsedEmail[],
  jobId: string
): Promise<{ contacts: number; messages: number }> {
  console.log(`[Job ${jobId}] Processing ${emails.length} Gmail emails for user ${userId}`);

  const contactsToUpsert = transformEmailsToContacts(emails, userEmail);
  console.log(
    `[Job ${jobId}] Found ${contactsToUpsert.length} valid contacts (sent at least one email)`
  );

  const result = await upsertPersonAndMessageRecords(userId, contactsToUpsert, jobId);

  console.log(
    `[Job ${jobId}] ✅ Gmail sync complete: ${result.contacts} contacts, ${result.messages} messages`
  );
  return result;
}

/**
 * Detect imported email accounts from parsed emails (without modifying userEmailSet).
 * Returns list of email addresses that appear to be imported user accounts.
 */
export function detectImportedAccounts(emails: ParsedEmail[], userEmail: string): string[] {
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);
  for (const email of emails) {
    if (email.isSent) userEmailSet.add(email.from.toLowerCase());
  }

  const imported: string[] = [];
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
        imported.push(topAddr);
        foundNew = true;
      }
    }
  }
  return imported;
}

/**
 * Search for emails matching a query and fetch their full content
 */
export async function searchAndFetchEmails(
  accessToken: string,
  query: string,
  maxResults: number = 500
): Promise<ParsedEmail[]> {
  const messageIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(Math.min(maxResults - messageIds.length, 500)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchWithRetry(url.toString(), accessToken);
    if (!res.ok) break;

    const data = (await res.json()) as GmailMessageListResponse;
    if (data.messages) messageIds.push(...data.messages.map((m) => m.id));
    pageToken = data.nextPageToken;
    if (messageIds.length >= maxResults) break;
  } while (pageToken);

  if (messageIds.length === 0) return [];

  console.log(`[Gmail] Fetching ${messageIds.length} messages for query "${query}"...`);
  return fetchMessagesByIds(accessToken, messageIds.slice(0, maxResults));
}
