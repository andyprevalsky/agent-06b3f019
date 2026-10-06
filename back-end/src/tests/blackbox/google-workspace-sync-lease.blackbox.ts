#!/usr/bin/env tsx
/**
 * Concurrency rules of the Google Calendar and Drive sync, against the real
 * database with Google replaced at the `fetch` boundary. What must stay true:
 *
 *   - a refresh keeps its lease while it works and stops the moment it loses it;
 *   - parallel renewals and searches racing on a first refresh never fail;
 *   - a refresh and an on-demand text download never overwrite each other;
 *   - a listing cut off at the file cap removes only files it proves are gone;
 *   - a disconnect that ends a refresh leaves none of that account's rows.
 */

import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  DRIVE_INITIAL_CONTENT_FILES,
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_DRIVE_SOURCE,
  type GoogleDriveFile,
  type GoogleWorkspaceDocument,
} from '../../services/integrations/googleWorkspaceDocuments';
import { findDriveRowsWithoutText } from '../../domains/data/googleSourceRepo';
import {
  ON_DEMAND_TEXT_CANDIDATES,
  applyGoogleDocuments,
  ensureDriveText,
  ensureGoogleSourceFresh,
} from '../../services/integrations/googleWorkspaceSync';
import {
  LeaseLostError,
  claimSyncLease,
} from '../../services/integrations/googleWorkspaceSyncLease';
import {
  assert,
  equal,
  FakeGoogle,
  later,
  LEASE,
  LEGAL,
  NOTES,
  pause,
  rows,
  runSuite,
  SCAN,
  T0,
  type TestCase,
  textFile,
  withUser,
} from './google-workspace-sync.blackbox.helpers';
config();

const tests: TestCase[] = [];
function test(name: string, fn: TestCase['fn']): void {
  tests.push({ name, fn });
}

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

test('a refresh that lost its lease stops paging through Drive', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.files = [LEGAL, LEASE, NOTES, SCAN];
    google.pageSize = 1;
    google.delayMs = 300;
    const options = { fetcher: google.fetcher, now: T0, leaseRenewMs: 0 };
    const displaced = ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, options);
    for (let attempt = 0; attempt < 200 && google.count('list') === 0; attempt += 1)
      await pause(10);
    await prisma.userDataProviderSyncState.update({
      where: { userId_source: { userId, source: GOOGLE_DRIVE_SOURCE } },
      data: { status: 'SYNCING', lastStartedAt: later(10) },
    });
    equal(await displaced, 'in_progress', 'the displaced refresh defers to the new owner');
    assert(
      google.count('list') <= 2,
      `it stopped paging, after ${google.count('list')} of 4 pages`
    );
  });
});

test('searches racing on a first refresh claim one lease and none fails', async () => {
  await withUser(async ({ userId }) => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimSyncLease(userId, GOOGLE_CALENDAR_SOURCE, T0))
    );
    equal(claims.filter((lease) => lease !== null).length, 1, 'exactly one caller refreshes');
  });
});

test('parallel renewals keep a held lease, and work after the end is told to stop', async () => {
  await withUser(async ({ userId }) => {
    const lease = await claimSyncLease(userId, GOOGLE_DRIVE_SOURCE, T0, 0);
    assert(lease !== null, 'the lease is free to claim');
    await Promise.all(Array.from({ length: 8 }, () => lease.keepAlive()));
    equal(await lease.finish({ status: 'CONNECTED' }), true, 'the refresh still held its lease');
    const late = await lease.keepAlive().then(
      () => 'renewed',
      (error: unknown) => (error instanceof LeaseLostError ? 'stopped' : 'failed')
    );
    equal(late, 'stopped', 'a download still running after the refresh ended');
  });
});

