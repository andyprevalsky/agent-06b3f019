#!/usr/bin/env tsx
/**
 * Google Calendar and Drive sync into the grep document store.
 *
 * Runs the real sync against the real database with Google replaced at the
 * `fetch` boundary. What must stay true:
 *
 *   - rows mirror Google: new events and files appear, changed ones update,
 *     removed ones disappear;
 *   - a refresh inside the freshness window costs no Google call, and an
 *     unchanged Drive costs exactly one;
 *   - unchanged Drive text is never downloaded twice;
 *   - one user's refresh is single-flight and never throws into grep;
 *   - rows of an account that is no longer connected do not survive.
 */

import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  DRIVE_INITIAL_CONTENT_FILES,
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_DRIVE_SOURCE,
  type GoogleDriveFile,
} from '../../services/integrations/googleWorkspaceDocuments';
import {
  GOOGLE_SOURCE_FRESHNESS_MS,
  ensureDriveText,
  ensureDriveTextWithin,
  ensureGoogleSourceFresh,
  ensureGoogleSourceFreshWithin,
} from '../../services/integrations/googleWorkspaceSync';
import { processGoogleDataPurge } from '../../services/integrations/googleDataPurge';
import {
  FOLDER,
  FakeGoogle,
  GDOC,
  T0,
  addAccount,
  assert,
  equal,
  event,
  later,
  pathOf,
  rows,
  withUser,
} from './google-workspace-sync.blackbox.helpers';
config();

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The row's content once it equals `expected`, or its last value after 5 s. */
async function contentOf(id: string, expected: string): Promise<string> {
  let content = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    content = (await prisma.userDataDocument.findUniqueOrThrow({ where: { id } })).content;
    if (content === expected) break;
    await pause(100);
  }
  return content;
}

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

test('calendar rows mirror Google across refreshes', async () => {
  await withUser(async ({ userId, email }) => {
    const google = new FakeGoogle();
    google.events = [
      event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00'),
      event('lunch', 'Lunch', '2026-10-09T12:00:00-07:00'),
      { ...event('gone', 'Cancelled thing', '2026-10-07T09:00:00-07:00'), status: 'cancelled' },
    ];
    const opts = { fetcher: google.fetcher, now: T0 };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, opts),
      'refreshed',
      'first'
    );
    let stored = await rows(userId, GOOGLE_CALENDAR_SOURCE);
    equal(stored.length, 2, 'cancelled events are not stored');
    assert(
      stored.every((row) => row.googleAccountEmail === email),
      'rows are tagged with their Google account'
    );
    const sync = stored.find((row) => row.title === 'Project Sync');
    assert(sync !== undefined, 'Project Sync row exists');
    equal(pathOf(sync), `${email}/2026-10-06/10:00 Project Sync.event`, 'path');

    // Inside the freshness window a grep must not cost a Google call.
    google.reset();
    const soon = { fetcher: google.fetcher, now: later(0.5) };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, soon), 'fresh', 'window');
    equal(google.calls.length, 0, 'no Google call inside the window');

    // After it: one event renamed, one removed, one new.
    google.events = [
      event('sync', 'Project Sync (moved)', '2026-10-06T11:00:00-07:00'),
      event('new', 'Dentist', '2026-10-12T15:00:00-07:00'),
    ];
    const after = { fetcher: google.fetcher, now: later(5) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, after),
      'refreshed',
      'second'
    );
    stored = await rows(userId, GOOGLE_CALENDAR_SOURCE);
    equal(
      stored
        .map((row) => row.title)
        .sort()
        .join('|'),
      'Dentist|Project Sync (moved)',
      'rows after the second refresh'
    );
    const moved = stored.find((row) => row.title.startsWith('Project Sync'));
    equal(moved?.id, sync.id, 'a changed event updates its row in place');
    equal(pathOf(moved), `${email}/2026-10-06/11:00 Project Sync (moved).event`, 'updated path');
  });
});

