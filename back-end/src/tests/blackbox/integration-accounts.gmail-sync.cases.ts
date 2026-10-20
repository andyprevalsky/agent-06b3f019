/**
 * integration-accounts blackbox, plan row I3: Gmail sync progress per address.
 *
 * Runs the real cron entry point (runGmailSyncJob, scoped to the case's user)
 * against Gmail faked at the fetch boundary, and reads the result through the
 * same GET /api/integrations the UI polls.
 *
 *   - a full sync reports `syncing` with total = profile messagesTotal, `done`
 *     rising per SAVED batch (the batch is in the DB before its progress write),
 *     then `synced`
 *   - two addresses on one row progress independently; one failing leaves the
 *     other `synced`, and the row's SYNCING lease never marks a queued address
 *   - an interrupted sync keeps its saved batches; the next run resumes from the
 *     cursor, never re-fetches a saved message and inserts no duplicates
 *   - an unknown total (profile outage) stays `total: null`, never a guess
 *   - an incremental (history) sync adds only new mail, idempotently
 *   - disconnecting an address drops its history cursor and a late progress
 *     write cannot resurrect it; the cron and an OAuth connect claim a row once
 *
 * Registered by integration-accounts.blackbox.ts.
 */
import { prisma } from '../../providers/database';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import { reportIntegrationProgress } from '../../domains/integrations/service.progress';
import { runGmailSyncJob, syncGmailIntegrationNow } from '../../services/integrations/gmailSync';
import type { GmailProgressEvent } from '../../services/integrations/gmailSync.progress';
import { FakeGmail, fillMailbox, type FakeMailbox } from './integration-accounts.gmail-fake';
import {
  accountsOf,
  anonymousSession,
  assert,
  call,
  type Session,
} from './integration-accounts.support';

interface Scenario {
  session: Session;
  integrationId: string;
  fake: FakeGmail;
  events: GmailProgressEvent[];
}

/** A clock that moves 1.5 s per read, so no syncing write is coalesced away. */
function steppingClock(): () => Date {
  let t = Date.now();
  return () => {
    t += 1_500;
    return new Date(t);
  };
}

async function scenario(boxes: Array<{ address: string; box: FakeMailbox }>, fake: FakeGmail) {
  const session = await anonymousSession();
  const integration = await prisma.integration.create({
    data: {
      userId: session.userId,
      name: 'gmail',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      config: { provider: 'gmail', userEmail: boxes[0].address },
    },
  });
  for (const { address, box } of boxes) {
    await prisma.emailIntegrationCredential.create({
      data: {
        userId: session.userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: address,
        accessToken: box.token,
        refreshToken: 'refresh-not-used',
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: [...GOOGLE_OAUTH_SCOPES],
      },
    });
  }
  return { session, integrationId: integration.id, fake, events: [] } as Scenario;
}

async function runJob(s: Scenario, onEvent?: (e: GmailProgressEvent) => Promise<void>) {
  await runGmailSyncJob({
    userIds: [s.session.userId],
    deps: {
      fetcher: s.fake.fetcher,
      now: steppingClock(),
      onProgress: async (event) => {
        s.events.push(event);
        await onEvent?.(event);
      },
    },
  });
}

const storedFor = (userId: string, address: string) =>
  prisma.messageRecord.count({ where: { person: { userId }, googleAccountEmail: address } });

async function distinctExternalIds(userId: string, address: string): Promise<number> {
  const rows = await prisma.messageRecord.findMany({
    where: { person: { userId }, googleAccountEmail: address },
    select: { externalId: true },
    distinct: ['externalId'],
  });
  return rows.filter((r) => r.externalId !== null).length;
}

async function historyIdOf(integrationId: string, address: string): Promise<string | undefined> {
  const row = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  return (row.config as { historyIds?: Record<string, string> }).historyIds?.[address];
}

async function cursorOf(userId: string, address: string): Promise<unknown> {
  const credential = await prisma.emailIntegrationCredential.findFirstOrThrow({
    where: { userId, email: address },
  });
  return (credential.metadata as Record<string, unknown> | null)?.gmailFullSync;
}

async function cleanup(s: Scenario): Promise<void> {
  const where = { userId: s.session.userId };
  await prisma.integrationSyncProgress.deleteMany({ where });
  await prisma.person.deleteMany({ where });
  await prisma.emailIntegrationCredential.deleteMany({ where });
  await prisma.integration.deleteMany({ where });
}

const of = (s: Scenario, address: string) => s.events.filter((e) => e.accountId === address);