test('writing rows checks the lease after each one', async () => {
  await withUser(async ({ userId, email }) => {
    const doc = (id: string, revision: string): GoogleWorkspaceDocument => ({
      source: GOOGLE_DRIVE_SOURCE,
      googleAccountEmail: email,
      externalId: `${email}:${id}`,
      title: id,
      content: revision,
      metadata: {},
      contentHash: `${id}:${revision}`,
    });
    const write = (revision: string, keepAlive: () => Promise<void>): Promise<unknown> =>
      applyGoogleDocuments({
        userId,
        source: GOOGLE_DRIVE_SOURCE,
        accountEmail: email,
        documents: [doc('a', revision), doc('b', revision)],
        keepAlive,
      });
    await write('one', () => Promise.resolve());
    const second = await write('two', () => Promise.reject(new LeaseLostError())).then(
      () => 'finished',
      () => 'stopped'
    );
    equal(second, 'stopped', 'a lost lease stops the write');
    const stored = (await rows(userId, GOOGLE_DRIVE_SOURCE)).map((row) => row.content);
    equal(stored.sort().join(','), 'one,two', 'it stopped after the first row');
  });
});

test('a cut-off Drive listing removes only the files it proves are gone', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.files = [
      textFile('newest', 0),
      textFile('deleted', 1),
      textFile('edge', 2),
      textFile('older', 3),
    ];
    const first = { fetcher: google.fetcher, now: T0 };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, first), 'refreshed', 'full');
    // Google no longer has `deleted`, and the next listing stops after two files.
    google.files = google.files.filter((file) => file.id !== 'deleted');
    google.driveChanged = true;
    google.pageSize = 2;
    const cutOff = { fetcher: google.fetcher, now: later(5), driveMaxFiles: 2 };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, cutOff), 'refreshed', 'cut');
    const titles = (await rows(userId, GOOGLE_DRIVE_SOURCE)).map((row) => row.title).sort();
    equal(titles.join(','), 'edge.txt,newest.txt,older.txt', 'only the proven deletion is removed');
  });
});

test('an on-demand download does not overwrite a row a refresh changed meanwhile', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.files = Array.from({ length: DRIVE_INITIAL_CONTENT_FILES + 1 }, (_, index) =>
      textFile(`f${index}`, index)
    );
    for (const file of google.files) google.text.set(file.id, `text of ${file.id}`);
    await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    const unread = (await rows(userId, GOOGLE_DRIVE_SOURCE)).find((row) => row.content === '');
    assert(unread !== undefined, 'one file is beyond the up-front text budget');
    // A refresh renames the file while its text is being downloaded.
    google.onDownload = async () => {
      await prisma.userDataDocument.update({
        where: { id: unread.id },
        data: { title: 'renamed.txt', contentHash: 'written-by-refresh' },
      });
    };
    const loaded = await ensureDriveText(userId, [unread.id], { fetcher: google.fetcher });
    equal(loaded, 0, 'the stale write is dropped');
    const row = await prisma.userDataDocument.findUniqueOrThrow({ where: { id: unread.id } });
    equal(row.title, 'renamed.txt', 'the refresh keeps its rename');
    equal(row.contentHash, 'written-by-refresh', 'and its hash');
    equal(row.content, '', 'the text is fetched again when the file is next addressed');
  });
});

test('a refresh does not wipe text an on-demand download just stored', async () => {
  await withUser(async ({ userId, email }) => {
    const doc = (title: string): GoogleWorkspaceDocument => ({
      source: GOOGLE_DRIVE_SOURCE,
      googleAccountEmail: email,
      externalId: `${email}:notes`,
      title,
      content: '',
      metadata: {},
      contentHash: `hash-of-${title}`,
    });
    const apply = { userId, source: GOOGLE_DRIVE_SOURCE, accountEmail: email };
    await applyGoogleDocuments({ ...apply, documents: [doc('notes.txt')] });
    // What a refresh read before the on-demand download stored the text.
    const [before] = await rows(userId, GOOGLE_DRIVE_SOURCE);
    const readByRefresh = new Map([[before.externalId, before]]);
    await prisma.userDataDocument.update({
      where: { id: before.id },
      data: { content: 'downloaded text', contentHash: 'hash-with-text' },
    });
    const counts = await applyGoogleDocuments({
      ...apply,
      documents: [doc('renamed.txt')],
      stored: readByRefresh,
    });
    equal(counts.updated, 0, 'the refresh sees that its read is stale');
    const [after] = await rows(userId, GOOGLE_DRIVE_SOURCE);
    equal(after.content, 'downloaded text', 'the downloaded text survives');
  });
});

