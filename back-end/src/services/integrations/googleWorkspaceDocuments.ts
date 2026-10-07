/**
 * Google Calendar events and Google Drive files as normalized documents.
 *
 * Pure mapping only: no network, no database. Each event or file becomes one
 * `UserDataDocument` row whose `metadata.path` is the folder-like address grep
 * prints (`<account>/<date>/<event>` or `<account>/<folders>/<file>`), so the
 * agent can list a folder or address one record by path.
 */

import { createHash } from 'node:crypto';

export const GOOGLE_CALENDAR_SOURCE = 'google_calendar';
export const GOOGLE_DRIVE_SOURCE = 'google_drive';
export type GoogleWorkspaceSource = typeof GOOGLE_CALENDAR_SOURCE | typeof GOOGLE_DRIVE_SOURCE;
export const GOOGLE_WORKSPACE_SOURCES: readonly GoogleWorkspaceSource[] = [
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_DRIVE_SOURCE,
];

/** Calendar rows cover roughly three months back and twelve months forward. */
export const CALENDAR_PAST_DAYS = 92;
export const CALENDAR_FUTURE_DAYS = 366;
/** Newest files first; a Drive larger than this is indexed up to the cap. */
export const DRIVE_MAX_FILES = 20_000;
/** Text is fetched up front only for this many most recently modified files. */
export const DRIVE_INITIAL_CONTENT_FILES = 300;
export const DRIVE_MAX_CONTENT_CHARS = 250_000;
export const DRIVE_MAX_DOWNLOAD_BYTES = 2_000_000;

const DAY_MS = 86_400_000;
const MAX_SEGMENT_CHARS = 120;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_SUFFIX: Record<string, string> = {
  'application/vnd.google-apps.document': '.gdoc',
  'application/vnd.google-apps.spreadsheet': '.gsheet',
  'application/vnd.google-apps.presentation': '.gslides',
};
const GOOGLE_NATIVE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};
const PLAIN_TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/x-yaml']);

export interface GoogleWorkspaceDocument {
  source: GoogleWorkspaceSource;
  googleAccountEmail: string;
  externalId: string;
  title: string;
  content: string;
  url?: string;
  metadata: Record<string, unknown>;
  sourceUpdatedAt?: Date;
  contentHash: string;
  /** Drive only: the stored text is still current, so the write must not replace it. */
  keepStoredContent?: boolean;
}

export interface GoogleCalendarEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  updated?: string;
  recurringEventId?: string;
  start?: GoogleCalendarEventTime;
  end?: GoogleCalendarEventTime;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
}

export interface GoogleDriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  trashed?: boolean;
  owners?: Array<{ emailAddress?: string }>;
}

export interface CalendarWindow {
  timeMin: string;
  timeMax: string;
}

/** Day-aligned window so repeated refreshes on one day request the same URL. */
export function calendarWindow(now: Date): CalendarWindow {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    timeMin: new Date(midnight - CALENDAR_PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(midnight + CALENDAR_FUTURE_DAYS * DAY_MS).toISOString(),
  };
}

