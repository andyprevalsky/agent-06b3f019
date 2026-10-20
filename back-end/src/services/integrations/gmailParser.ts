import { createLogger } from '../../providers/logger';
import { upsertPersonAndMessageRecords } from './personMessageManager';
import {
  ParsedEmail,
  GmailMessageListResponse,
  GmailProfileResponse,
  GmailHistoryResponse,
  GmailMessageResponse,
  parseGmailMessage,
} from './gmailParser.helpers';
import { identifyNeededMessageIds, transformEmailsToContacts } from './gmailParser.contacts';
import {
  defaultGmailFetcher,
  listAllMessageIds,
  scanMessageMetadata,
  sleep,
  type GmailFetcher,
  type ScanProgressHook,
} from './gmailParser.scan';

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

export { detectImportedAccounts, classifyMailbox } from './gmailParser.contacts';
export type { MailboxClassification } from './gmailParser.contacts';
export { defaultGmailFetcher, listAllMessageIds, scanMessageMetadata };
export type { GmailFetcher, ScanProgressHook };

const log = createLogger('GmailParser');

export async function fetchWithRetry(
  url: string,
  accessToken: string,
  init?: RequestInit,
  fetcher: GmailFetcher = defaultGmailFetcher
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetcher(url, {
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
  return fetcher(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init?.headers },
  });
}

/**
 * Get Gmail profile including current historyId
 */
