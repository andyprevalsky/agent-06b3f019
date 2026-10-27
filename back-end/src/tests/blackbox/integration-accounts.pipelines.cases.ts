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
 *   <browser>           cookies       cookies stored / uploaded (100-cookie batches)
 *   <source>_passwords  passwords     passwords stored / uploaded, per source row
 *   (plaid: integration-accounts.plaid.cases.ts; Mac pipelines: mac-app blackboxes)
 *
 * Registered by integration-accounts.blackbox.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import AdmZip from 'adm-zip';
import { prisma } from '../../providers/database';
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

async function gmailCredential(userId: string, address: string, token: string) {
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
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() + 60 * 60_000),
      scopes: [...GOOGLE_OAUTH_SCOPES],
    },
  });
}

/** The native scheduler scans every tenant. Confine this test process's
 * candidate query to its fixture owner; all eligibility predicates and real
 * database reads/writes remain in force. Restore the seam after the job joins.
 */
async function runFixtureGmailSync(userId: string): Promise<void> {
  const findMany = prisma.integration.findMany;
  prisma.integration.findMany = ((args: Prisma.IntegrationFindManyArgs = {}) =>
    findMany({ ...args, where: { AND: [args.where ?? {}, { userId }] } })) as typeof findMany;
  try {
    await runGmailSyncJob();
  } finally {
    prisma.integration.findMany = findMany;
  }
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
    await runFixtureGmailSync(session.userId);
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
      await runFixtureGmailSync(session.userId);
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
      name: 'password uploads: one run per source row, ends synced',
      fn: () => passwordUploadsReportPerSourceRow(user),
    },
  ];
}