async function fullSyncSavesPerBatch(): Promise<void> {
  const fake = new FakeGmail();
  const address = `full.${Date.now()}@gmail.com`;
  const box = fake.mailbox(address, 437, '5001');
  const { selected } = fillMailbox(box, {
    contacts: 26,
    perContact: 10,
    newsletters: 140,
    tag: 'f',
  });
  const s = await scenario([{ address, box }], fake);
  const storedAtSave: number[] = [];
  try {
    await runJob(s, async (event) => {
      if (event.input.phase === 'saving' && event.input.state === 'syncing') {
        storedAtSave.push(await storedFor(s.session.userId, address));
      }
    });
    const events = of(s, address);
    const first = events[0];
    assert(first.input.state === 'syncing' && first.input.phase === 'scanning', 'starts scanning');
    assert(
      first.input.total === 437,
      `total is the profile messagesTotal, got ${first.input.total}`
    );
    assert(first.outcome?.applied === true, 'the first progress write is stored');
    const saving = events.filter((e) => e.input.phase === 'saving' && e.input.state === 'syncing');
    const done = saving.map((e) => e.input.done);
    assert(
      JSON.stringify(done) === JSON.stringify([140, 240, 340, 400]),
      `done rises once per saved batch (140 skipped, then 100/100/60 saved), got ${JSON.stringify(done)}`
    );
    assert(
      saving.every((e) => e.outcome?.applied === true),
      'every batch write is applied'
    );
    assert(
      saving.every((e) => e.outcome?.snapshot.progress.total === 437),
      'the stored total stays the profile messagesTotal'
    );
    assert(
      JSON.stringify(storedAtSave) === JSON.stringify([0, 100, 200, 260]),
      `each batch is saved before its progress write, got ${JSON.stringify(storedAtSave)}`
    );
    const last = events[events.length - 1];
    assert(last.input.state === 'synced' && last.outcome?.applied === true, 'ends synced');
    assert(new Set(events.map((e) => e.input.runId)).size === 1, 'one runId for the whole run');
    const seqs = events.map((e) => e.input.seq ?? 0);
    assert(
      seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]),
      'seq rises per write'
    );

    const account = (await accountsOf(s.session.token, 'gmail')).find(
      (a) => a.accountId === address
    );
    assert(account?.state === 'synced', `address reads synced, got ${account?.state}`);
    assert(account.progress.pct === 100 && account.progress.total === 437, 'synced at 100% of 437');
    assert(
      account.progress.unit === 'messages' && account.lastSyncAt !== null,
      'unit + lastSyncAt'
    );
    assert((await storedFor(s.session.userId, address)) === selected.length, 'all selected saved');
    assert(
      (await distinctExternalIds(s.session.userId, address)) === selected.length,
      'every saved message carries its own Gmail dedup key'
    );
    assert((await historyIdOf(s.integrationId, address)) === '5001', 'history cursor stored');
    assert((await cursorOf(s.session.userId, address)) === undefined, 'resume cursor cleared');
    const person = await prisma.person.findFirstOrThrow({
      where: { userId: s.session.userId, email: `contact0.f@example.com` },
    });
    assert(person.messagesExchanged === 10, `stats span batches, got ${person.messagesExchanged}`);

    // Incremental: two new replies plus one already-saved id in the history page.
    const [newer1, newer2] = ['f-new-1', 'f-new-2'];
    for (const id of [newer1, newer2]) {
      box.messages.push({
        id,
        internalDate: Date.UTC(2026, 9, 2),
        from: 'Contact 0 <contact0.f@example.com>',
        to: [address],
        subject: 'follow up',
        body: 'new',
        sent: false,
      });
    }
    box.history.set('5001', { added: [newer1, newer2, selected[0]], newHistoryId: '5009' });
    s.events = [];
    await runJob(s);
    assert(
      (await storedFor(s.session.userId, address)) === selected.length + 2,
      'history adds exactly the two new messages'
    );
    assert((await historyIdOf(s.integrationId, address)) === '5009', 'history cursor advances');
    const incremental = of(s, address);
    assert(incremental[0].input.phase === 'history', 'an incremental run reports its own phase');
    assert(incremental[incremental.length - 1].input.state === 'synced', 'incremental ends synced');
  } finally {
    await cleanup(s);
  }
}

