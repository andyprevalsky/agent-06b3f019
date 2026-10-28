/**
 * integration-accounts blackbox: each backend pipeline reports its sync
 * progress at its existing boundaries, on its existing Integration row, and the
 * bar reads the run's done/total/unit/state.
 *
 *   pipeline (test process) ─► reportProgressBestEffort ─► IntegrationSyncProgress
 *        ▼
 *   GET /api/integrations (backend) ─► row.accounts[0] / accountsByProvider
 *
 *   provider            unit          what done/total count
 *   gmail               messages      messages saved / the mailbox messagesTotal
 *   linkedin            bytes→records archive bytes received, then parsed records
 *   contacts            contacts      VCF contacts imported / parsed
 *   <browser>           cookies       cookies stored / uploaded (100-cookie batches);
 *                                     the Mac app's 5-minute re-upload of an already
 *                                     synced browser keeps reading synced (no 0-of-N bar)
 *   <source>_passwords  passwords     passwords stored / uploaded, per source row
 *   (plaid: integration-accounts.plaid.cases.ts; Mac pipelines: mac-app blackboxes)
 *
 *   gmail at Google's per-user quota wall (403 rateLimitExceeded) waits and
 *   retries: every wanted message is still saved and the historyId recorded;
 *   an access token that expires mid-sync is refreshed once and the run finishes.
 *
 * Registered by integration-accounts.blackbox.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { prisma } from '../../providers/database';
import { authRealmFromCookieDomain } from '../../providers/authRealm';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import { processCookiesUpload } from '../../domains/integrations/uploadService.browser';
import {
  processContactsUpload,
  processLinkedInUpload,
} from '../../domains/integrations/uploadService.contacts';
import {
  processApplePasswordsUpload,
  processPasswordsUpload,
} from '../../domains/integrations/uploadService.passwords';
import { runGmailSyncJob } from '../../services/integrations/gmailSync';
import { FakeGmail, fillMailbox } from './integration-accounts.gmail-fake';
import {
  anonymousSession,
  assert,
  defaultAccountOf,
  type Account,
  type Session,
} from './integration-accounts.support';

type User = () => Session;

function progressRow(userId: string, provider: string) {
  return prisma.integrationSyncProgress.findUniqueOrThrow({
    where: { userId_provider_accountId: { userId, provider, accountId: '' } },
  });
}

async function bar(session: Session, provider: string): Promise<Account> {
  const account = await defaultAccountOf(session.token, provider);
  assert(account !== undefined, `${provider}: its row is listed as one account`);
  return account;
}

/** The finished run: synced at 100% in `unit` with done = total (when known). */
async function expectSynced(session: Session, provider: string, unit: string, total: number) {
  const row = await progressRow(session.userId, provider);
  assert(row.state === 'synced', `${provider}: run synced, got ${row.state}`);
  assert(row.unit === unit, `${provider}: unit ${unit}, got ${row.unit}`);
  assert(
    row.total === BigInt(total) && row.done === BigInt(total),
    `${provider}: done = total = ${total}, got ${row.done}/${row.total}`
  );
  const account = await bar(session, provider);
  assert(account.state === 'synced', `${provider}: reads synced, got ${account.state}`);
  assert(account.progress?.pct === 100, `${provider}: 100%, got ${account.progress?.pct}`);
  assert(account.progress.unit === unit, `${provider}: bar unit ${unit}`);
}

function tempFile(name: string, contents: string | Buffer): string {
  const file = path.join(os.tmpdir(), `integration-progress-${randomUUID()}-${name}`);
  fs.writeFileSync(file, contents);
  return file;
}

async function gmailCredential(
  userId: string,
  address: string,
  token: string,
  refreshToken = 'refresh-token'
) {
  const row = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      config: { userEmail: address },
    },
  });
  await prisma.emailIntegrationCredential.create({
    data: {
      userId,
      integrationId: row.id,
      provider: 'GMAIL',
      email: address,
      accessToken: token,
      refreshToken,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      scopes: [...GOOGLE_OAUTH_SCOPES],
    },
  });
}