test('an unchanged calendar is not rewritten', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    const [before] = await rows(userId, GOOGLE_CALENDAR_SOURCE);
    await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, {
      fetcher: google.fetcher,
      now: later(5),
    });
    const [afterRow] = await rows(userId, GOOGLE_CALENDAR_SOURCE);
    equal(
      afterRow.updatedAt.toISOString(),
      before.updatedAt.toISOString(),
      'unchanged row must not be written'
    );
  });
});

const LEGAL: GoogleDriveFile = { id: 'legal', name: 'Legal', mimeType: FOLDER, parents: ['root'] };
const LEASE: GoogleDriveFile = {
  id: 'lease',
  name: 'Lease',
  mimeType: GDOC,
  parents: ['legal'],
  modifiedTime: '2026-09-20T12:00:00.000Z',
};
const NOTES: GoogleDriveFile = {
  id: 'notes',
  name: 'notes.txt',
  mimeType: 'text/plain',
  parents: ['root'],
  size: '20',
  modifiedTime: '2026-09-21T12:00:00.000Z',
};
const SCAN: GoogleDriveFile = {
  id: 'scan',
  name: 'scan.pdf',
  mimeType: 'application/pdf',
  parents: ['legal'],
  size: '900',
  modifiedTime: '2026-09-22T12:00:00.000Z',
};

test('drive rows carry folder paths and text, and unchanged text is not re-downloaded', async () => {
  await withUser(async ({ userId, email }) => {
    const google = new FakeGoogle();
    google.files = [SCAN, NOTES, LEASE, LEGAL];
    google.text.set('lease', 'Lease ends December 31, 2026');
    google.text.set('notes', 'remember the milk');
    const first = { fetcher: google.fetcher, now: T0 };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, first), 'refreshed', 'first');
    let stored = await rows(userId, GOOGLE_DRIVE_SOURCE);
    const byTitle = (title: string) => stored.find((row) => row.title === title);
    equal(stored.length, 4, 'folder and files are all stored');
    equal(pathOf(byTitle('Lease')!), `${email}/My Drive/Legal/Lease.gdoc`, 'doc path');
    equal(byTitle('Lease')?.content, 'Lease ends December 31, 2026', 'doc text');
    equal(byTitle('notes.txt')?.content, 'remember the milk', 'text file content');
    equal(byTitle('scan.pdf')?.content, '', 'a PDF is name and path only');
    equal(google.count('download'), 2, 'only text-like files are downloaded');

    // Nothing changed: exactly one cheap call, no listing, no downloads.
    google.reset();
    const quiet = { fetcher: google.fetcher, now: later(5) };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, quiet), 'refreshed', 'quiet');
    equal(google.calls.join(','), 'changes', 'an unchanged Drive costs one call');

    // The folder is renamed and one file edited. Paths under the folder move;
    // only the edited file's text is downloaded again.
    google.reset();
    google.driveChanged = true;
    google.files = [
      SCAN,
      { ...NOTES, modifiedTime: '2026-10-05T09:00:00.000Z' },
      LEASE,
      { ...LEGAL, name: 'Contracts' },
    ];
    google.text.set('notes', 'remember the milk and eggs');
    const changed = { fetcher: google.fetcher, now: later(10) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, changed),
      'refreshed',
      'changed'
    );
    stored = await rows(userId, GOOGLE_DRIVE_SOURCE);
    equal(pathOf(byTitle('Lease')!), `${email}/My Drive/Contracts/Lease.gdoc`, 'renamed folder');
    equal(byTitle('Lease')?.content, 'Lease ends December 31, 2026', 'kept text survives a move');
    equal(byTitle('notes.txt')?.content, 'remember the milk and eggs', 'edited text is refreshed');
    equal(google.count('download'), 1, 'only the edited file is downloaded');

    // A deleted file disappears.
    google.reset();
    google.files = google.files.filter((file) => file.id !== 'scan');
    await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, {
      fetcher: google.fetcher,
      now: later(15),
    });
    stored = await rows(userId, GOOGLE_DRIVE_SOURCE);
    equal(byTitle('scan.pdf'), undefined, 'removed file is deleted');
  });
});