export async function getGmailProfile(
  accessToken: string,
  fetcher: GmailFetcher = defaultGmailFetcher
): Promise<GmailProfileResponse> {
  const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
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
  startHistoryId: string,
  fetcher: GmailFetcher = defaultGmailFetcher
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

    const response = await fetcher(url.toString(), {
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
 * Fetch specific messages by their IDs. Lenient: a failed batch is logged and
 * skipped (search and OTP lookups). Syncs use {@link fetchFullMessages}.
 */
export async function fetchMessagesByIds(
  accessToken: string,
  messageIds: string[],
  fetcher: GmailFetcher = defaultGmailFetcher
): Promise<ParsedEmail[]> {
  if (messageIds.length === 0) return [];

  const emails: ParsedEmail[] = [];
  const BATCH_SIZE = 100;

  log.info('Fetching messages by ID', { message_count: messageIds.length });

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);

    try {
      const { emails: found } = await fetchMessagesBatch(accessToken, batch, fetcher);
      emails.push(...batch.flatMap((id) => found.get(id) ?? []));
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

/** A sync batch Google did not fully answer; the caller keeps its cursor and retries later. */
export class GmailBatchIncompleteError extends Error {
  constructor(readonly unresolved: number) {
    super(`Gmail returned ${unresolved} message(s) of a batch only as transient errors`);
    this.name = 'GmailBatchIncompleteError';
  }
}

/**
 * Strict full-content fetch for at most 100 ids (one Gmail batch call), used
 * by syncs that advance a cursor after saving: an HTTP failure throws, and so
 * do messages still rate limited or 5xx after one retry. Messages Google no
 * longer has (404) are simply absent from the result.
 */
export async function fetchFullMessages(
  accessToken: string,
  messageIds: string[],
  fetcher: GmailFetcher = defaultGmailFetcher
): Promise<ParsedEmail[]> {
  if (messageIds.length === 0) return [];
  const { emails, unresolved } = await fetchMessagesBatch(accessToken, messageIds, fetcher);
  if (unresolved.length > 0) throw new GmailBatchIncompleteError(unresolved.length);
  return messageIds.flatMap((id) => emails.get(id) ?? []);
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

/** Sub-response statuses worth one more try: rate limiting and Google-side errors. */
const isTransient = (status: number) => status === 429 || status >= 500;

function parsePart(part: string): {
  status: number;
  msgId: string | undefined;
  email: ParsedEmail | null;
} {
  const statusMatch = part.match(/HTTP\/\d\.\d (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 0;
  const msgId = part.match(/Content-ID:\s*<response-([^>]+)>/i)?.[1];
  const jsonMatch = part.match(/\{[\s\S]*\}/);
  if (status !== 200 || !jsonMatch) return { status, msgId, email: null };
  try {
    const msgData = JSON.parse(jsonMatch[0]) as GmailMessageResponse;
    if (msgData.id && msgData.payload) {
      return { status, msgId: msgData.id, email: parseGmailMessage(msgData) };
    }
  } catch {
    // parse error, skip
  }
  return { status, msgId, email: null };
}

async function fetchOneFull(
  accessToken: string,
  id: string,
  fetcher: GmailFetcher
): Promise<{ email: ParsedEmail | null; transient: boolean }> {
  try {
    const singleRes = await fetcher(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!singleRes.ok) return { email: null, transient: isTransient(singleRes.status) };
    const msgData = (await singleRes.json()) as GmailMessageResponse;
    const email = msgData.id && msgData.payload ? parseGmailMessage(msgData) : null;
    return { email, transient: false };
  } catch {
    return { email: null, transient: true };
  }
}

/**
 * Fetch multiple messages using Gmail Batch API (up to 100 per request).
 * `unresolved` lists ids Google answered only with a transient error, even after
 * one individual retry.
 */
async function fetchMessagesBatch(
  accessToken: string,
  messageIds: string[],
  fetcher: GmailFetcher
): Promise<{ emails: Map<string, ParsedEmail>; unresolved: string[] }> {
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

  const response = await fetchWithRetry(
    'https://www.googleapis.com/batch/gmail/v1',
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body,
    },
    fetcher
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
    return { emails: new Map(), unresolved: [...messageIds] };
  }

  const emails = new Map<string, ParsedEmail>();
  const retryIds: string[] = [];
  const cleanBoundary = responseBoundary.replace(/^"(.*)"$/, '$1');
  for (const part of responseText.split(`--${cleanBoundary}`)) {
    if (!part.trim() || part.trim() === '--') continue;
    const parsed = parsePart(part);
    if (parsed.email && parsed.msgId) emails.set(parsed.msgId, parsed.email);
    else if (isTransient(parsed.status) && parsed.msgId) retryIds.push(parsed.msgId);
  }

  // Retry transient sub-responses individually, but not under mass rate limiting.
  if (retryIds.length > messageIds.length * 0.5) return { emails, unresolved: retryIds };
  if (retryIds.length > 0) await sleep(2000);
  const unresolved: string[] = [];
  for (const id of retryIds) {
    const single = await fetchOneFull(accessToken, id, fetcher);
    if (single.email) emails.set(id, single.email);
    else if (single.transient) unresolved.push(id);
  }
  return { emails, unresolved };
}

/**
 * Fetch ALL emails from Gmail API using two-phase approach:
 * Phase 1: Fetch metadata (headers + labels) for all messages — fast, small responses
 * Phase 2: Fetch full content only for messages involving contacts user has sent to
 *
 * Holds the whole result in memory. The background sync uses gmailFullSync,
 * which saves per batch; this stays for the operator re-import script.
 */
export async function fetchGmailEmails(
  accessToken: string,
  userEmail: string,
  fetcher: GmailFetcher = defaultGmailFetcher
): Promise<ParsedEmail[]> {
  log.info('Starting to fetch all emails');
  const ids = await listAllMessageIds((url) =>
    fetchWithRetry(url, accessToken, undefined, fetcher)
  );
  const allMetadata = await scanMessageMetadata(accessToken, ids, fetcher);

  // Phase 2: Identify which messages we actually need
  const neededIds = identifyNeededMessageIds(allMetadata, userEmail);
  log.info('Phase 2: needed messages identified', { needed_count: neededIds.size });

  // Phase 3: Fetch full content for needed messages only
  if (neededIds.size === 0) return [];
  const fullEmails = await fetchMessagesByIds(accessToken, [...neededIds], fetcher);
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