async function addressesProgressIndependently(): Promise<void> {
  const fake = new FakeGmail();
  const tag = Date.now();
  const [work, home] = [`work.${tag}@gmail.com`, `home.${tag}@gmail.com`];
  const workBox = fake.mailbox(work, 90, '7001');
  const homeBox = fake.mailbox(home, 55, '8001');
  fillMailbox(workBox, { contacts: 3, perContact: 5, newsletters: 10, tag: 'w' });
  fillMailbox(homeBox, { contacts: 2, perContact: 5, newsletters: 5, tag: 'h' });
  homeBox.listStatus = 400;
  const s = await scenario(
    [
      { address: work, box: workBox },
      { address: home, box: homeBox },
    ],
    fake
  );
  let homeWhileWorkSyncing: string | undefined;
  try {
    await runJob(s, async (event) => {
      if (event.accountId === work && homeWhileWorkSyncing === undefined) {
        const accounts = await accountsOf(s.session.token, 'gmail');
        homeWhileWorkSyncing = accounts.find((a) => a.accountId === home)?.state;
      }
    });
    assert(
      homeWhileWorkSyncing === 'idle',
      `a queued address is not syncing while another one syncs, got ${homeWhileWorkSyncing}`
    );
    const workEvents = of(s, work);
    const homeEvents = of(s, home);
    assert(workEvents[0].input.total === 90 && homeEvents[0].input.total === 55, 'own totals');
    assert(workEvents[0].input.runId !== homeEvents[0].input.runId, 'one run per address');
    const accounts = await accountsOf(s.session.token, 'gmail');
    const byId = new Map(accounts.map((a) => [a.accountId, a]));
    assert(byId.get(work)?.state === 'synced', `work synced, got ${byId.get(work)?.state}`);
    assert(byId.get(home)?.state === 'failed', `home failed, got ${byId.get(home)?.state}`);
    assert(byId.get(home)?.lastError === 'Gmail sync failed', 'the failure reason is per address');
    assert(byId.get(work)?.lastError === null, 'the healthy address carries no error');
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: s.integrationId } });
    assert(row.status === 'SYNC_FAILED', 'the shared row still records that a sync failed');
    assert((await storedFor(s.session.userId, home)) === 0, 'nothing saved for the failed address');
    assert((await storedFor(s.session.userId, work)) === 15, 'the healthy address saved its mail');
  } finally {
    await cleanup(s);
  }
}

async function interruptedSyncResumes(): Promise<void> {
  const fake = new FakeGmail();
  const address = `resume.${Date.now()}@gmail.com`;
  const box = fake.mailbox(address, 400, '6001');
  const { selected } = fillMailbox(box, {
    contacts: 26,
    perContact: 10,
    newsletters: 140,
    tag: 'r',
  });
  box.failBatchCall = 2;
  const s = await scenario([{ address, box }], fake);
  try {
    await runJob(s);
    assert((await storedFor(s.session.userId, address)) === 100, 'the first batch stays saved');
    const failed = (await accountsOf(s.session.token, 'gmail')).find(
      (a) => a.accountId === address
    );
    assert(failed?.state === 'failed', `the interrupted run reads failed, got ${failed?.state}`);
    assert((await cursorOf(s.session.userId, address)) !== undefined, 'the resume cursor is kept');
    assert((await historyIdOf(s.integrationId, address)) === undefined, 'no history cursor yet');
    const savedFirst = new Set(box.fullFetched);
    assert(savedFirst.size === 100, `run 1 fetched one batch, got ${savedFirst.size}`);

    box.failBatchCall = null;
    box.historyId = '6999';
    box.fullFetched = [];
    s.events = [];
    await runJob(s);
    const refetched = box.fullFetched.filter((id) => savedFirst.has(id));
    assert(refetched.length === 0, `the resume never re-fetches saved mail (${refetched.length})`);
    assert(box.fullFetched.length === selected.length - 100, 'it fetches exactly the remainder');
    assert((await storedFor(s.session.userId, address)) === selected.length, 'all mail saved');
    assert(
      (await distinctExternalIds(s.session.userId, address)) === selected.length,
      'no duplicates across the interrupted and the resumed run'
    );
    const saving = of(s, address).filter((e) => e.input.phase === 'saving');
    assert(
      saving[0].input.done === 240,
      `resume starts at 240 settled, got ${saving[0].input.done}`
    );
    assert(
      (await historyIdOf(s.integrationId, address)) === '6001',
      'the history cursor is the ORIGINAL start, so mail that arrived meanwhile is not skipped'
    );
    const done = (await accountsOf(s.session.token, 'gmail')).find((a) => a.accountId === address);
    assert(done?.state === 'synced', `the resumed run ends synced, got ${done?.state}`);
    assert((await cursorOf(s.session.userId, address)) === undefined, 'cursor cleared');
  } finally {
    await cleanup(s);
  }
}