async function gmailSyncReportsMessagesSaved(user: User): Promise<void> {
  const session = user();
  const address = `owner.${randomUUID().slice(0, 8)}@example.com`;
  const gmail = new FakeGmail();
  const box = gmail.mailbox(address, 500, '9001');
  const { selected } = fillMailbox(box, { contacts: 3, perContact: 2, newsletters: 4, tag: 'p' });
  await gmailCredential(session.userId, address, box.token);
  const restore = gmail.install();
  try {
    await runGmailSyncJob({ userIds: [session.userId] });
  } finally {
    restore();
  }
  const row = await progressRow(session.userId, 'gmail');
  assert(row.state === 'synced', `gmail: run synced, got ${row.state} (${row.lastError})`);
  assert(row.unit === 'messages', `gmail: unit messages, got ${row.unit}`);
  assert(row.total === 500n, `gmail: total is the mailbox messagesTotal, got ${row.total}`);
  const saved = await prisma.messageRecord.count({ where: { person: { userId: session.userId } } });
  assert(
    saved === selected.length,
    `gmail: saved the ${selected.length} wanted messages, got ${saved}`
  );
  assert(row.done === BigInt(saved), `gmail: done = ${saved} messages saved, got ${row.done}`);
  const account = await bar(session, 'gmail');
  assert(account.state === 'synced' && account.progress?.pct === 100, 'gmail: synced bar');
  assert(account.label === address, 'gmail: labelled by its address');
}