test('a refresh stopped by a disconnect removes the rows of that account', async () => {
  await withUser(async ({ userId }) => {
    const google = new FakeGoogle();
    google.files = [NOTES];
    google.text.set('notes', 'remember the lease');
    await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    equal((await rows(userId, GOOGLE_DRIVE_SOURCE)).length, 1, 'the file is stored');

    // The account is disconnected while the next refresh is talking to Google:
    // its credential goes, and the purge deletes the state row holding the lease.
    google.driveChanged = true;
    google.delayMs = 300;
    google.reset();
    const options = { fetcher: google.fetcher, now: later(5), leaseRenewMs: 0 };
    const refresh = ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, options);
    for (let attempt = 0; attempt < 200 && google.calls.length === 0; attempt += 1) await pause(10);
    await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
    await prisma.userDataProviderSyncState.deleteMany({ where: { userId } });
    equal(await refresh, 'in_progress', 'the refresh stops when its lease is gone');
    equal((await rows(userId, GOOGLE_DRIVE_SOURCE)).length, 0, 'and leaves no rows behind');
  });
});

test('a refresh that could not write a row lists again next time', async () => {
  await withUser(async ({ userId, email }) => {
    const google = new FakeGoogle();
    const lease = { ...LEASE, parents: ['root'] };
    google.files = [NOTES, lease];
    google.text.set('notes', 'remember the lease');
    google.text.set('lease', 'Lease ends December 31, 2026');
    await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    const cursor = async (): Promise<unknown> => {
      const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
        where: { userId_source: { userId, source: GOOGLE_DRIVE_SOURCE } },
      });
      return (state.cursor as { accounts: Record<string, { pageToken?: string }> }).accounts[email]
        .pageToken;
    };
    const before = await cursor();

    // The notes file is renamed and the lease edited. While the lease text is
    // downloading, something else rewrites the notes row.
    google.files = [
      { ...NOTES, name: 'renamed.txt' },
      { ...lease, modifiedTime: '2026-09-28T12:00:00.000Z' },
    ];
    google.driveChanged = true;
    google.onDownload = async () => {
      await prisma.userDataDocument.updateMany({
        where: { userId, title: 'notes.txt' },
        data: { contentHash: 'written-by-a-download' },
      });
    };
    const second = { fetcher: google.fetcher, now: later(5) };
    equal(await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, second), 'refreshed', 'run');
    equal(await cursor(), before, 'the cursor is kept, so the next refresh lists again');
  });
});

test('on-demand text reaches a document behind newer files that can never have text', async () => {
  await withUser(async ({ userId, email }) => {
    const google = new FakeGoogle();
    const scans: GoogleDriveFile[] = Array.from({ length: 12 }, (_, index) => ({
      ...SCAN,
      id: `scan${index}`,
      name: `scan-${index}.pdf`,
      parents: ['root'],
    }));
    google.files = [...scans, textFile('minutes', 60 * 24 * 30)];
    // Nothing can be downloaded yet, so the document starts as name and path only.
    await ensureGoogleSourceFresh(userId, GOOGLE_DRIVE_SOURCE, {
      fetcher: google.fetcher,
      now: T0,
    });
    google.text.set('minutes', 'minutes of the meeting');
    const unread = await findDriveRowsWithoutText(
      userId,
      GOOGLE_DRIVE_SOURCE,
      `${email}/My Drive`,
      ON_DEMAND_TEXT_CANDIDATES
    );
    const loaded = await ensureDriveText(userId, unread, { fetcher: google.fetcher });
    equal(loaded, 1, 'the document is found past the twelve newer PDFs');
  });
});

if (process.argv[1]?.includes('google-workspace-sync-lease')) {
  void runSuite('google workspace sync: leases and concurrent writes', tests);
}