test('drive text beyond the up-front budget is fetched when a file is addressed', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    const total = DRIVE_INITIAL_CONTENT_FILES + 2;
    google.files = Array.from({ length: total }, (_, index) => ({
      id: `f${index}`,
      name: `file-${index}.txt`,
      mimeType: 'text/plain',
      parents: ['root'],
      size: '10',
      modifiedTime: new Date(Date.UTC(2026, 8, 30) - index * 60_000).toISOString(),
    }));
    for (const file of google.files) google.text.set(file.id, `text of ${file.name}`);
    await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    equal(google.count('download'), DRIVE_INITIAL_CONTENT_FILES, 'downloads stop at the budget');
    const stored = await rows(userId, GOOGLE_DRIVE_SOURCE);
    const oldest = stored.find((row) => row.title === `file-${total - 1}.txt`);
    assert(oldest !== undefined, 'the oldest file is still listed');
    equal(oldest.content, '', 'the oldest file starts as name and path only');

    // A search waits only briefly for a slow download; the text still lands.
    google.reset();
    google.delayMs = 1_000;
    const waitStartedAt = Date.now();
    await ensureDriveTextWithin(userId, [oldest.id], 100, { fetcher: google.fetcher });
    assert(Date.now() - waitStartedAt < 800, 'the search is not held for the whole download');
    const opened = await contentOf(oldest.id, `text of file-${total - 1}.txt`);
    equal(opened, `text of file-${total - 1}.txt`, 'the download finishes after the search');
    google.delayMs = 0;
    equal(await ensureDriveText(userId, [oldest.id], { fetcher: google.fetcher }), 0, 'idempotent');
    equal(google.count('download'), 1, 'addressing twice downloads once');
  });
});

test('a rate-limited Drive download keeps the stored text and fails the refresh', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.files = [NOTES];
    google.text.set('notes', 'remember the lease');
    const first = { fetcher: google.fetcher, now: T0 };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, first), 'refreshed', 'first');
    // The file changes, and Drive answers the new download with its rate-limit 403.
    google.files = [{ ...NOTES, modifiedTime: '2026-10-05T13:00:00.000Z' }];
    google.driveChanged = true;
    google.rateLimitDownloads = true;
    google.reset();
    const limited = { fetcher: google.fetcher, now: later(5) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, limited),
      'failed',
      'a rate limit fails the refresh instead of passing as an unreadable file'
    );
    assert(google.count('download') >= 3, 'the rate limit is retried before giving up');
    const [row] = await rows(userId, GOOGLE_DRIVE_SOURCE);
    equal(row.content, 'remember the lease', 'the stored text survives');
  });
});

test('a refresh renews its lease as it works', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.files = [NOTES];
    google.text.set('notes', 'remember the lease');
    const options = { fetcher: google.fetcher, now: T0, leaseRenewMs: 0 };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, options), 'refreshed', 'run');
    const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId, source: GOOGLE_DRIVE_SOURCE } },
    });
    assert(
      (state.lastStartedAt?.getTime() ?? 0) > T0.getTime(),
      'the lease moved past its claim while the refresh worked'
    );
  });
});

test('a refresh that lost its lease stops without overwriting the new owner', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.files = [NOTES];
    google.text.set('notes', 'remember the lease');
    google.delayMs = 300;
    const options = { fetcher: google.fetcher, now: T0, leaseRenewMs: 0 };
    const displaced = ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, options);
    // A later refresh takes the lease over while the first one is listing files.
    for (let attempt = 0; attempt < 50 && google.calls.length === 0; attempt += 1) await pause(10);
    const takeover = new Date(T0.getTime() + 10 * 60_000);
    await prisma.userDataProviderSyncState.update({
      where: { userId_source: { userId, source: GOOGLE_DRIVE_SOURCE } },
      data: { status: 'SYNCING', lastStartedAt: takeover },
    });
    equal(await displaced, 'in_progress', 'the displaced refresh defers to the new owner');
    const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId, source: GOOGLE_DRIVE_SOURCE } },
    });
    equal(state.status, 'SYNCING', 'the new owner still holds the lease');
    equal(state.lastStartedAt?.toISOString(), takeover.toISOString(), 'its stamp is untouched');
    equal(state.lastSuccessfulSyncAt, null, 'the displaced refresh did not claim success');
    equal(google.count('download'), 0, 'the displaced refresh stopped before downloading');
  });
});

