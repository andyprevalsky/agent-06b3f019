#!/usr/bin/env tsx
/**
 * Google Calendar events and Drive files become grep documents whose
 * `metadata.path` is the folder-like address the agent sees. These are the
 * rules that address is built from, so a change here changes what an agent can
 * list or open by path.
 */

import assert from 'node:assert/strict';
import {
  CALENDAR_FUTURE_DAYS,
  CALENDAR_PAST_DAYS,
  DRIVE_MAX_DOWNLOAD_BYTES,
  calendarEventToDocument,
  calendarWindow,
  driveFileToDocument,
  driveFolderPaths,
  driveTextRequest,
  pathSegmentFor,
  type GoogleCalendarEvent,
  type GoogleDriveFile,
} from '../../services/integrations/googleWorkspaceDocuments';

const ACCOUNT = 'reviewer@example.com';
const DAY_MS = 86_400_000;
let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n`);
    throw error;
  }
}

const PROJECT_SYNC: GoogleCalendarEvent = {
  id: 'evt1',
  status: 'confirmed',
  summary: 'Project Sync',
  description: 'Agenda: launch checklist',
  location: 'Room 4',
  htmlLink: 'https://www.google.com/calendar/event?eid=evt1',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  updated: '2026-09-30T18:00:00.000Z',
  start: { dateTime: '2026-10-02T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-10-02T10:30:00-07:00', timeZone: 'America/Los_Angeles' },
  organizer: { email: 'sam@example.com' },
  attendees: [
    { email: 'sam@example.com', responseStatus: 'accepted' },
    { email: ACCOUNT, responseStatus: 'needsAction' },
  ],
};

test('calendar window is day aligned and covers the documented range', () => {
  const morning = calendarWindow(new Date('2026-10-05T03:15:00.000Z'));
  const evening = calendarWindow(new Date('2026-10-05T23:59:00.000Z'));
  assert.deepEqual(morning, evening, 'two refreshes on one day must ask Google the same URL');
  const span = Date.parse(morning.timeMax) - Date.parse(morning.timeMin);
  assert.equal(span, (CALENDAR_PAST_DAYS + CALENDAR_FUTURE_DAYS) * DAY_MS);
  assert.equal(morning.timeMin.slice(11), '00:00:00.000Z');
});

test('a timed event becomes one document under its account and local date', () => {
  const doc = calendarEventToDocument(PROJECT_SYNC, ACCOUNT);
  assert.ok(doc !== null);
  assert.equal(doc.source, 'google_calendar');
  assert.equal(doc.googleAccountEmail, ACCOUNT);
  assert.equal(doc.externalId, `${ACCOUNT}:evt1`);
  assert.equal(doc.title, 'Project Sync');
  assert.equal(doc.metadata.path, `${ACCOUNT}/2026-10-02/10:00 Project Sync.event`);
  assert.equal(doc.metadata.start, '2026-10-02T17:00:00.000Z');
  assert.equal(doc.metadata.end, '2026-10-02T17:30:00.000Z');
  assert.equal(doc.metadata.allDay, false);
  assert.equal(doc.metadata.startDate, '2026-10-02');
  assert.equal(doc.metadata.endDate, '2026-10-02');
  assert.equal(doc.url, PROJECT_SYNC.htmlLink);
  // The zone an event was created in is kept as metadata, never printed beside
  // times that already carry the calendar's own offset.
  assert.equal(doc.metadata.timeZone, 'America/Los_Angeles');
  assert.ok(!doc.content.includes('America/Los_Angeles'));
  for (const expected of [
    'When: 2026-10-02T10:00:00-07:00 to 2026-10-02T10:30:00-07:00',
    'Where: Room 4',
    'Organizer: sam@example.com',
    `Attendees: sam@example.com (accepted), ${ACCOUNT} (needsAction)`,
    'Meet: https://meet.google.com/abc-defg-hij',
    'Agenda: launch checklist',
  ]) {
    assert.ok(doc.content.includes(expected), `content is missing "${expected}"`);
  }
});

test('all-day, untitled and cancelled events', () => {
  const allDay = calendarEventToDocument(
    { id: 'evt2', start: { date: '2026-10-09' }, end: { date: '2026-10-10' } },
    ACCOUNT
  );
  assert.ok(allDay !== null);
  assert.equal(allDay.title, '(No title)');
  assert.equal(allDay.metadata.path, `${ACCOUNT}/2026-10-09/all-day (No title).event`);
  assert.equal(allDay.metadata.allDay, true);
  assert.equal(allDay.metadata.start, '2026-10-09T00:00:00.000Z');
  assert.equal(allDay.metadata.end, '2026-10-10T00:00:00.000Z');
  // Google's all-day end date is exclusive; the stored last date is inclusive.
  assert.equal(allDay.metadata.startDate, '2026-10-09');
  assert.equal(allDay.metadata.endDate, '2026-10-09');
  const threeDays = calendarEventToDocument(
    { id: 'evt4', summary: 'Offsite', start: { date: '2026-10-12' }, end: { date: '2026-10-15' } },
    ACCOUNT
  );
  assert.equal(threeDays?.metadata.endDate, '2026-10-14');
  assert.ok(threeDays?.content.includes('When: all day 2026-10-12 to 2026-10-14'));
  assert.ok(allDay.content.includes('When: all day 2026-10-09'));
  assert.ok(!allDay.content.includes(' to '), 'a one-day event names one date');

  assert.equal(calendarEventToDocument({ ...PROJECT_SYNC, status: 'cancelled' }, ACCOUNT), null);
  assert.equal(calendarEventToDocument({ id: 'evt3' }, ACCOUNT), null);
});

test('path segments never contain separators', () => {
  assert.equal(pathSegmentFor('Q3/Q4 plan? #final', 'x'), 'Q3 Q4 plan final');
  assert.equal(pathSegmentFor('   ', 'fallback'), 'fallback');
  const doc = calendarEventToDocument({ ...PROJECT_SYNC, summary: '1/1 with Alex' }, ACCOUNT);
  assert.equal(doc?.metadata.path, `${ACCOUNT}/2026-10-02/10:00 1 1 with Alex.event`);
});

test('the hash changes exactly when what grep shows changes', () => {
  const first = calendarEventToDocument(PROJECT_SYNC, ACCOUNT);
  const same = calendarEventToDocument(
    { ...PROJECT_SYNC, updated: '2026-10-01T00:00:00Z' },
    ACCOUNT
  );
  const moved = calendarEventToDocument(
    { ...PROJECT_SYNC, start: { dateTime: '2026-10-02T11:00:00-07:00' } },
    ACCOUNT
  );
  assert.equal(first?.contentHash, same?.contentHash);
  assert.notEqual(first?.contentHash, moved?.contentHash);
});

const DRIVE_FILES: GoogleDriveFile[] = [
  { id: 'legal', name: 'Legal', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
  { id: 'y2026', name: '2026', mimeType: 'application/vnd.google-apps.folder', parents: ['legal'] },
  {
    id: 'lease',
    name: 'Lease',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['y2026'],
    modifiedTime: '2026-09-20T12:00:00.000Z',
    webViewLink: 'https://docs.google.com/document/d/lease/edit',
    owners: [{ emailAddress: ACCOUNT }],
  },
  { id: 'notes', name: 'notes.txt', mimeType: 'text/plain', parents: ['root'], size: '120' },
  { id: 'shared', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
];

test('folder paths follow parents, with root and shared files named', () => {
  const paths = driveFolderPaths(DRIVE_FILES);
  assert.equal(paths.get('legal'), 'My Drive');
  assert.equal(paths.get('y2026'), 'My Drive/Legal');
  assert.equal(paths.get('lease'), 'My Drive/Legal/2026');
  assert.equal(paths.get('notes'), 'My Drive');
  assert.equal(paths.get('shared'), 'Shared with me');
});

test('a parent cycle cannot hang path building', () => {
  const paths = driveFolderPaths([
    { id: 'a', name: 'A', mimeType: 'application/vnd.google-apps.folder', parents: ['b'] },
    { id: 'b', name: 'B', mimeType: 'application/vnd.google-apps.folder', parents: ['a'] },
  ]);
  assert.ok(paths.get('a')?.startsWith('My Drive'));
});

test('a Drive file becomes one document addressed by folder path', () => {
  const lease = DRIVE_FILES[2];
  const bare = driveFileToDocument({
    file: lease,
    folderPath: 'My Drive/Legal/2026',
    accountEmail: ACCOUNT,
  });
  assert.equal(bare.source, 'google_drive');
  assert.equal(bare.externalId, `${ACCOUNT}:lease`);
  assert.equal(bare.metadata.path, `${ACCOUNT}/My Drive/Legal/2026/Lease.gdoc`);
  assert.equal(bare.metadata.contentIndexed, false);
  assert.equal(bare.content, '');
  assert.equal(bare.metadata.owner, ACCOUNT);

  const indexed = driveFileToDocument({
    file: lease,
    folderPath: 'My Drive/Legal/2026',
    accountEmail: ACCOUNT,
    content: { kind: 'fetched', text: 'Lease ends December 31, 2026', truncated: false },
  });
  assert.equal(indexed.metadata.contentIndexed, true);
  assert.equal(indexed.content, 'Lease ends December 31, 2026');
  assert.notEqual(indexed.contentHash, bare.contentHash);

  // An unchanged file keeps its stored text: same hash, and the write is told
  // not to replace the content it did not re-download.
  const unchanged = driveFileToDocument({
    file: lease,
    folderPath: 'My Drive/Legal/2026',
    accountEmail: ACCOUNT,
    content: {
      kind: 'stored',
      digest: String(indexed.metadata.contentDigest),
      truncated: false,
    },
  });
  assert.equal(unchanged.contentHash, indexed.contentHash);
  assert.equal(unchanged.keepStoredContent, true);
  assert.equal(unchanged.content, '');

  // The same text under a renamed folder is a different row state.
  const moved = driveFileToDocument({
    file: lease,
    folderPath: 'My Drive/Contracts',
    accountEmail: ACCOUNT,
    content: { kind: 'stored', digest: String(indexed.metadata.contentDigest), truncated: false },
  });
  assert.notEqual(moved.contentHash, indexed.contentHash);

  const folder = driveFileToDocument({
    file: DRIVE_FILES[0],
    folderPath: 'My Drive',
    accountEmail: ACCOUNT,
  });
  assert.equal(folder.metadata.kind, 'folder');
  assert.equal(folder.metadata.path, `${ACCOUNT}/My Drive/Legal`);
});

test('only text-like files have a text request', () => {
  assert.deepEqual(driveTextRequest(DRIVE_FILES[2]), {
    path: 'files/lease/export?mimeType=text%2Fplain',
  });
  assert.deepEqual(driveTextRequest(DRIVE_FILES[4]), {
    path: 'files/shared/export?mimeType=text%2Fcsv',
  });
  assert.deepEqual(driveTextRequest(DRIVE_FILES[3]), { path: 'files/notes?alt=media' });
  assert.equal(driveTextRequest({ id: 'pdf', mimeType: 'application/pdf', size: '10' }), null);
  assert.equal(driveTextRequest(DRIVE_FILES[0]), null);
  assert.equal(
    driveTextRequest({
      id: 'big',
      mimeType: 'text/plain',
      size: String(DRIVE_MAX_DOWNLOAD_BYTES + 1),
    }),
    null
  );
});

process.stdout.write(`google workspace documents: ${passed} checks passed\n`);
