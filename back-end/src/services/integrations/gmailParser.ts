// Use the platform fetch so the shared outbound capture/replay boundary owns Gmail HTTP.
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
import {
  GMAIL_UNITS,
  GmailQuotaPacer,
  gmailPacerForAccess,
  gmailToken,
  isGmailRateLimited,
  refreshGmailAccess,
  type GmailAccess,
} from './gmailQuota';

export type { GmailAccess, RefreshableGmailAccess } from './gmailQuota';

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

/** Attempts per request; rate-limit waits of 5+10+20+40s outlast Google's per-minute window. */
const MAX_ATTEMPTS = 5;

/**
 * One Gmail request: paced against the per-user quota (when a pacer is given),
 * retried on network errors, 5xx and rate limits (429 or 403 rateLimitExceeded),
 * and retried once with a fresh token on 401 when the access can refresh.
 * Returns the final response; callers decide what a non-OK status means.
 */
async function fetchWithRetry(
  url: string,
  access: GmailAccess,
  init?: RequestInit,
  quota?: { pacer: GmailQuotaPacer; units: number }
): Promise<Response> {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS - 1;
    if (quota) await quota.pacer.take(quota.units);
    const token = gmailToken(access);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init?.headers },
      });
    } catch (err) {
      if (last) throw err;
      // Network error (DNS, timeout, connection reset) — retryable
      const wait = Math.pow(2, attempt) * 2;
      log.warn('Network error, retrying', {
        wait_seconds: wait,
        attempt: attempt + 1,
        max_attempts: MAX_ATTEMPTS,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(wait * 1000);
      continue;
    }
    if (last) return response;
    if (response.status === 401 && !refreshed && (await refreshGmailAccess(access, token))) {
      refreshed = true;
      log.info('Access token rejected, retrying with a refreshed token', {
        attempt: attempt + 1,
      });
      continue;
    }
    if (
      (response.status === 429 || response.status === 403) &&
      isGmailRateLimited(response.status, await response.clone().text())
    ) {
      // Retry-After may be seconds or an HTTP date; anything unparsable backs off.
      const retryAfter = Number(response.headers.get('Retry-After') ?? NaN);
      const wait = Number.isFinite(retryAfter)
        ? Math.min(Math.max(retryAfter, 0), 60)
        : Math.pow(2, attempt) * 5;
      log.info('Rate limited, waiting', {
        status: response.status,
        wait_seconds: wait,
        attempt: attempt + 1,
        max_attempts: MAX_ATTEMPTS,
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
        max_attempts: MAX_ATTEMPTS,
      });
      await sleep(wait * 1000);
      continue;
    }
    return response;
  }
}

/**
 * Get Gmail profile including current historyId
 */
export async function getGmailProfile(accessToken: GmailAccess): Promise<GmailProfileResponse> {
  const response = await fetchWithRetry(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    accessToken
  );

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
  accessToken: GmailAccess,
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

    const response = await fetchWithRetry(url.toString(), accessToken);

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
  accessToken: GmailAccess,
  messageIds: string[],
  pacer: GmailQuotaPacer = gmailPacerForAccess(accessToken)
): Promise<ParsedEmail[]> {
  if (messageIds.length === 0) return [];

  const emails: ParsedEmail[] = [];
  const BATCH_SIZE = 100;

  log.info('Fetching messages by ID', { message_count: messageIds.length });

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    // A batch that cannot be fetched fails the caller: a sync that saved its
    // historyId past unfetched messages would never see them again.
    const batchResults = await fetchMessagesBatch(accessToken, batch, pacer);
    emails.push(...batchResults.filter((e): e is ParsedEmail => e !== null));
  }

  log.info('Successfully fetched messages', { count: emails.length });
  return emails;
}

/**
 * Fetch emails since a given timestamp using Gmail's search query
 * Returns all emails (no filtering by contact) - useful for OTPs and notifications
 */