test('a refresh is single-flight per user and source', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    await prisma.userDataProviderSyncState.create({
      data: { userId, source: GOOGLE_CALENDAR_SOURCE, status: 'SYNCING', lastStartedAt: T0 },
    });
    const held = { fetcher: google.fetcher, now: later(1) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, held),
      'in_progress',
      'held'
    );
    equal(google.calls.length, 0, 'a held lease makes no Google call');
    // A lease nobody finished is taken over.
    const stale = { fetcher: google.fetcher, now: later(10) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, stale),
      'refreshed',
      'stale'
    );
  });
});

test('a slow refresh does not hold the caller past its wait', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.delayMs = 400;
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    const started = Date.now();
    const outcome = await ensureGoogleSourceFreshWithin(userId, GOOGLE_CALENDAR_SOURCE, 50, {
      fetcher: google.fetcher,
      now: T0,
    });
    equal(outcome, 'in_progress', 'the caller is told the refresh is still running');
    assert(Date.now() - started < 300, 'the caller got its answer before Google responded');
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 0, 'nothing is stored yet');

    // The refresh was not abandoned: it finishes on its own.
    await new Promise((resolve) => setTimeout(resolve, 900));
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 1, 'the refresh completed');
    const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId, source: GOOGLE_CALENDAR_SOURCE } },
    });
    equal(state.status, 'CONNECTED', 'the lease was released');

    // A refresh that finishes inside the wait returns its real outcome.
    google.delayMs = 0;
    const quick = await ensureGoogleSourceFreshWithin(userId, GOOGLE_CALENDAR_SOURCE, 5_000, {
      fetcher: google.fetcher,
      now: later(5),
    });
    equal(quick, 'refreshed', 'a fast refresh is reported as done');
  });
});

test('a second search waits for the refresh in flight instead of reporting stale rows', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    google.delayMs = 400;
    // Two searches issued together, as an agent does: one refreshes, and the
    // other must come back current rather than "still syncing".
    const outcomes = await Promise.all([
      ensureGoogleSourceFreshWithin(userId, GOOGLE_CALENDAR_SOURCE, 5_000, {
        fetcher: google.fetcher,
      }),
      ensureGoogleSourceFreshWithin(userId, GOOGLE_CALENDAR_SOURCE, 5_000, {
        fetcher: google.fetcher,
      }),
    ]);
    equal(outcomes.slice().sort().join(), 'fresh,refreshed', 'both callers end up current');
    equal(google.count('calendar'), 1, 'Google is still asked once');
  });
});

test('a failing Google call keeps the old rows and never throws', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    google.reset();
    google.calendarStatus = 403;
    const failing = { fetcher: google.fetcher, now: later(5) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, failing),
      'failed',
      'failed'
    );
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 1, 'old rows stay searchable');
    const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId, source: GOOGLE_CALENDAR_SOURCE } },
    });
    equal(state.status, 'SYNC_FAILED', 'state records the failure');
    equal(state.lastSuccessfulSyncAt?.toISOString(), T0.toISOString(), 'last success is kept');

    // The next grep moments later must not hammer Google again.
    google.reset();
    const again = { fetcher: google.fetcher, now: later(5.5) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, again),
      'failed',
      'backoff'
    );
    equal(google.calls.length, 0, 'no retry inside the window');

    google.calendarStatus = 200;
    const recovered = {
      fetcher: google.fetcher,
      now: new Date(later(5).getTime() + GOOGLE_SOURCE_FRESHNESS_MS + 1),
    };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, recovered),
      'refreshed',
      'recovered'
    );
  });
});

test('rows of an account that is no longer connected are removed', async () => {
  await withUser(async ({ userId, email, integrationId }) => {
    const other = `other-${userId.slice(0, 8)}@example.com`;
    await addAccount(userId, integrationId, other);
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 2, 'one row per account');

    await prisma.emailIntegrationCredential.updateMany({
      where: { userId, email: other },
      data: { state: 'needs_reconnect' },
    });
    await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, {
      fetcher: google.fetcher,
      now: later(5),
    });
    const remaining = await rows(userId, GOOGLE_CALENDAR_SOURCE);
    equal(remaining.length, 1, 'only the connected account keeps rows');
    equal(remaining[0].googleAccountEmail, email, 'the surviving row is the connected account');

    await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
    const none = { fetcher: google.fetcher, now: later(10) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, none),
      'not_connected',
      'no accounts'
    );
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 0, 'no rows without an account');
  });
});

