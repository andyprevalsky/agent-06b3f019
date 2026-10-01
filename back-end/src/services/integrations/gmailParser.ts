import fetch, { RequestInit, Response } from 'node-fetch';
import { createLogger } from '../../providers/logger';
import { upsertPersonAndMessageRecords } from './personMessageManager';
import {
  ParsedEmail,
  GmailMessageListResponse,
  GmailProfileResponse,
  GmailHistoryResponse,
  GmailMessageResponse,
  EmailMetadata,
  parseGmailMessage,
  extractEmailAddress,
  extractEmailAddresses,
} from './gmailParser.helpers';
import { identifyNeededMessageIds, transformEmailsToContacts } from './gmailParser.contacts';

export type {
  ParsedEmail,
  GmailMessageListResponse,
  GmailProfileResponse,
  GmailHistoryResponse,
  GmailMessageResponse,
  GmailMessagePart,
  EmailContact,
  EmailMetadata,
} from './gmailParser.helpers';

export { detectImportedAccounts } from './gmailParser.contacts';

const log = createLogger('GmailParser');

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
      log.warn('Network error, retrying', {
        wait_seconds: wait,
        attempt: attempt + 1,
        max_attempts: 3,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(wait * 1000);
      continue;
    }
    if (
      response.status === 429 ||
      (response.status === 403 && (await response.clone().text()).includes('rateLimitExceeded'))
    ) {
      const retryAfter = response.headers.get('Retry-After');
      const wait = retryAfter ? Math.min(parseInt(retryAfter), 60) : Math.pow(2, attempt) * 5;
      log.info('Rate limited, waiting', {
        status: response.status,
        wait_seconds: wait,
        attempt: attempt + 1,
        max_attempts: 3,
      });
      await sleep(wait * 1000);
      continue;
    }
    if (response.status >= 500) {
      const wait = Math.pow(2, attempt) * 2;
      log.warn('Server error, retrying', {
        status: response.status,
        wait_seconds: wait,
        attempt: attempt + 1,
        max_attempts: 3,
      });
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
    log.error('Failed to get profile', {
      status: response.status,
    });
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

  log.info('Fetching history');

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
      // 404 means historyId is too old or invalid - need full sync
      if (response.status === 404) {
        log.info('History expired, full sync required');
        return { addedMessageIds: [], newHistoryId: '' };
      }
      log.error('Failed to fetch history', {
        status: response.status,
      });
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

  log.info('History fetch complete', {
    new_messages: addedMessageIds.length,
  });
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

  log.info('Fetching messages by ID', { message_count: messageIds.length });

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);

    try {
      const batchResults = await fetchMessagesBatch(accessToken, batch);
      const validEmails = batchResults.filter((e): e is ParsedEmail => e !== null);
      emails.push(...validEmails);
    } catch (error) {
      log.error('Batch request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Small delay between batches
    if (i + BATCH_SIZE < messageIds.length) {
      await sleep(100);
    }
  }

  log.info('Successfully fetched messages', { count: emails.length });
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

  log.info('Fetching messages since', { since: since.toISOString() });

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
      log.error('Failed to list messages', {
        status: listResponse.status,
      });
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

  log.info('Found messages since', {
    count: messageIds.length,
    since: since.toISOString(),
  });

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
    log.error('Batch request failed', {
      status: response.status,
    });
    throw new Error(`Gmail batch API error: ${response.status}`);
  }

  // Parse multipart response
  const responseText = await response.text();
  const responseBoundary = response.headers.get('content-type')?.match(/boundary=(.+)/)?.[1];

  if (!responseBoundary) {
    log.error('Could not find boundary in batch response');
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

  log.info('Starting to fetch all emails');

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
      log.error('Failed to list messages', {
        status: listResponse.status,
      });
      throw new Error(`Gmail API error: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as GmailMessageListResponse;

    if (listData.messages) {
      allMessageIds.push(...listData.messages.map((m) => m.id));
    }

    pageToken = listData.nextPageToken;
    pageCount++;

    if (pageCount % 10 === 0) {
      log.info('Listed message IDs', {
        listed_count: allMessageIds.length,
        page: pageCount,
      });
    }
  } while (pageToken);

  log.info('Total message IDs listed', { count: allMessageIds.length });

  // Phase 1: Fetch metadata for all messages using concurrent individual requests
  log.info('Phase 1: fetching metadata', { message_count: allMessageIds.length });
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
      log.info('Metadata progress', {
        completed,
        total: allMessageIds.length,
        valid: allMetadata.length,
        rate_limited: rateLimited,
      });
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
    log.info('Retrying rate-limited messages', { count: rateLimitedIds.length });
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

      log.info('Retry attempt', {
        attempt: attempt + 1,
        recovered: rateLimitedIds.length - stillLimited.length,
        still_limited: stillLimited.length,
      });
      rateLimitedIds = stillLimited;
    }

    if (rateLimitedIds.length > 0) {
      log.warn('Messages could not be fetched after retries', {
        count: rateLimitedIds.length,
      });
    }
  }

  log.info('Phase 1 complete', {
    metadata_fetched: allMetadata.length,
    unrecoverable: rateLimitedIds.length,
  });

  // Phase 2: Identify which messages we actually need
  const neededIds = identifyNeededMessageIds(allMetadata, userEmail);
  log.info('Phase 2: needed messages identified', { needed_count: neededIds.size });

  // Phase 3: Fetch full content for needed messages only
  if (neededIds.size === 0) return [];
  const fullEmails = await fetchMessagesByIds(accessToken, [...neededIds]);
  log.info('Phase 3 complete', { full_emails_fetched: fullEmails.length });
  return fullEmails;
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
  jobId: string,
  credentialId: string
): Promise<{ contacts: number; messages: number }> {
  log.info('Processing Gmail emails', {
    job_id: jobId,
    email_count: emails.length,
    user_id: userId,
  });

  const contactsToUpsert = transformEmailsToContacts(emails, userEmail);
  log.info('Found valid contacts', {
    job_id: jobId,
    contact_count: contactsToUpsert.length,
  });

  const result = await upsertPersonAndMessageRecords(
    userId,
    contactsToUpsert,
    jobId,
    userEmail,
    credentialId
  );

  log.info('Gmail sync complete', {
    job_id: jobId,
    contacts: result.contacts,
    messages: result.messages,
  });
  return result;
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

  log.info('Fetching messages for query', { count: messageIds.length });
  return fetchMessagesByIds(accessToken, messageIds.slice(0, maxResults));
}