export async function fetchGmailMessagesSince(
  accessToken: GmailAccess,
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
 * GET one message, paced and retried. Returns null when Google says it no
 * longer exists (deleted between list and get); throws on anything else.
 */
async function fetchMessage(
  accessToken: GmailAccess,
  id: string,
  format: 'full' | 'metadata',
  pacer: GmailQuotaPacer
): Promise<GmailMessageResponse | null> {
  const query =
    format === 'full'
      ? 'format=full'
      : 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc';
  const response = await fetchWithRetry(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${query}`,
    accessToken,
    undefined,
    { pacer, units: GMAIL_UNITS.messagesGet }
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    log.error('Failed to fetch message', { status: response.status, format });
    throw new Error(`Gmail API error: ${response.status}`);
  }
  return (await response.json()) as GmailMessageResponse;
}

/**
 * Fetch multiple messages using Gmail Batch API (up to 100 per request).
 * Sub-requests Google rejected transiently (rate limit, 5xx) are re-fetched
 * one at a time through the paced, retrying single GET.
 */
async function fetchMessagesBatch(
  accessToken: GmailAccess,
  messageIds: string[],
  pacer: GmailQuotaPacer
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

  // Every sub-request is metered as its own messages.get.
  const response = await fetchWithRetry(
    'https://www.googleapis.com/batch/gmail/v1',
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body,
    },
    { pacer, units: GMAIL_UNITS.messagesGet * messageIds.length }
  );

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
    throw new Error('Gmail batch API error: response has no multipart boundary');
  }

  const resultMap = new Map<string, ParsedEmail>();
  const retryIds: string[] = [];
  const cleanBoundary = responseBoundary.replace(/^"(.*)"$/, '$1');
  const responseParts = responseText.split(`--${cleanBoundary}`);

  for (const part of responseParts) {
    if (!part.trim() || part.trim() === '--') continue;

    const statusMatch = part.match(/HTTP\/\d\.\d (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;

    // Extract message ID from Content-ID header
    const contentIdMatch = part.match(/Content-ID:\s*<response-([^>]+)>/i);
    const msgId = contentIdMatch?.[1];

    const jsonMatch = part.match(/\{[\s\S]*\}/);
    if (msgId && (status >= 500 || isGmailRateLimited(status, jsonMatch?.[0] ?? ''))) {
      retryIds.push(msgId);
      continue;
    }
    if (status === 404) continue; // deleted between list and get
    if (status !== 200 || !jsonMatch) {
      log.error('Batch sub-request failed', { status });
      throw new Error(`Gmail batch sub-request error: ${status}`);
    }

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

  if (retryIds.length > 0) {
    log.info('Retrying batch sub-requests one at a time', { count: retryIds.length });
    for (const id of retryIds) {
      const msgData = await fetchMessage(accessToken, id, 'full', pacer);
      if (msgData?.id && msgData.payload) {
        const parsed = parseGmailMessage(msgData);
        if (parsed) resultMap.set(msgData.id, parsed);
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
  accessToken: GmailAccess,
  userEmail: string
): Promise<ParsedEmail[]> {
  let pageToken: string | undefined;
  let pageCount = 0;
  // The mailbox's shared budget: list, metadata and full-content requests.
  const pacer = gmailPacerForAccess(accessToken);

  log.info('Starting to fetch all emails');

  // List all message IDs
  const allMessageIds: string[] = [];

  do {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('maxResults', '500');
    if (pageToken) {
      listUrl.searchParams.set('pageToken', pageToken);
    }

    const listResponse = await fetchWithRetry(listUrl.toString(), accessToken, undefined, {
      pacer,
      units: GMAIL_UNITS.messagesList,
    });

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

  // Phase 1: Fetch metadata for all messages. Requests run CONCURRENCY at a
  // time but start no faster than the per-user quota allows (see gmailQuota.ts).
  log.info('Phase 1: fetching metadata', { message_count: allMessageIds.length });
  const allMetadata: EmailMetadata[] = [];
  const CONCURRENCY = 20;
  let completed = 0;

  for (let i = 0; i < allMessageIds.length; i += CONCURRENCY) {
    const chunk = allMessageIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (id) => {
        const msg = await fetchMessage(accessToken, id, 'metadata', pacer);
        if (!msg?.id || !msg.payload) return null;
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
      })
    );

    for (const r of results) if (r) allMetadata.push(r);
    completed += chunk.length;

    if (completed % 5000 === 0 || completed >= allMessageIds.length) {
      log.info('Metadata progress', {
        completed,
        total: allMessageIds.length,
        valid: allMetadata.length,
      });
    }
  }

  log.info('Phase 1 complete', { metadata_fetched: allMetadata.length });

  // Phase 2: Identify which messages we actually need
  const neededIds = identifyNeededMessageIds(allMetadata, userEmail);
  log.info('Phase 2: needed messages identified', { needed_count: neededIds.size });

  // Phase 3: Fetch full content for needed messages only
  if (neededIds.size === 0) return [];
  const fullEmails = await fetchMessagesByIds(accessToken, [...neededIds], pacer);
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
