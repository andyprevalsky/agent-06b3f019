#!/usr/bin/env tsx
/**
 * Black-box tests for the `calendar` and `drive` grep sources.
 *
 * An explore agent must be able to treat Google Calendar and Drive like
 * folders: list a day or a folder, search by regex, and feed any printed path
 * back as `filters.path`. These run through the real HTTP endpoint and the real
 * database. Google itself is replaced only in the last test, at the outbound
 * replay cache, to prove a stale source is refreshed before it is searched.
 */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { IntegrationStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { calendarEventsUrl } from '../../services/integrations/googleWorkspaceApi';
import {
  GOOGLE_CALENDAR_SOURCE,
  calendarEventToDocument,
  calendarWindow,
  driveFileToDocument,
} from '../../services/integrations/googleWorkspaceDocuments';
import {
  BASE_URL,
  GDOC,
  assert,
  headers,
  grepOk,
  expectInvalid,
  day,
  timedEvent,
  store,
  markFresh,
  createUser,
  seedGoogleRows,
} from './data-google-sources.blackbox.helpers';
config();

async function testCalendarListsOneDay(userId: string, email: string): Promise<void> {
  const body = await grepOk(userId, {
    sources: ['calendar'],
    filters: { since: day(1), until: day(1) },
  });
  assert(
    body.matches.map((m) => m.path).join('|') ===
      [
        `calendar/${email}/${day(1)}/10:00 Project Sync.event`,
        `calendar/${email}/${day(1)}/12:00 Lunch with Alex.event`,
      ].join('|'),
    `a date-only range lists exactly that day in time order, got ${JSON.stringify(body.matches.map((m) => m.path))}`
  );
  assert(body.display_order === 'oldest_first', 'a calendar listing reads forward in time');
  const sync = body.matches[0];
  assert(sync.source === 'calendar' && sync.location.source === 'calendar', 'source is calendar');
  for (const expected of ['title: Project Sync', 'When: ', 'Where: Room 4', 'sam@example.com']) {
    assert(sync.content.includes(expected), `a listing shows the event header (${expected})`);
  }
}

async function testCalendarDefaultsToUpcoming(userId: string): Promise<void> {
  const upcoming = await grepOk(userId, { sources: ['calendar'] });
  const titles = upcoming.matches.map((m) => m.path.split('/').pop());
  assert(
    !titles.some((title) => title?.includes('Quarterly review')),
    'with no narrowing, past events are not listed'
  );
  assert(upcoming.total_matches === 4, `upcoming events are all listed, got ${titles.join(', ')}`);

  const past = await grepOk(userId, {
    sources: ['calendar'],
    pattern: 'quarterly',
    '-i': true,
    filters: { since: day(-30) },
  });
  assert(past.total_matches === 1, 'an explicit since reaches past events');

  // A multi-day all-day event is found on a middle day.
  const middle = await grepOk(userId, {
    sources: ['calendar'],
    filters: { since: day(4), until: day(4) },
  });
  assert(
    middle.matches.length === 1 && middle.matches[0].path.includes('all-day Offsite'),
    `an all-day event covers its inner days, got ${JSON.stringify(middle.matches.map((m) => m.path))}`
  );
}

async function testCalendarPathRoundTrips(userId: string, email: string): Promise<void> {
  const found = await grepOk(userId, { sources: ['calendar'], pattern: 'launch checklist' });
  assert(found.matches.length === 1, 'the description is searchable');
  assert(
    found.matches[0].content.includes('title: Project Sync') &&
      found.matches[0].content.includes('When: ') &&
      found.matches[0].pointer === 'calendar:sync',
    `a calendar match shows the whole event, got ${JSON.stringify(found.matches[0].content)}`
  );
  const path = found.matches[0].path;
  const one = await grepOk(userId, { sources: ['calendar'], filters: { path } });
  assert(
    one.matches.length === 1 && one.matches[0].path === path,
    'a printed event path addresses exactly that event'
  );
  const folder = await grepOk(userId, {
    sources: ['calendar'],
    filters: { path: `calendar/${email}/${day(1)}` },
  });
  assert(folder.matches.length === 2, 'a day folder lists that day');
  const account = await grepOk(userId, {
    sources: ['calendar'],
    filters: { path: `calendar/${email}/` },
  });
  assert(account.total_matches === 5, 'the account folder lists everything, past included');
}

async function testDriveSearchAndFolders(userId: string, email: string): Promise<void> {
  const text = await grepOk(userId, { sources: ['drive'], pattern: 'ends December', '-C': 1 });
  assert(text.matches.length === 1, 'file text is searchable');
  const lease = text.matches[0];
  assert(
    lease.path === `drive/${email}/My Drive/Legal/Lease.gdoc`,
    `lease path, got ${lease.path}`
  );
  assert(
    lease.content.includes('Tenant: Andy') && lease.content.includes('Rent due on the 1st'),
    'context lines come from the document text'
  );
  // A hit deep in the text still says which file it is and how big it is, and
  // never exposes an internal id that could be mistaken for the Google file id.
  assert(
    lease.content.includes('title: Lease') && lease.content.includes('text: 4 lines'),
    `a match leads with the file header, got ${JSON.stringify(lease.content)}`
  );
  const stored = await prisma.userDataDocument.findFirstOrThrow({
    where: { userId, source: 'google_drive', title: 'Lease' },
    select: { id: true },
  });
  assert(
    lease.pointer === 'drive:lease' && !JSON.stringify(lease).includes(stored.id),
    `the pointer is the Google file id, got ${lease.pointer}`
  );

  const folder = await grepOk(userId, {
    sources: ['drive'],
    filters: { path: `drive/${email}/My Drive/Legal` },
  });
  assert(
    folder.matches
      .map((m) => m.path.split('/').pop())
      .sort()
      .join('|') === 'Lease.gdoc|scan.pdf',
    `a folder path lists what is inside it, got ${JSON.stringify(folder.matches.map((m) => m.path))}`
  );
  const scan = folder.matches.find((m) => m.path.endsWith('scan.pdf'));
  assert(scan?.content.includes('text: not loaded'), 'a file without text says so');
  assert(scan.content.includes('type: application/pdf'), 'a listing shows the file type');

  const byName = await grepOk(userId, { sources: ['drive'], pattern: 'scan' });
  assert(
    byName.matches.some((m) => m.path.endsWith('scan.pdf')),
    'a file is findable by name even without text'
  );
  assert(folder.display_order === 'newest_first', 'drive lists most recently modified first');

  const one = await grepOk(userId, { sources: ['drive'], filters: { path: lease.path } });
  assert(one.matches.length === 1, 'a printed file path addresses exactly that file');
  assert(one.matches[0].content.includes('text: 4 lines'), 'the header says how much text follows');

  // Whatever a listing prints can be searched for, not only the file text.
  for (const [pattern, name] of [
    ['type: application/pdf', 'scan.pdf'],
    ['modified: 2026-09-25', 'notes.txt'],
    ['title: Lease', 'Lease.gdoc'],
  ]) {
    const shown = await grepOk(userId, { sources: ['drive'], pattern });
    assert(
      shown.matches.length === 1 && shown.matches[0].path.endsWith(name),
      `a displayed header line is searchable (${pattern}), got ${JSON.stringify(shown.matches.map((m) => m.path))}`
    );
  }

  // A printed path names its source, so following it needs no `sources`.
  const followed = await grepOk(userId, { filters: { path: lease.path } });
  assert(
    followed.sources.join() === 'drive' && followed.matches[0]?.content.includes('Tenant: Andy'),
    `a drive path alone reads that file, got ${JSON.stringify(followed.sources)}`
  );
  const day1 = await grepOk(userId, { filters: { path: `calendar/${email}/${day(1)}` } });
  assert(
    day1.sources.join() === 'calendar' && day1.matches.length === 2,
    'a calendar path alone lists that day'
  );
}

/** Grep shows a match and a few lines around it; reading a whole file needs its own way in. */
async function testAddressedFileIsReadInFull(): Promise<void> {
  const { userId, email } = await createUser('gws-read');
  try {
    const clauses = Array.from(
      { length: 120 },
      (_, index) =>
        `Clause ${index + 1}: ${'the tenant shall keep the premises in good order '.repeat(2)}`
    );
    const schedule = `Schedule A: ${'x'.repeat(5000)} end-of-schedule`;
    const text = [...clauses, schedule, 'Signed by both parties'].join('\n');
    const agenda = Array.from({ length: 30 }, (_, index) => `Agenda item ${index + 1}`).join('\n');
    const kickoff = calendarEventToDocument(
      timedEvent('kickoff', 'Kickoff', day(2), '09:00', { description: agenda }),
      email
    );
    assert(kickoff !== null, 'fixture event maps to a document');
    await store(userId, [
      kickoff,
      driveFileToDocument({
        file: {
          id: 'lease',
          name: 'Lease',
          mimeType: GDOC,
          modifiedTime: '2026-09-20T12:00:00.000Z',
        },
        folderPath: 'My Drive/Legal',
        accountEmail: email,
        content: { kind: 'fetched', text, truncated: false },
      }),
    ]);
    await markFresh(userId);

    const path = `drive/${email}/My Drive/Legal/Lease.gdoc`;
    const whole = await grepOk(userId, { sources: ['drive'], filters: { path }, head_limit: 100 });
    assert(
      whole.matches.length > 1 && whole.matches.every((match) => match.path === path),
      `a file addressed with no pattern is returned as its pages, got ${whole.matches.length}`
    );
    assert(
      whole.matches.every((match) => match.content.length <= 2000),
      'every page is small enough that a default page of matches fits one result'
    );
    const read = whole.matches.map((match) => match.content).join('\n');
    for (const expected of [
      '1: title: Lease',
      '5: Clause 1:',
      'Clause 120:',
      'end-of-schedule',
      'Signed by both parties',
    ]) {
      assert(read.includes(expected), `the whole file is readable, missing "${expected}"`);
    }
    assert((read.match(/x/g) ?? []).length >= 5000, 'a line longer than a page is not cut off');

    const first = await grepOk(userId, { sources: ['drive'], filters: { path }, head_limit: 2 });
    assert(
      first.matches.length === 2 &&
        first.has_more &&
        first.next_offset === 2 &&
        first.total_matches === whole.total_matches,
      `reading pages like any grep result, got ${JSON.stringify({ has_more: first.has_more, next: first.next_offset })}`
    );
    const next = await grepOk(userId, {
      sources: ['drive'],
      filters: { path },
      head_limit: 2,
      offset: 2,
    });
    assert(
      next.matches[0]?.content === whole.matches[2].content,
      'offset continues exactly where the previous page ended'
    );

    const within = await grepOk(userId, {
      sources: ['drive'],
      pattern: 'Clause 77:',
      filters: { path },
    });
    assert(
      within.matches.length === 1 && within.matches[0].content.includes('Clause 77:'),
      'a pattern still searches inside the addressed file'
    );
    // Inside one file every matching place is returned, as grep does on a file.
    const several = await grepOk(userId, {
      sources: ['drive'],
      pattern: 'Clause (5|50|100):',
      filters: { path },
    });
    assert(
      several.total_matches === 3 &&
        several.matches.map((match) => /Clause (\d+):/.exec(match.content)?.[1]).join() ===
          '5,50,100',
      `each matching place in the file is its own match, got ${several.total_matches}`
    );
    const folder = await grepOk(userId, {
      sources: ['drive'],
      filters: { path: `drive/${email}/My Drive/Legal` },
    });
    assert(
      folder.matches.length === 1 && !folder.matches[0].content.includes('Clause 30:'),
      'a folder still lists its files instead of printing their text'
    );

    const event = await grepOk(userId, {
      sources: ['calendar'],
      filters: { path: `calendar/${email}/${day(2)}/09:00 Kickoff.event` },
    });
    assert(
      event.matches
        .map((match) => match.content)
        .join('\n')
        .includes('Agenda item 30'),
      'an addressed event shows its whole description'
    );
  } finally {
    await prisma.user.delete({ where: { userId } });
  }
}

/**
 * Calendar and Drive rows live in the document table, but an agent must meet
 * them only as `calendar/` and `drive/`: the generic documents source filters
 * by modified time and never refreshes, so a second way in gives wrong answers.
 */
async function testSummaryAndDocumentsSeparation(userId: string, email: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/data/summary`, { headers: headers(userId) });
  const summary = (await response.json()) as {
    sources: {
      calendar?: { accounts: string[]; total_events: number };
      drive?: { accounts: string[]; total_files: number };
      documents?: { total_documents: number; sources: Record<string, number> };
    };
  };
  assert(
    summary.sources.calendar?.total_events === 5 &&
      summary.sources.calendar.accounts.join() === email,
    `the summary shows the calendar and its account, got ${JSON.stringify(summary.sources.calendar)}`
  );
  assert(
    summary.sources.drive?.total_files === 3 && summary.sources.drive.accounts.join() === email,
    `the summary counts Drive files, not folders, got ${JSON.stringify(summary.sources.drive)}`
  );
  assert(
    summary.sources.documents === undefined,
    `Google rows are not also reported as generic documents, got ${JSON.stringify(summary.sources.documents)}`
  );

  const viaDocuments = await grepOk(userId, {
    sources: ['documents'],
    pattern: 'Project Sync|Lease',
  });
  assert(
    viaDocuments.total_matches === 0,
    'the generic documents source does not return calendar or drive rows'
  );
  const named = await grepOk(userId, {
    sources: ['documents'],
    pattern: 'Lease',
    filters: { document_source: 'google_drive' },
  });
  assert(named.total_matches === 0, 'naming the stored source does not reach them either');

  const fresh = await createUser('gws-unsynced');
  try {
    const before = await fetch(`${BASE_URL}/api/data/summary`, { headers: headers(fresh.userId) });
    const { sources } = (await before.json()) as typeof summary;
    assert(
      sources.calendar?.total_events === 0 && sources.drive?.accounts.join() === fresh.email,
      'a connected account is shown before its first refresh, since a search is what refreshes it'
    );
  } finally {
    await prisma.user.delete({ where: { userId: fresh.userId } });
  }
}

async function testValidation(userId: string, email: string): Promise<void> {
  await expectInvalid(
    userId,
    { sources: ['calendar'], filters: { path: `drive/${email}/My Drive` } },
    'a drive path on calendar'
  );
  await expectInvalid(
    userId,
    { sources: ['calendar'], filters: { person: 'Sam' } },
    'a messages-only filter on calendar'
  );
  await expectInvalid(userId, { sources: ['calendar', 'email'] }, 'no pattern with email selected');
  await expectInvalid(
    userId,
    { sources: ['drive'], filters: { path: 'not-a-path' } },
    'a non-path string'
  );
  // Both Google sources may be listed together; a path narrows to its own source.
  const both = await grepOk(userId, {
    sources: ['calendar', 'drive'],
    filters: { path: `drive/${email}/My Drive/Legal` },
  });
  assert(
    both.matches.length === 2 && both.matches.every((m) => m.source === 'drive'),
    'a drive path selects nothing from calendar'
  );
}

async function testTenantIsolationAndStatus(userId: string): Promise<void> {
  const other = await createUser('gws-other');
  try {
    await markFresh(other.userId);
    const body = await grepOk(other.userId, {
      sources: ['calendar', 'drive'],
      filters: { since: day(-365) },
    });
    assert(body.total_matches === 0, "another user's Google rows are never returned");

    const response = await fetch(`${BASE_URL}/api/data/source-status?sources=calendar,drive`, {
      headers: headers(userId),
    });
    const status = (await response.json()) as {
      statuses: Array<{ source: string; connector: string; connected: boolean }>;
    };
    assert(
      status.statuses.length === 2 &&
        status.statuses.every((s) => s.connector === 'gmail' && s.connected),
      `calendar and drive use the Google connection, got ${JSON.stringify(status)}`
    );
  } finally {
    await prisma.user.delete({ where: { userId: other.userId } });
  }

  const none = `gws-none-${randomUUID()}`;
  await prisma.user.create({ data: { userId: none, isAnonymous: true } });
  try {
    const response = await fetch(`${BASE_URL}/api/data/source-status?sources=calendar`, {
      headers: headers(none),
    });
    const status = (await response.json()) as {
      statuses: Array<{ connected: boolean; connectUrl: string | null }>;
    };
    assert(
      status.statuses[0]?.connected === false && status.statuses[0].connectUrl !== null,
      'without a Google connection the source reports not connected with a connect link'
    );
  } finally {
    await prisma.user.delete({ where: { userId: none } });
  }

  // A failing email sync is a fault on our side: Calendar and Drive stay
  // connected and the user is never asked to reconnect for it.
  const failing = await createUser('gws-syncfail');
  try {
    await prisma.integration.updateMany({
      where: { userId: failing.userId, name: 'gmail' },
      data: { status: IntegrationStatus.SYNC_FAILED },
    });
    await prisma.emailIntegrationCredential.updateMany({
      where: { userId: failing.userId },
      data: { state: 'sync_failed', lastErrorReason: 'Email sync is misconfigured on our side.' },
    });
    const response = await fetch(`${BASE_URL}/api/data/source-status?sources=calendar,drive`, {
      headers: headers(failing.userId),
    });
    const { statuses } = (await response.json()) as {
      statuses: Array<{ source: string; connected: boolean }>;
    };
    assert(
      statuses.length === 2 && statuses.every((status) => status.connected),
      `a failing email sync does not disconnect calendar or drive, got ${JSON.stringify(statuses)}`
    );
  } finally {
    await prisma.user.delete({ where: { userId: failing.userId } });
  }

  // Google connected before Rose asked for Calendar and Drive: email still
  // works, but these two sources must ask the user to reconnect.
  const legacy = await createUser('gws-legacy', [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.modify',
  ]);
  try {
    const response = await fetch(
      `${BASE_URL}/api/data/source-status?sources=calendar,drive,gmail`,
      { headers: headers(legacy.userId) }
    );
    const { statuses } = (await response.json()) as {
      statuses: Array<{ source: string; connected: boolean; connectUrl: string | null }>;
    };
    const bySource = new Map(statuses.map((status) => [status.source, status]));
    for (const source of ['calendar', 'drive']) {
      assert(
        bySource.get(source)?.connected === false && bySource.get(source)?.connectUrl !== null,
        `${source} needs a reconnect for a legacy grant, got ${JSON.stringify(statuses)}`
      );
    }
    assert(bySource.get('gmail')?.connected === true, 'email stays connected for a legacy grant');

    const body = await grepOk(legacy.userId, { sources: ['calendar'], pattern: 'anything' });
    assert(
      body.matches.length === 0 &&
        body.message?.includes('calendar has no Google account that granted access to it') === true,
      `a legacy grant searches nothing and says why, got ${JSON.stringify(body.message)}`
    );
  } finally {
    await prisma.user.delete({ where: { userId: legacy.userId } });
  }
}

async function testSyncingSourceSaysSo(): Promise<void> {
  const { userId, email } = await createUser('gws-syncing');
  try {
    const doc = calendarEventToDocument(timedEvent('sync', 'Project Sync', day(1), '10:00'), email);
    assert(doc !== null, 'fixture event maps to a document');
    await store(userId, [doc]);
    // Another refresh holds the lease and the last success is old.
    await prisma.userDataProviderSyncState.create({
      data: {
        userId,
        source: GOOGLE_CALENDAR_SOURCE,
        status: 'SYNCING',
        lastStartedAt: new Date(),
        lastSuccessfulSyncAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const body = await grepOk(userId, { sources: ['calendar'], pattern: 'Project Sync' });
    assert(body.matches.length === 1, 'stored rows are still searched while a refresh runs');
    assert(
      body.message?.includes('calendar is still syncing from Google') === true,
      `the result says the source is still syncing, got ${JSON.stringify(body.message)}`
    );

    const fresh = await grepOk(userId, { sources: ['calendar'], pattern: 'nothing-matches-this' });
    assert(
      fresh.message?.includes('still syncing') === true && fresh.message.includes('No matches'),
      'an empty result keeps both the notice and the no-match line'
    );
  } finally {
    await prisma.user.delete({ where: { userId } });
  }
}

async function testStaleSourceIsRefreshedBeforeSearch(): Promise<void> {
  const { userId, email } = await createUser('gws-live');
  try {
    // No sync state yet, so the first grep must fetch from Google. The replay
    // cache answers for Google with one event that exists nowhere in the DB.
    const url = calendarEventsUrl(calendarWindow(new Date()));
    const seeded = await fetch(`${BASE_URL}/api/test/captures/cache`, {
      method: 'PUT',
      headers: headers(userId),
      body: JSON.stringify({
        key: `call:${JSON.stringify([url, 'GET', null])}`,
        value: {
          __ff_promise_result: true,
          value: {
            status: 200,
            statusText: 'OK',
            body: JSON.stringify({
              items: [timedEvent('fresh', 'Fetched from Google', day(2), '09:30')],
            }),
            headers: { 'content-type': 'application/json' },
          },
        },
      }),
    });
    assert(seeded.status === 200, `could not seed the Google replay: HTTP ${seeded.status}`);

    const body = await grepOk(userId, { sources: ['calendar'], pattern: 'Fetched' });
    assert(
      body.matches.length === 1 &&
        body.matches[0].path === `calendar/${email}/${day(2)}/09:30 Fetched from Google.event`,
      `a stale source is refreshed before the search, got ${JSON.stringify(body.matches)}`
    );
    const state = await prisma.userDataProviderSyncState.findUnique({
      where: { userId_source: { userId, source: GOOGLE_CALENDAR_SOURCE } },
    });
    assert(state?.status === 'CONNECTED', 'the refresh is recorded');
    assert(state.lastSuccessfulSyncAt !== null, 'the refresh time is recorded');
  } finally {
    await prisma.user.delete({ where: { userId } });
  }
}

async function runAll(): Promise<void> {
  const { userId, email } = await createUser('gws-grep');
  await seedGoogleRows(userId, email);
  const tests = [
    ['calendar lists one day in time order', () => testCalendarListsOneDay(userId, email)],
    ['calendar defaults to upcoming events', () => testCalendarDefaultsToUpcoming(userId)],
    ['calendar paths round-trip as filters.path', () => testCalendarPathRoundTrips(userId, email)],
    ['drive searches text and lists folders', () => testDriveSearchAndFolders(userId, email)],
    [
      'the summary shows calendar and drive apart from documents',
      () => testSummaryAndDocumentsSeparation(userId, email),
    ],
    ['google source filters are validated', () => testValidation(userId, email)],
    ['tenant isolation and connection status', () => testTenantIsolationAndStatus(userId)],
    ['a file addressed by its path is read in full', () => testAddressedFileIsReadInFull()],
    ['a source that is still syncing says so', () => testSyncingSourceSaysSo()],
    ['a stale source is refreshed before search', () => testStaleSourceIsRefreshedBeforeSearch()],
  ] as const;
  try {
    for (const [name, fn] of tests) {
      await fn();
      console.log(`PASS ${name}`);
    }
  } finally {
    await prisma.user.delete({ where: { userId } });
    await prisma.$disconnect();
  }
}

runAll().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
