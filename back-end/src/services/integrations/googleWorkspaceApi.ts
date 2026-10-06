/**
 * Read-only Google Calendar and Drive REST calls for the grep document sync.
 *
 * Uses the global `fetch` (never node-fetch) so blackbox outbound capture and
 * replay see every request. The caller supplies a fresh access token; nothing
 * here stores or logs it.
 */

import { createLogger } from '../../providers/logger';
import {
  DRIVE_MAX_CONTENT_CHARS,
  driveTextRequest,
  type CalendarWindow,
  type GoogleCalendarEvent,
  type GoogleDriveFile,
} from './googleWorkspaceDocuments';

const log = createLogger('GoogleWorkspaceApi');

export type Fetcher = typeof fetch;

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const CALENDAR_PAGE_SIZE = 2500;
const CALENDAR_MAX_PAGES = 8;
const DRIVE_PAGE_SIZE = 1000;
const DRIVE_CHANGES_MAX_PAGES = 5;
const RETRY_DELAYS_MS = [400, 1500];
/** A single Google request never holds a refresh or a search longer than this. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Drive also reports rate limiting as HTTP 403 with one of these reasons. */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const DRIVE_FILE_FIELDS =
  'id,name,mimeType,parents,modifiedTime,webViewLink,size,trashed,owners(emailAddress)';

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly api: string
  ) {
    super(`Google ${api} request failed with HTTP ${status}`);
    this.name = 'GoogleApiError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  try {
    const body = (await response.clone().json()) as {
      error?: { errors?: Array<{ reason?: string }> };
    };
    return (body.error?.errors ?? []).some(
      (detail) => detail.reason !== undefined && RATE_LIMIT_REASONS.has(detail.reason)
    );
  } catch {
    return false;
  }
}

/** GET with a short retry on rate limits, server errors and stalled requests. */
async function googleGet(
  url: string,
  token: string,
  api: string,
  fetcher: Fetcher
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        log.warn('Google API request did not complete', {
          api,
          error: error instanceof Error ? error.name : String(error),
        });
        throw new GoogleApiError(504, api);
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (response.ok) return response;
    const limited = await rateLimited(response);
    if (!(limited || response.status >= 500) || attempt >= RETRY_DELAYS_MS.length) {
      log.warn('Google API request failed', { api, status: response.status, limited });
      // A rate limit is reported as 429 whatever its HTTP status, so a caller
      // never mistakes it for a file Google refuses to export.
      throw new GoogleApiError(limited ? 429 : response.status, api);
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

export function calendarEventsUrl(window: CalendarWindow, pageToken?: string): string {
  const url = new URL(`${CALENDAR_BASE}/calendars/primary/events`);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(CALENDAR_PAGE_SIZE));
  url.searchParams.set('timeMin', window.timeMin);
  url.searchParams.set('timeMax', window.timeMax);
  if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

/** Every event instance on the primary calendar inside the window. */
export async function listCalendarEvents(
  token: string,
  window: CalendarWindow,
  fetcher: Fetcher = fetch
): Promise<GoogleCalendarEvent[]> {
  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < CALENDAR_MAX_PAGES; page += 1) {
    const response = await googleGet(
      calendarEventsUrl(window, pageToken),
      token,
      'calendar',
      fetcher
    );
    const body = (await response.json()) as {
      items?: GoogleCalendarEvent[];
      nextPageToken?: string;
    };
    events.push(...(body.items ?? []));
    pageToken = body.nextPageToken;
    if (pageToken === undefined) break;
  }
  return events;
}

export function driveFilesUrl(pageToken?: string): string {
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set('q', 'trashed = false');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('pageSize', String(DRIVE_PAGE_SIZE));
  url.searchParams.set('fields', `nextPageToken,files(${DRIVE_FILE_FIELDS})`);
  if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

/** Non-trashed files, most recently modified first, up to `maxFiles`. */
export async function listDriveFiles(
  token: string,
  maxFiles: number,
  fetcher: Fetcher = fetch
): Promise<{ files: GoogleDriveFile[]; truncated: boolean }> {
  const files: GoogleDriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const response = await googleGet(driveFilesUrl(pageToken), token, 'drive', fetcher);
    const body = (await response.json()) as { files?: GoogleDriveFile[]; nextPageToken?: string };
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken !== undefined && files.length < maxFiles);
  return { files: files.slice(0, maxFiles), truncated: pageToken !== undefined };
}

export function driveStartPageTokenUrl(): string {
  return `${DRIVE_BASE}/changes/startPageToken`;
}

export async function getDriveStartPageToken(
  token: string,
  fetcher: Fetcher = fetch
): Promise<string> {
  const response = await googleGet(driveStartPageTokenUrl(), token, 'drive', fetcher);
  const body = (await response.json()) as { startPageToken?: string };
  if (body.startPageToken === undefined) throw new GoogleApiError(502, 'drive');
  return body.startPageToken;
}

export function driveChangesUrl(pageToken: string): string {
  const url = new URL(`${DRIVE_BASE}/changes`);
  url.searchParams.set('pageToken', pageToken);
  url.searchParams.set('pageSize', String(DRIVE_PAGE_SIZE));
  url.searchParams.set('fields', 'nextPageToken,newStartPageToken,changes(fileId)');
  return url.toString();
}

/**
 * Whether anything changed since `pageToken`, and the token to resume from.
 * Only the fact of a change is used; the caller re-lists to rebuild paths.
 */
export async function driveChangedSince(
  token: string,
  pageToken: string,
  fetcher: Fetcher = fetch
): Promise<{ changed: boolean; nextPageToken: string }> {
  let cursor = pageToken;
  let changed = false;
  for (let page = 0; page < DRIVE_CHANGES_MAX_PAGES; page += 1) {
    const response = await googleGet(driveChangesUrl(cursor), token, 'drive', fetcher);
    const body = (await response.json()) as {
      changes?: Array<{ fileId?: string }>;
      nextPageToken?: string;
      newStartPageToken?: string;
    };
    if ((body.changes ?? []).length > 0) changed = true;
    if (body.newStartPageToken !== undefined) {
      return { changed, nextPageToken: body.newStartPageToken };
    }
    if (body.nextPageToken === undefined) break;
    cursor = body.nextPageToken;
  }
  return { changed: true, nextPageToken: cursor };
}

/** A file's text, or null when it has no text form or Google refuses the export. */
export async function fetchDriveText(
  token: string,
  file: GoogleDriveFile,
  fetcher: Fetcher = fetch
): Promise<{ text: string; truncated: boolean } | null> {
  const request = driveTextRequest(file);
  if (request === null) return null;
  try {
    const response = await googleGet(`${DRIVE_BASE}/${request.path}`, token, 'drive', fetcher);
    const text = await response.text();
    return {
      text: text.slice(0, DRIVE_MAX_CONTENT_CHARS),
      truncated: text.length > DRIVE_MAX_CONTENT_CHARS,
    };
  } catch (error) {
    // One unreadable file (too large to export, no download permission, gone)
    // must not fail the whole Drive refresh; it stays a name-and-path row. An
    // auth failure is not about the file, so it still fails the refresh.
    const fileSpecific = error instanceof GoogleApiError && [400, 403, 404].includes(error.status);
    if (fileSpecific) return null;
    throw error;
  }
}