test('an account that never granted the source is skipped, not failed', async () => {
  await withUser(async ({ userId, email, integrationId }) => {
    // Connected before Rose asked for Calendar and Drive: Google would answer
    // 403 for it forever, which must not mark the whole source as failing.
    const legacy = `legacy-${userId.slice(0, 8)}@example.com`;
    await addAccount(userId, integrationId, legacy, [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    google.files = [NOTES];
    google.text.set('notes', 'remember the lease');
    for (const source of [GOOGLE_CALENDAR_SOURCE, GOOGLE_DRIVE_SOURCE] as const) {
      const outcome = await ensureGoogleSourceFresh(userId, source, {
        fetcher: google.fetcher,
        now: T0,
      });
      equal(outcome, 'refreshed', `${source} refreshes from the account that granted it`);
      const stored = await rows(userId, source);
      equal(stored.length, 1, `${source} has rows for one account only`);
      equal(stored[0].googleAccountEmail, email, `${source} rows belong to the granting account`);
    }
    equal(google.count('calendar'), 1, 'Google Calendar is never asked for the legacy account');
    equal(google.count('list'), 1, 'Google Drive is never asked for the legacy account');

    await prisma.emailIntegrationCredential.deleteMany({ where: { userId, email } });
    const onlyLegacy = { fetcher: google.fetcher, now: later(5) };
    equal(
      await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, onlyLegacy),
      'not_connected',
      'a user with only a legacy grant has no calendar to search'
    );
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 0, 'no rows are kept');
  });
});

test('an account whose email sync is failing keeps its calendar and drive', async () => {
  await withUser(async ({ userId, email }) => {
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    // `sync_failed` is a fault on our side; the grant is intact.
    await prisma.emailIntegrationCredential.updateMany({
      where: { userId, email },
      data: { state: 'sync_failed', lastErrorReason: 'Email sync is misconfigured on our side.' },
    });
    google.events = [
      event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00'),
      event('lunch', 'Lunch', '2026-10-06T12:00:00-07:00'),
    ];
    const outcome = await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, {
      fetcher: google.fetcher,
      now: later(5),
    });
    equal(outcome, 'refreshed', 'the account is still refreshed');
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 2, 'its rows are kept and updated');
  });
});

test('disconnect purge deletes calendar and drive rows for that account', async () => {
  await withUser(async ({ userId, email }) => {
    const google = new FakeGoogle();
    google.events = [event('sync', 'Project Sync', '2026-10-06T10:00:00-07:00')];
    google.files = [NOTES];
    google.text.set('notes', 'remember the milk');
    const opts = { fetcher: google.fetcher, now: T0 };
    await ensureGoogleSourceFresh(userId, GOOGLE_CALENDAR_SOURCE, opts);
    await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, opts);
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 1, 'calendar row before purge');
    equal((await rows(userId, GOOGLE_DRIVE_SOURCE)).length, 1, 'drive row before purge');

    const job = await prisma.googleDataPurge.create({ data: { userId, email } });
    await processGoogleDataPurge(job.id);
    equal((await rows(userId, GOOGLE_CALENDAR_SOURCE)).length, 0, 'calendar rows purged');
    equal((await rows(userId, GOOGLE_DRIVE_SOURCE)).length, 0, 'drive rows purged');
    const states = await prisma.userDataProviderSyncState.findMany({
      where: { userId, source: { in: [GOOGLE_CALENDAR_SOURCE, GOOGLE_DRIVE_SOURCE] } },
    });
    equal(states.length, 0, 'sync cursors are dropped so a reconnect starts clean');
  });
});

async function main(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ngoogle workspace sync\n');
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      failures.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  FAIL  ${t.name}\n        ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  await prisma.$disconnect();
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('google-workspace-sync')) {
  void main();
}