/** One path segment: no slashes or control characters, bounded length. */
export function pathSegmentFor(value: string | undefined, fallback: string): string {
  const cleaned = [...(value ?? '')]
    .map((char) => ((char.codePointAt(0) ?? 0) < 0x20 || '/\\?#'.includes(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEGMENT_CHARS)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

export function textDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Changes exactly when what grep shows changes. The text enters through its
 * digest so a stored row can be compared without loading its content.
 */
export function documentHash(doc: {
  title: string;
  contentDigest: string;
  url?: string;
  metadata: Record<string, unknown>;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([doc.title, doc.contentDigest, doc.url ?? '', doc.metadata]))
    .digest('hex');
}

function eventInstant(time: GoogleCalendarEventTime): Date | null {
  const raw = time.dateTime ?? (time.date === undefined ? undefined : `${time.date}T00:00:00.000Z`);
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function eventWhenLine(event: GoogleCalendarEvent, allDay: boolean, lastDate: string): string {
  const start = event.start ?? {};
  const end = event.end ?? {};
  if (allDay) {
    const first = start.date ?? '';
    return lastDate === first ? `When: all day ${first}` : `When: all day ${first} to ${lastDate}`;
  }
  // Each time carries its own offset. The event's zone name is where it was
  // created; printed beside a different offset it reads as a contradiction.
  return `When: ${start.dateTime ?? ''} to ${end.dateTime ?? ''}`;
}

function eventContent(event: GoogleCalendarEvent, allDay: boolean, lastDate: string): string {
  const attendees = (event.attendees ?? [])
    .map((person) => {
      const who = person.email ?? person.displayName ?? '';
      return person.responseStatus === undefined ? who : `${who} (${person.responseStatus})`;
    })
    .filter((line) => line !== '');
  const organizer = event.organizer?.email ?? event.organizer?.displayName;
  return [
    eventWhenLine(event, allDay, lastDate),
    event.location === undefined ? null : `Where: ${event.location}`,
    organizer === undefined ? null : `Organizer: ${organizer}`,
    attendees.length === 0 ? null : `Attendees: ${attendees.join(', ')}`,
    event.hangoutLink === undefined ? null : `Meet: ${event.hangoutLink}`,
    event.status === undefined ? null : `Status: ${event.status}`,
    event.description === undefined || event.description === '' ? null : `\n${event.description}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Cancelled events and events without a start are not documents. */
export function calendarEventToDocument(
  event: GoogleCalendarEvent,
  accountEmail: string
): GoogleWorkspaceDocument | null {
  if (event.status === 'cancelled' || event.start === undefined) return null;
  const start = eventInstant(event.start);
  if (start === null) return null;
  const allDay = event.start.dateTime === undefined;
  const end = eventInstant(event.end ?? event.start) ?? start;
  const title = pathSegmentFor(event.summary, '(No title)');
  const dateFolder = (event.start.dateTime ?? event.start.date ?? '').slice(0, 10);
  // An all-day event's end date is exclusive; grep date filters are inclusive.
  const lastDate = allDay
    ? new Date(Math.max(start.getTime(), end.getTime() - DAY_MS)).toISOString().slice(0, 10)
    : (event.end?.dateTime ?? '').slice(0, 10) || dateFolder;
  const timeLabel = allDay ? 'all-day' : (event.start.dateTime ?? '').slice(11, 16);
  const metadata: Record<string, unknown> = {
    path: `${accountEmail}/${dateFolder}/${timeLabel} ${title}.event`,
    account: accountEmail,
    eventId: event.id,
    start: start.toISOString(),
    end: end.toISOString(),
    startDate: dateFolder,
    endDate: lastDate,
    allDay,
    ...(event.start.timeZone === undefined ? {} : { timeZone: event.start.timeZone }),
    ...(event.recurringEventId === undefined ? {} : { recurringEventId: event.recurringEventId }),
  };
  const doc = {
    title: event.summary === undefined || event.summary === '' ? '(No title)' : event.summary,
    content: eventContent(event, allDay, lastDate),
    url: event.htmlLink,
    metadata,
  };
  const updated = event.updated === undefined ? undefined : new Date(event.updated);
  return {
    source: GOOGLE_CALENDAR_SOURCE,
    googleAccountEmail: accountEmail,
    externalId: `${accountEmail}:${event.id}`,
    ...doc,
    sourceUpdatedAt: updated !== undefined && !Number.isNaN(updated.getTime()) ? updated : start,
    contentHash: documentHash({ ...doc, contentDigest: textDigest(doc.content) }),
  };
}

export function isDriveFolder(file: GoogleDriveFile): boolean {
  return file.mimeType === FOLDER_MIME;
}

/** The request that returns this file as text, or null when it has no text form. */
export function driveTextRequest(file: GoogleDriveFile): { path: string } | null {
  const mime = file.mimeType ?? '';
  const exportMime = GOOGLE_NATIVE_EXPORT[mime];
  if (exportMime !== undefined) {
    return { path: `files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}` };
  }
  const size = Number(file.size ?? '0');
  const textLike = mime.startsWith('text/') || PLAIN_TEXT_MIMES.has(mime);
  if (!textLike || !Number.isFinite(size) || size > DRIVE_MAX_DOWNLOAD_BYTES) return null;
  return { path: `files/${file.id}?alt=media` };
}

/**
 * Folder path per file id. A parent that is not in the listing is the Drive
 * root; a file with no parent was shared with the account.
 */
export function driveFolderPaths(files: GoogleDriveFile[]): Map<string, string> {
  const byId = new Map(files.map((file) => [file.id, file]));
  const cache = new Map<string, string>();
  const resolve = (file: GoogleDriveFile, depth: number): string => {
    const known = cache.get(file.id);
    if (known !== undefined) return known;
    const parentId = file.parents?.[0];
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    const base =
      parentId === undefined
        ? 'Shared with me'
        : parent === undefined || depth > 50
          ? 'My Drive'
          : `${resolve(parent, depth + 1)}/${pathSegmentFor(parent.name, parent.id)}`;
    cache.set(file.id, base);
    return base;
  };
  for (const file of files) resolve(file, 0);
  return cache;
}

/** Text state of a Drive row: freshly fetched, unchanged since last fetch, or not indexed. */
export type DriveContentState =
  | { kind: 'fetched'; text: string; truncated: boolean }
  | { kind: 'stored'; digest: string; truncated: boolean }
  | { kind: 'none' };

export function driveFileToDocument(params: {
  file: GoogleDriveFile;
  folderPath: string;
  accountEmail: string;
  content?: DriveContentState;
}): GoogleWorkspaceDocument {
  const { file, folderPath, accountEmail } = params;
  const content = params.content ?? { kind: 'none' };
  const mime = file.mimeType ?? '';
  const name = pathSegmentFor(file.name, file.id);
  const suffix = GOOGLE_NATIVE_SUFFIX[mime] ?? '';
  const owner = file.owners?.[0]?.emailAddress;
  const digest =
    content.kind === 'fetched'
      ? textDigest(content.text)
      : content.kind === 'stored'
        ? content.digest
        : textDigest('');
  const metadata: Record<string, unknown> = {
    path: `${accountEmail}/${folderPath}/${name}${suffix}`,
    account: accountEmail,
    fileId: file.id,
    mimeType: mime,
    kind: isDriveFolder(file) ? 'folder' : 'file',
    ...(file.modifiedTime === undefined ? {} : { modifiedTime: file.modifiedTime }),
    ...(file.size === undefined ? {} : { size: file.size }),
    ...(owner === undefined ? {} : { owner }),
    contentIndexed: content.kind !== 'none',
    ...(content.kind === 'none' ? {} : { contentDigest: digest }),
    ...(content.kind !== 'none' && content.truncated ? { contentTruncated: true } : {}),
  };
  const title = file.name === undefined || file.name === '' ? file.id : file.name;
  const modified = file.modifiedTime === undefined ? undefined : new Date(file.modifiedTime);
  return {
    source: GOOGLE_DRIVE_SOURCE,
    googleAccountEmail: accountEmail,
    externalId: `${accountEmail}:${file.id}`,
    title,
    content: content.kind === 'fetched' ? content.text : '',
    url: file.webViewLink,
    metadata,
    sourceUpdatedAt:
      modified !== undefined && !Number.isNaN(modified.getTime()) ? modified : undefined,
    contentHash: documentHash({ title, contentDigest: digest, url: file.webViewLink, metadata }),
    ...(content.kind === 'stored' ? { keepStoredContent: true } : {}),
  };
}