async function unknownTotalStaysNull(): Promise<void> {
  const fake = new FakeGmail();
  const address = `unknown.${Date.now()}@gmail.com`;
  const box = fake.mailbox(address, 999, '4001');
  fillMailbox(box, { contacts: 12, perContact: 10, newsletters: 30, tag: 'u' });
  box.profileFailures = 1;
  const s = await scenario([{ address, box }], fake);
  try {
    await runJob(s);
    const syncing = of(s, address).filter((e) => e.input.state === 'syncing');
    assert(syncing.length >= 3, `progress was reported, got ${syncing.length}`);
    assert(
      syncing.every((e) => e.input.total === null),
      'without a profile the total is reported as null'
    );
    assert(
      syncing.every(
        (e) =>
          e.outcome?.snapshot.progress.total === null && e.outcome.snapshot.progress.pct === null
      ),
      'the stored progress stays indeterminate: no total and no pct are invented'
    );
    assert(
      syncing.some((e) => e.input.phase === 'saving' && (e.input.done ?? 0) > 0),
      'done counts are still reported'
    );
    const account = (await accountsOf(s.session.token, 'gmail')).find(
      (a) => a.accountId === address
    );
    assert(account?.state === 'synced', `ends synced, got ${account?.state}`);
    assert(account.progress.total === null, 'a synced run with an unknown total keeps it null');
    assert(
      (await historyIdOf(s.integrationId, address)) === '4001',
      'history from a later profile'
    );
  } finally {
    await cleanup(s);
  }
}

async function disconnectDropsHistoryCursor(): Promise<void> {
  const fake = new FakeGmail();
  const address = `gone.${Date.now()}@gmail.com`;
  const box = fake.mailbox(address, 30, '3001');
  fillMailbox(box, { contacts: 2, perContact: 5, newsletters: 10, tag: 'g' });
  const s = await scenario([{ address, box }], fake);
  try {
    await runJob(s);
    assert((await historyIdOf(s.integrationId, address)) === '3001', 'synced once');
    const del = await call(`/api/integrations/gmail/accounts/${encodeURIComponent(address)}`, {
      method: 'DELETE',
      auth: s.session.token,
    });
    assert(del.status === 200, `delete the address, got ${del.status}`);
    assert(
      (await historyIdOf(s.integrationId, address)) === undefined,
      'reconnecting the address must run a full sync, not resume history of purged mail'
    );
    // A sync that was mid-write when the address went away reports late.
    await reportIntegrationProgress({
      userId: s.session.userId,
      provider: 'gmail',
      accountId: address,
      input: { runId: 'late-run', state: 'syncing', done: 1, total: 30 },
    });
    const listed = (await accountsOf(s.session.token, 'gmail')).map((a) => a.accountId);
    assert(!listed.includes(address), `a late write does not resurrect the address: ${listed}`);
  } finally {
    await cleanup(s);
  }
}

async function claimedRowSyncsOnce(): Promise<void> {
  const fake = new FakeGmail();
  const address = `claim.${Date.now()}@gmail.com`;
  const box = fake.mailbox(address, 30, '2001');
  fillMailbox(box, { contacts: 2, perContact: 5, newsletters: 10, tag: 'c' });
  const s = await scenario([{ address, box }], fake);
  const deps = { fetcher: fake.fetcher, now: steppingClock() };
  try {
    await prisma.integration.update({
      where: { id: s.integrationId },
      data: { status: 'SYNCING', lastSyncAt: new Date() },
    });
    assert(!(await syncGmailIntegrationNow(s.integrationId, { deps })), 'a live lease is held');
    await runJob(s);
    assert(s.events.length === 0 && box.batchCalls === 0, 'the cron leaves a leased row alone');

    await prisma.integration.update({
      where: { id: s.integrationId },
      data: { status: 'CONNECTED' },
    });
    const [, now] = await Promise.all([
      runJob(s),
      syncGmailIntegrationNow(s.integrationId, {
        deps: { ...deps, onProgress: (event) => void s.events.push(event) },
      }),
    ]);
    const runs = new Set(of(s, address).map((e) => e.input.runId));
    assert(
      runs.size === 1,
      `the cron and an OAuth-triggered sync claim the row once, got ${runs.size}`
    );
    assert(typeof now === 'boolean', 'the direct sync reports whether it claimed the row');
    assert((await storedFor(s.session.userId, address)) === 10, 'mail saved exactly once');
  } finally {
    await cleanup(s);
  }
}

export function gmailSyncCases(): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'Gmail full sync: messagesTotal, per-batch save + progress',
      fn: fullSyncSavesPerBatch,
    },
    {
      name: 'Gmail addresses progress independently; one failure keeps the other synced',
      fn: addressesProgressIndependently,
    },
    { name: 'Gmail interrupted full sync resumes from its cursor', fn: interruptedSyncResumes },
    { name: 'Gmail unknown total stays null, never guessed', fn: unknownTotalStaysNull },
    {
      name: 'Gmail disconnect drops the history cursor; late progress cannot resurrect it',
      fn: disconnectDropsHistoryCursor,
    },
    { name: 'Gmail sync claims a row once (cron vs OAuth connect)', fn: claimedRowSyncsOnce },
  ];
}