async function gmailFailureEndsFailed(): Promise<void> {
  const session = await anonymousSession();
  try {
    const address = `broken.${randomUUID().slice(0, 8)}@example.com`;
    const gmail = new FakeGmail();
    const box = gmail.mailbox(address, 10, '1');
    box.listStatus = 403;
    await gmailCredential(session.userId, address, box.token);
    const restore = gmail.install();
    try {
      await runGmailSyncJob({ userIds: [session.userId] });
    } finally {
      restore();
    }
    const account = await bar(session, 'gmail');
    assert(account.state === 'sync_failed', `gmail: failed run, got ${account.state}`);
    assert(
      account.lastError === 'Gmail sync failed',
      `gmail: error shown, got ${account.lastError}`
    );
    const row = await progressRow(session.userId, 'gmail');
    assert(row.state === 'failed' && row.finishedAt !== null, 'gmail: the run is terminal');
  } finally {
    const where = { userId: session.userId };
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.emailIntegrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

/**
 * Google answers an over-quota mailbox with 403 rateLimitExceeded, not 429. The
 * sync must back off and finish with every wanted message -- never drop the
 * rejected ones or fail the run, which left the historyId unsaved and restarted
 * a 30k-message full sync every 5 minutes (prod, 2026-10-28).
 */
async function gmailQuotaWallStillSavesEverything(skip: number): Promise<void> {
  const session = await anonymousSession();
  try {
    const address = `quota.${randomUUID().slice(0, 8)}@example.com`;
    const gmail = new FakeGmail();
    const box = gmail.mailbox(address, 10, '4242');
    const { selected } = fillMailbox(box, { contacts: 3, perContact: 2, newsletters: 4, tag: 'q' });
    // Over quota for one second -- far shorter than Google's real minute window.
    box.quotaWall = { skip, forMs: 1_000 };
    await gmailCredential(session.userId, address, box.token);
    const restore = gmail.install();
    try {
      await runGmailSyncJob({ userIds: [session.userId] });
    } finally {
      restore();
    }
    assert(box.quotaRejected > 0, 'gmail: the sync ran into the quota wall');
    const row = await progressRow(session.userId, 'gmail');
    assert(row.state === 'synced', `gmail: run synced past the quota wall, got ${row.state}`);
    const saved = await prisma.messageRecord.count({
      where: { person: { userId: session.userId } },
    });
    assert(
      saved === selected.length,
      `gmail: saved all ${selected.length} wanted messages past the quota wall, got ${saved}`
    );
    const integration = await prisma.integration.findFirstOrThrow({
      where: { userId: session.userId, name: 'gmail' },
    });
    const historyIds = (integration.config as { historyIds?: Record<string, string> }).historyIds;
    assert(
      historyIds?.[address] === '4242',
      `gmail: historyId recorded, got ${historyIds?.[address]}`
    );
  } finally {
    const where = { userId: session.userId };
    await prisma.messageRecord.deleteMany({ where: { person: where } });
    await prisma.person.deleteMany({ where });
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.emailIntegrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

/**
 * A quota-paced full sync of a large mailbox outlives Google's one-hour access
 * token. When Google starts answering 401 mid-sync, the run refreshes the token
 * once and finishes with every wanted message on the same mailbox budget.
 */
async function gmailTokenExpiryMidSyncRefreshes(): Promise<void> {
  const session = await anonymousSession();
  try {
    const address = `expiry.${randomUUID().slice(0, 8)}@example.com`;
    const gmail = new FakeGmail();
    const box = gmail.mailbox(address, 10, '5151');
    const { selected } = fillMailbox(box, { contacts: 3, perContact: 2, newsletters: 4, tag: 'e' });
    // The token dies after the profile, list and a few metadata reads.
    box.tokenLifetimeRequests = 5;
    await gmailCredential(session.userId, address, box.token, box.refreshToken);
    const restore = gmail.install();
    try {
      await runGmailSyncJob({ userIds: [session.userId] });
    } finally {
      restore();
    }
    assert(box.refreshes === 1, `gmail: one token refresh for the run, got ${box.refreshes}`);
    const row = await progressRow(session.userId, 'gmail');
    assert(row.state === 'synced', `gmail: run synced past token expiry, got ${row.state}`);
    const saved = await prisma.messageRecord.count({
      where: { person: { userId: session.userId } },
    });
    assert(
      saved === selected.length,
      `gmail: saved all ${selected.length} wanted messages past token expiry, got ${saved}`
    );
  } finally {
    const where = { userId: session.userId };
    await prisma.messageRecord.deleteMany({ where: { person: where } });
    await prisma.person.deleteMany({ where });
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.emailIntegrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
}

/** A LinkedIn "Download your data" archive: the owner exchanged one message with each connection. */
function linkedinArchive(connections: number): Buffer {
  const owner = { first: 'Ada', last: 'Owner', url: 'https://www.linkedin.com/in/ada-owner' };
  const people = Array.from({ length: connections }, (_, i) => ({
    first: `Conn${i}`,
    last: 'Person',
    url: `https://www.linkedin.com/in/conn-${i}-${randomUUID().slice(0, 6)}`,
  }));
  const zip = new AdmZip();
  zip.addFile(
    'Connections.csv',
    Buffer.from(
      'Notes:\n"When exporting your connection data, you may notice missing emails."\n\n' +
        csv([
          [
            'First Name',
            'Last Name',
            'URL',
            'Email Address',
            'Company',
            'Position',
            'Connected On',
          ],
          ...people.map((p) => [p.first, p.last, p.url, '', 'Acme', 'Engineer', '01 Jan 2024']),
        ])
    )
  );
  const header = [
    'CONVERSATION ID',
    'CONVERSATION TITLE',
    'FROM',
    'SENDER PROFILE URL',
    'TO',
    'RECIPIENT PROFILE URLS',
    'DATE',
    'SUBJECT',
    'CONTENT',
    'FOLDER',
  ];
  const messages = people.flatMap((p, i) => [
    [
      `conv-${i}`,
      '',
      `${p.first} ${p.last}`,
      p.url,
      'Ada Owner',
      owner.url,
      '2026-10-01 10:00:00 UTC',
      '',
      `Hi from ${p.first}`,
      'INBOX',
    ],
    [
      `conv-${i}`,
      '',
      'Ada Owner',
      owner.url,
      `${p.first} ${p.last}`,
      p.url,
      '2026-10-01 11:00:00 UTC',
      '',
      `Hello ${p.first}`,
      'INBOX',
    ],
  ]);
  zip.addFile('messages.csv', Buffer.from(csv([header, ...messages])));
  zip.addFile(
    'Profile.csv',
    Buffer.from(
      csv([
        ['First Name', 'Last Name', 'Headline', 'Summary', 'Industry', 'Geo Location'],
        [owner.first, owner.last, 'Founder', '', 'Software', 'San Francisco'],
      ])
    )
  );
  return zip.toBuffer();
}

async function linkedinUploadReportsRecords(user: User): Promise<void> {
  const session = user();
  const file = tempFile('linkedin.zip', linkedinArchive(3));
  await processLinkedInUpload(session.userId, file, 'linkedin.zip');
  const row = await progressRow(session.userId, 'linkedin');
  assert(row.state === 'synced', `linkedin: run synced, got ${row.state}`);
  assert(
    row.phase === 'importing' && row.unit === 'records',
    'linkedin: ends in importing/records'
  );
  assert(
    row.total !== null && row.total > 0n,
    `linkedin: parsed records counted, got ${row.total}`
  );
  assert(row.done === row.total, `linkedin: done = parsed records, got ${row.done}/${row.total}`);
  const account = await bar(session, 'linkedin');
  assert(account.state === 'synced' && account.progress?.pct === 100, 'linkedin: synced bar');
}

async function linkedinCorruptArchiveEndsFailed(): Promise<void> {
  const session = await anonymousSession();
  try {
    const file = tempFile('broken.zip', 'definitely not a zip archive');
    let threw = false;
    try {
      await processLinkedInUpload(session.userId, file, 'broken.zip');
    } catch {
      threw = true;
    }
    assert(threw, 'linkedin: a corrupt archive still fails the upload');
    const row = await progressRow(session.userId, 'linkedin');
    assert(
      row.state === 'failed' && row.unit === 'bytes',
      'linkedin: failed after the bytes phase'
    );
    assert(row.done !== null && row.done > 0n, 'linkedin: the received bytes were reported');
    const account = await bar(session, 'linkedin');
    assert(account.state === 'sync_failed' && account.lastError !== null, 'linkedin: failed bar');
  } finally {
    const where = { userId: session.userId };
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

async function contactsUploadReportsContacts(user: User): Promise<void> {
  const session = user();
  const tag = randomUUID().slice(0, 6);
  const vcf = [0, 1, 2]
    .map(
      (i) =>
        `BEGIN:VCARD\nVERSION:3.0\nFN:Pat ${tag} ${i}\nN:${tag};Pat ${i};;;\nTEL;TYPE=CELL:+1555010${i}${tag.length}\nEMAIL:pat${i}.${tag}@example.com\nEND:VCARD`
    )
    .join('\n');
  const file = tempFile('contacts.vcf', vcf);
  await processContactsUpload(session.userId, file, 'contacts.vcf');
  await expectSynced(session, 'contacts', 'contacts', 3);
}

async function cookiesUploadReportsCookies(user: User): Promise<void> {
  const session = user();
  const cookies = Array.from({ length: 150 }, (_, i) => ({
    host_key: `.site${i}.example.com`,
    name: `sid${i}`,
    value: `value-${i}`,
    path: '/',
  }));
  await processCookiesUpload(session.userId, cookies, 'chrome');
  await expectSynced(session, 'chrome', 'cookies', 150);
}

function cookieSnapshot(count: number, tag: string) {
  return Array.from({ length: count }, (_, i) => ({
    host_key: `.s${i}.${tag}.example.com`,
    name: `sid${i}`,
    value: `value-${i}`,
    path: '/',
  }));
}

/** Resolves once `probe` is truthy; throws after `timeoutMs`. */
async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return poll();
  };
  return poll();
}

/**
 * Hold the CookieBundle row of `browser`'s first realm (inserted uncommitted on
 * a first sync) so a running upload parks in its snapshot pre-phase, the step
 * where Andy's unchanged 13,548-cookie re-upload sat for 117 s in prod. Returns
 * once the upload is parked on the row; `release()` lets it finish.
 */
async function parkUploadInPreface(userId: string, browser: string, domain: string) {
  const authRealm = authRealmFromCookieDomain(domain);
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held: (holderPid: number) => void = () => undefined;
  const holding = new Promise<number>((resolve) => (held = resolve));
  const tx = prisma.$transaction(
    async (t) => {
      await t.$executeRaw`
        INSERT INTO "CookieBundle" (id, "userId", "authRealm", "browserSource", "browserProfile", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${userId}, ${authRealm}, ${browser}, '', NOW(), NOW())
        ON CONFLICT ("userId", "authRealm", "browserSource", "browserProfile") DO UPDATE SET "updatedAt" = NOW()`;
      const [{ pid }] = await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      held(pid);
      await released;
    },
    { maxWait: 10_000, timeout: 60_000 }
  );
  const holderPid = await holding;
  return {
    /** The upload's CookieBundle write is blocked by this holder (its pre-phase is running). */
    parked: () =>
      waitUntil(`${browser} upload parked on its CookieBundle row`, async () => {
        const waiting = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
            AND query LIKE '%INSERT INTO "CookieBundle"%'`;
        return Number(waiting[0].n) > 0;
      }),
    release: async () => {
      release();
      await tx;
    },
  };
}

/** The account Rose shows while `upload` is parked mid-run, then the upload's outcome. */
async function accountWhileParked(
  session: Session,
  browser: string,
  cookies: Record<string, unknown>[]
): Promise<{ during: Account; outcome: PromiseSettledResult<unknown> }> {
  const hold = await parkUploadInPreface(session.userId, browser, String(cookies[0].host_key));
  const settled = Promise.allSettled([processCookiesUpload(session.userId, cookies, browser)]);
  const observe = async () => {
    await hold.parked();
    return bar(session, browser);
  };
  try {
    const during = await observe().finally(() => hold.release());
    const [outcome] = await settled;
    return { during, outcome };
  } finally {
    // A failed observation still releases the row; let the upload finish before cleanup.
    await settled;
  }
}

/**
 * Prod 2026-10-26: the Mac app re-uploads every connected browser's full cookie
 * set every 5 minutes (Andy's Chrome: 13,548 cookies, 0 new, 130 s per upload,
 * the first 117 s before any batch). Each re-upload reopened the bar at
 * "0 of 13,548 cookies" / 0%, which read as the synced cookies resetting to 0.
 */
async function cookieRefreshKeepsSyncedCount(user: User): Promise<void> {
  const session = user();
  const cookies = cookieSnapshot(120, 'refresh');
  await processCookiesUpload(session.userId, cookies, 'edge');
  await expectSynced(session, 'edge', 'cookies', 120);
  const first = await progressRow(session.userId, 'edge');

  const { during, outcome } = await accountWhileParked(session, 'edge', cookies);
  assert(outcome.status === 'fulfilled', 'edge: the unchanged re-upload succeeds');
  assert(
    during.state === 'synced' && during.progress?.pct === 100 && during.progress.done === 120,
    'edge: while an unchanged re-upload of a synced browser runs, it keeps reading synced ' +
      `120 of 120 cookies, got ${during.state} ${during.progress?.done ?? null} of ` +
      `${during.progress?.total ?? null} (${during.progress?.pct ?? null}%)`
  );
  await expectSynced(session, 'edge', 'cookies', 120);
  const after = await progressRow(session.userId, 'edge');
  assert(after.runId !== first.runId, 'edge: the re-upload records its own finished run');
}

/** A browser's first upload still shows its bar while it runs. */
async function firstCookieUploadShowsBar(user: User): Promise<void> {
  const session = user();
  const { during, outcome } = await accountWhileParked(
    session,
    'brave',
    cookieSnapshot(120, 'first')
  );
  assert(outcome.status === 'fulfilled', 'brave: the first upload succeeds');
  assert(
    during.state === 'syncing' && during.progress?.total === 120 && during.progress.done === 0,
    `brave: a first upload reads syncing 0 of 120 cookies while it runs, got ${during.state} ` +
      `${during.progress?.done ?? null} of ${during.progress?.total ?? null}`
  );
  await expectSynced(session, 'brave', 'cookies', 120);
}

/** A re-upload of a synced browser that fails still ends the account sync_failed. */
async function failedCookieRefreshEndsFailed(user: User): Promise<void> {
  const session = user();
  const cookies = cookieSnapshot(30, 'refail');
  await processCookiesUpload(session.userId, cookies, 'vivaldi');
  await expectSynced(session, 'vivaldi', 'cookies', 30);
  const broken = [...cookies.slice(1), { ...cookies[0], expires_utc: 'not-a-number' }];
  const [outcome] = await Promise.allSettled([
    processCookiesUpload(session.userId, broken, 'vivaldi'),
  ]);
  assert(outcome.status === 'rejected', 'vivaldi: an unstorable cookie fails the re-upload');
  const row = await progressRow(session.userId, 'vivaldi');
  assert(row.state === 'failed', `vivaldi: the failed re-upload is stored, got ${row.state}`);
  const account = await bar(session, 'vivaldi');
  assert(account.state === 'sync_failed', `vivaldi: reads sync_failed, got ${account.state}`);
  assert(account.lastError !== null, 'vivaldi: the failure reason is shown');
}

async function passwordUploadsReportPerSourceRow(user: User): Promise<void> {
  const session = user();
  const entry = (origin: string, browserSource: string) => ({
    origin,
    username: 'ada',
    encryptedPassword: 'enc-not-read-by-this-test',
    dateLastUsed: Date.now(),
    dateCreated: Date.now(),
    browserSource,
  });
  await processPasswordsUpload(session.userId, {
    passwords: [
      entry('https://a.example.com', 'chrome'),
      entry('https://b.example.com', 'chrome'),
      entry('https://c.example.com', 'safari'),
    ],
  });
  await expectSynced(session, 'chrome_passwords', 'passwords', 2);
  await expectSynced(session, 'safari_passwords', 'passwords', 1);
  const appleCsv = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    'Example,https://d.example.com,ada,pw1,,',
    'Other,https://e.example.com,ada,pw2,,',
  ].join('\n');
  await processApplePasswordsUpload(session.userId, appleCsv);
  await expectSynced(session, 'apple_passwords', 'passwords', 2);
  const apple = await bar(session, 'apple_passwords');
  assert(apple.label === 'Apple Passwords', `apple_passwords label, got ${apple.label}`);
}

export function cases(user: User): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'Gmail sync: messages saved of messagesTotal, ends synced',
      fn: () => gmailSyncReportsMessagesSaved(user),
    },
    { name: 'Gmail sync: a failed address ends the run sync_failed', fn: gmailFailureEndsFailed },
    {
      name: 'Gmail sync: 403 rateLimitExceeded on the profile read is retried, nothing dropped',
      fn: () => gmailQuotaWallStillSavesEverything(0),
    },
    {
      name: 'Gmail sync: 403 rateLimitExceeded on metadata reads is retried, nothing dropped',
      // the profile passes, then the wall rejects the metadata reads
      fn: () => gmailQuotaWallStillSavesEverything(1),
    },
    {
      name: 'Gmail sync: 403 rateLimitExceeded batch sub-requests are re-fetched, nothing dropped',
      // profile + 10 metadata pass, then the wall rejects the full-content batch
      fn: () => gmailQuotaWallStillSavesEverything(11),
    },
    {
      name: 'Gmail sync: an access token that expires mid-sync is refreshed once, nothing dropped',
      fn: gmailTokenExpiryMidSyncRefreshes,
    },
    {
      name: 'LinkedIn upload: bytes received, then parsed records, ends synced',
      fn: () => linkedinUploadReportsRecords(user),
    },
    {
      name: 'LinkedIn upload: a corrupt archive ends the run sync_failed',
      fn: linkedinCorruptArchiveEndsFailed,
    },
    {
      name: 'VCF contacts upload: contacts imported of parsed, ends synced',
      fn: () => contactsUploadReportsContacts(user),
    },
    {
      name: 'cookie upload: cookies stored of uploaded, ends synced',
      fn: () => cookiesUploadReportsCookies(user),
    },
    {
      name: 'cookie re-upload of a synced browser keeps reading synced (no 0-of-N bar)',
      fn: () => cookieRefreshKeepsSyncedCount(user),
    },
    {
      name: 'cookie first upload: the bar reads syncing 0 of N while it runs',
      fn: () => firstCookieUploadShowsBar(user),
    },
    {
      name: 'cookie re-upload of a synced browser that fails ends sync_failed',
      fn: () => failedCookieRefreshEndsFailed(user),
    },
    {
      name: 'password uploads: one run per source row, ends synced',
      fn: () => passwordUploadsReportPerSourceRow(user),
    },
  ];
}
