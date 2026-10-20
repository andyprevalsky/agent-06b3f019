/**
 * Mailbox scan for a Gmail full sync: list every message id, then read each
 * message's routing metadata (From/To/Cc, SENT label, internalDate). The scan
 * is what lets a full sync decide, over the whole mailbox, which messages
 * involve contacts the user has written to (gmailParser.contacts.classifyMailbox).
 *
 *   list pages (500 ids) ──► metadata (20 concurrent) ──► onScanned(scanned, listed)
 *                                    │ 429
 *                                    └──► bounded retry (5 s, 10 s, 20 s)
 *
 * Uses the injected fetcher (global fetch by default) so blackbox suites fake
 * Google at the fetch boundary.
 */

import { createLogger } from '../../providers/logger';
import {
  type EmailMetadata,
  type GmailMessageListResponse,
  type GmailMessageResponse,
  extractEmailAddress,
  extractEmailAddresses,
} from './gmailParser.helpers';

const log = createLogger('GmailParser');

export type GmailFetcher = typeof fetch;

export const defaultGmailFetcher: GmailFetcher = (input, init) => globalThis.fetch(input, init);

const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const METADATA_CONCURRENCY = 20;
/** The scan reports progress at most once per this many scanned messages. */
const SCAN_REPORT_EVERY = 500;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Called as the scan advances: `scanned` metadata reads out of `listed` ids. */
export type ScanProgressHook = (scanned: number, listed: number) => Promise<void>;

type MetadataResult = EmailMetadata | { rateLimited: true; id: string } | null;

function metadataUrl(id: string): string {
  return `${GMAIL_MESSAGES_URL}/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`;
}

function toMetadata(msg: GmailMessageResponse): EmailMetadata | null {
  if (!msg.id || !msg.payload) return null;
  const headers = msg.payload.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const from = extractEmailAddress(getHeader('From'));
  if (!from) return null;
  const internalDate = Number.parseInt(msg.internalDate ?? '0', 10);
  return {
    id: msg.id,
    from,
    to: extractEmailAddresses(getHeader('To')),
    cc: extractEmailAddresses(getHeader('Cc')),
    isSent: (msg.labelIds || []).includes('SENT'),
    internalDate: Number.isFinite(internalDate) ? internalDate : 0,
  };
}

async function fetchMetadataOne(
  accessToken: string,
  id: string,
  fetcher: GmailFetcher
): Promise<MetadataResult> {
  try {
    const response = await fetcher(metadataUrl(id), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 429) return { rateLimited: true, id };
    if (!response.ok) return null;
    return toMetadata((await response.json()) as GmailMessageResponse);
  } catch {
    return null;
  }
}

/** Every message id in the mailbox, newest first (Gmail list order). */
export async function listAllMessageIds(
  fetchWithRetry: (url: string) => Promise<Response>
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    const listUrl = new URL(GMAIL_MESSAGES_URL);
    listUrl.searchParams.set('maxResults', '500');
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
    const listResponse = await fetchWithRetry(listUrl.toString());
    if (!listResponse.ok) {
      log.error('Failed to list messages', { status: listResponse.status });
      throw new Error(`Gmail API error: ${listResponse.status}`);
    }
    const listData = (await listResponse.json()) as GmailMessageListResponse;
    if (listData.messages) ids.push(...listData.messages.map((m) => m.id));
    pageToken = listData.nextPageToken;
    pageCount++;
    if (pageCount % 10 === 0) {
      log.info('Listed message IDs', { listed_count: ids.length, page: pageCount });
    }
  } while (pageToken);
  log.info('Total message IDs listed', { count: ids.length });
  return ids;
}

async function retryRateLimited(
  accessToken: string,
  ids: string[],
  fetcher: GmailFetcher,
  into: EmailMetadata[]
): Promise<string[]> {
  let pending = ids;
  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
    await sleep(Math.pow(2, attempt) * 5000); // 5s, 10s, 20s
    const stillLimited: string[] = [];
    for (let i = 0; i < pending.length; i += METADATA_CONCURRENCY) {
      const chunk = pending.slice(i, i + METADATA_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((id) => fetchMetadataOne(accessToken, id, fetcher))
      );
      for (const r of results) {
        if (r && 'rateLimited' in r) stillLimited.push(r.id);
        else if (r) into.push(r);
      }
      await sleep(200);
    }
    log.info('Retry attempt', {
      attempt: attempt + 1,
      recovered: pending.length - stillLimited.length,
      still_limited: stillLimited.length,
    });
    pending = stillLimited;
  }
  return pending;
}

/**
 * Routing metadata for `ids`. Reports progress every {@link SCAN_REPORT_EVERY}
 * messages and once at the end. Messages Google cannot return (deleted, or still
 * rate limited after the bounded retry) are left out and logged.
 */
export async function scanMessageMetadata(
  accessToken: string,
  ids: string[],
  fetcher: GmailFetcher,
  onScanned?: ScanProgressHook
): Promise<EmailMetadata[]> {
  log.info('Phase 1: fetching metadata', { message_count: ids.length });
  const metadata: EmailMetadata[] = [];
  let rateLimited = 0;
  const rateLimitedIds: string[] = [];
  let lastReported = 0;
  for (let i = 0; i < ids.length; i += METADATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + METADATA_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((id) => fetchMetadataOne(accessToken, id, fetcher))
    );
    for (const r of results) {
      if (r && 'rateLimited' in r) {
        rateLimited++;
        rateLimitedIds.push(r.id);
      } else if (r) {
        metadata.push(r);
      }
    }
    const completed = Math.min(i + chunk.length, ids.length);
    if (onScanned && completed - lastReported >= SCAN_REPORT_EVERY && completed < ids.length) {
      lastReported = completed;
      await onScanned(completed, ids.length);
    }
    // Back off while Google is rate limiting.
    await sleep(rateLimited > completed * 0.1 ? 2000 : 50);
  }
  let unrecoverable: string[] = [];
  if (rateLimitedIds.length > 0) {
    log.info('Retrying rate-limited messages', { count: rateLimitedIds.length });
    unrecoverable = await retryRateLimited(accessToken, rateLimitedIds, fetcher, metadata);
    if (unrecoverable.length > 0) {
      log.warn('Messages could not be fetched after retries', { count: unrecoverable.length });
    }
  }
  if (onScanned) await onScanned(ids.length, ids.length);
  log.info('Phase 1 complete', {
    metadata_fetched: metadata.length,
    unrecoverable: unrecoverable.length,
  });
  return metadata;
}
