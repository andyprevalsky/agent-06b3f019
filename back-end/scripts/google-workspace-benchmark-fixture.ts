/**
 * Frozen Google Calendar and Drive data for the `google-calendar-day-recall`
 * and `google-drive-lease-recall` benchmarks (db fixture
 * `google_workspace_benchmark_v1`).
 *
 * The rows are built by the same mappers the live sync uses, so an agent sees
 * exactly what a synced account looks like. The sync state is written as fresh
 * far into the future: these rows are the whole truth for the run and no search
 * may call Google, which a benchmark stack cannot authenticate to anyway.
 *
 * Usage: DATABASE_URL=<local> BENCHMARK_USER_ID=<id> npx tsx scripts/google-workspace-benchmark-fixture.ts apply|cleanup|summary
 */

import { EmailProvider, IntegrationStatus, IntegrationType } from '@prisma/client';
import dotenv from 'dotenv';
import { GOOGLE_OAUTH_SCOPES } from '../src/domains/integrations/googleScopes';
import { prisma } from '../src/providers/database';
import {
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_DRIVE_SOURCE,
  GOOGLE_WORKSPACE_SOURCES,
  calendarEventToDocument,
  driveFileToDocument,
  driveFolderPaths,
  type GoogleCalendarEvent,
  type GoogleDriveFile,
  type GoogleWorkspaceDocument,
} from '../src/services/integrations/googleWorkspaceDocuments';
import { applyGoogleDocuments } from '../src/services/integrations/googleWorkspaceSync';

dotenv.config();

const USER_ID = process.env.BENCHMARK_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const ACCOUNT = 'rose.benchmark@example.com';
const FOLDER = 'application/vnd.google-apps.folder';
const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
/** Later than any run, so a search never decides the frozen rows are stale. */
const FROZEN_UNTIL = new Date('2099-01-01T00:00:00.000Z');

interface Manifest {
  fixture: 'google_workspace_benchmark_v1';
  user_id: string;
  account: string;
  event_count: number;
  file_count: number;
  calendar_day: string;
  calendar_day_events: string[];
  lease_path: string;
}

function timed(
  id: string,
  summary: string,
  start: string,
  end: string,
  extra: Partial<GoogleCalendarEvent> = {}
): GoogleCalendarEvent {
  return {
    id,
    status: 'confirmed',
    summary,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    updated: '2027-02-20T18:00:00.000Z',
    start: { dateTime: start, timeZone: 'America/Los_Angeles' },
    end: { dateTime: end, timeZone: 'America/Los_Angeles' },
    organizer: { email: ACCOUNT },
    ...extra,
  };
}

const CALENDAR_DAY = '2027-03-12';

const EVENTS: GoogleCalendarEvent[] = [
  timed(
    'bench-vendor-demo',
    'Vendor demo: Lumen Analytics',
    '2027-03-11T14:00:00-08:00',
    '2027-03-11T15:00:00-08:00',
    { hangoutLink: 'https://meet.google.com/lum-enan-demo' }
  ),
  timed(
    'bench-roadmap-review',
    'Quarterly roadmap review',
    '2027-03-12T09:30:00-08:00',
    '2027-03-12T10:15:00-08:00',
    {
      location: 'Conference Room Ada',
      description: 'Agenda:\n1. Q1 results\n2. Hiring plan\n3. Launch date for the mobile app',
      attendees: [
        { email: 'priya.raman@example.com', responseStatus: 'accepted' },
        { email: 'marcus.lee@example.com', responseStatus: 'tentative' },
      ],
    }
  ),
  timed(
    'bench-lunch-priya',
    'Lunch with Priya Raman',
    '2027-03-12T12:00:00-08:00',
    '2027-03-12T13:00:00-08:00',
    { location: 'Tartine Manufactory, 595 Alabama St, San Francisco' }
  ),
  timed(
    'bench-dentist',
    'Dentist — Dr. Okafor',
    '2027-03-12T15:30:00-08:00',
    '2027-03-12T16:00:00-08:00',
    { location: '450 Sutter St, Suite 1210, San Francisco' }
  ),
  {
    id: 'bench-offsite',
    status: 'confirmed',
    summary: 'Offsite in Austin',
    htmlLink: 'https://www.google.com/calendar/event?eid=bench-offsite',
    updated: '2027-02-18T17:00:00.000Z',
    // Google's all-day end date is exclusive: this covers March 13 and 14.
    start: { date: '2027-03-13' },
    end: { date: '2027-03-15' },
    organizer: { email: ACCOUNT },
  },
  timed(
    'bench-marcus-1on1',
    '1:1 with Marcus Lee',
    '2027-03-15T10:00:00-07:00',
    '2027-03-15T10:30:00-07:00'
  ),
];

function clause(number: number, title: string, lines: string[]): string {
  return [`${number}. ${title.toUpperCase()}`, ...lines, ''].join('\n');
}

/** The facts the benchmark asks for sit in different sections, not at the top. */
const CURRENT_LEASE = [
  'RESIDENTIAL LEASE AGREEMENT',
  '',
  'Premises: 412 Juniper Lane, Unit 3B, Oakland, CA 94610',
  'Landlord: Fernwood Property Group LLC',
  'Tenant: Jordan Avery',
  '',
  clause(1, 'Term', [
    'The lease term begins on September 1, 2026 and ends on August 31, 2027.',
    'Possession is delivered at 9:00 AM on the first day of the term.',
  ]),
  clause(2, 'Rent', [
    'Monthly rent is $3,450, due on the 1st of each month.',
    'Rent received after the 5th of the month incurs a late fee of $75.',
    'Rent is payable by bank transfer to the account the Landlord designates in writing.',
  ]),
  clause(3, 'Security deposit', [
    'The security deposit is $5,175, held for the full term.',
    'The Landlord returns the deposit, less itemized deductions, within 21 days of move-out.',
  ]),
  clause(4, 'Utilities', [
    'The Tenant pays electricity, gas, and internet.',
    'The Landlord pays water, sewer, and trash collection.',
  ]),
  clause(5, 'Use of premises', [
    'The premises are for residential use by the Tenant only.',
    'No more than two adults may occupy the unit without written consent.',
  ]),
  clause(6, 'Maintenance and repairs', [
    'The Tenant keeps the unit clean and reports defects promptly.',
    'The Landlord repairs plumbing, heating, and electrical faults within a reasonable time.',
    'Emergency repairs may be requested at any hour through the building manager.',
  ]),
  clause(7, 'Alterations', [
    'The Tenant may not paint or make structural changes without written consent.',
    'Picture hooks and removable shelving are permitted.',
  ]),
  clause(8, 'Pets', [
    'One cat is permitted with a refundable pet deposit of $500.',
    'Dogs are not permitted.',
  ]),
  clause(9, 'Entry by landlord', [
    'The Landlord gives at least 24 hours written notice before entering, except in an emergency.',
  ]),
  clause(10, 'Subletting', [
    'The Tenant may not sublet or assign this lease without written consent.',
  ]),
  clause(11, 'Insurance', [
    "The Tenant maintains renter's insurance with at least $100,000 of liability coverage.",
  ]),
  clause(12, 'Notice to vacate', [
    "The Tenant must give at least 60 days' written notice before moving out.",
    'Notice is delivered by email to the property manager and by certified mail.',
  ]),
  clause(13, 'Renewal', [
    'Absent notice from either party, the lease converts to month-to-month at the end of the term.',
  ]),
  'Signed: Jordan Avery (Tenant), Dana Whitfield for Fernwood Property Group LLC (Landlord)',
].join('\n');

const EXPIRED_LEASE = [
  'RESIDENTIAL LEASE AGREEMENT (EXPIRED)',
  '',
  'Premises: 27 Alder Court, Apt 5, Berkeley, CA 94704',
  'Tenant: Jordan Avery',
  '',
  clause(1, 'Term', ['The lease term began on September 1, 2024 and ended on August 31, 2025.']),
  clause(2, 'Rent', ['Monthly rent was $2,900, due on the 1st of each month.']),
  clause(3, 'Pets', ['No pets were permitted.']),
  clause(4, 'Notice to vacate', ["The Tenant was required to give 30 days' written notice."]),
].join('\n');

interface FixtureFile extends GoogleDriveFile {
  text?: string;
}

const FILES: FixtureFile[] = [
  { id: 'bench-housing', name: 'Housing', mimeType: FOLDER, parents: ['root'] },
  { id: 'bench-archive', name: 'Archive', mimeType: FOLDER, parents: ['bench-housing'] },
  { id: 'bench-work', name: 'Work', mimeType: FOLDER, parents: ['root'] },
  { id: 'bench-recipes', name: 'Recipes', mimeType: FOLDER, parents: ['root'] },
  {
    id: 'bench-lease-current',
    name: 'Lease Agreement - 412 Juniper Lane',
    mimeType: GDOC,
    parents: ['bench-housing'],
    modifiedTime: '2026-08-20T19:12:00.000Z',
    text: CURRENT_LEASE,
  },
  {
    id: 'bench-lease-expired',
    name: 'Lease Agreement 2024 (expired)',
    mimeType: GDOC,
    parents: ['bench-archive'],
    modifiedTime: '2024-08-15T17:40:00.000Z',
    text: EXPIRED_LEASE,
  },
  {
    id: 'bench-insurance',
    name: 'Renters insurance declaration.pdf',
    mimeType: 'application/pdf',
    parents: ['bench-housing'],
    modifiedTime: '2026-09-02T16:05:00.000Z',
    size: '184220',
  },
  {
    id: 'bench-planning',
    name: 'Q1 planning notes',
    mimeType: GDOC,
    parents: ['bench-work'],
    modifiedTime: '2027-01-14T22:30:00.000Z',
    text: 'Q1 planning notes\nGoals: ship the mobile app beta, hire two engineers, cut onboarding time in half.\nOpen question: launch in March or April?',
  },
  {
    id: 'bench-budget',
    name: 'Budget 2027',
    mimeType: GSHEET,
    parents: ['bench-work'],
    modifiedTime: '2027-01-09T18:20:00.000Z',
    text: 'Category,Monthly,Annual\nRent,3450,41400\nGroceries,620,7440\nTransit,140,1680',
  },
  {
    id: 'bench-sourdough',
    name: 'Sourdough starter.txt',
    mimeType: 'text/plain',
    parents: ['bench-recipes'],
    modifiedTime: '2026-05-03T15:00:00.000Z',
    size: '212',
    text: 'Feed the starter 1:1:1 flour, water, starter every 24 hours.\nIt is ready when it doubles in 6 hours.',
  },
  {
    id: 'bench-offsite-agenda',
    name: 'Offsite agenda - Austin',
    mimeType: GDOC,
    modifiedTime: '2027-02-25T20:45:00.000Z',
    text: 'Offsite agenda - Austin\nSaturday: strategy session, team dinner.\nSunday: planning workshop, flights home.',
  },
];

function calendarDocuments(): GoogleWorkspaceDocument[] {
  return EVENTS.map((event) => calendarEventToDocument(event, ACCOUNT)).filter(
    (doc): doc is GoogleWorkspaceDocument => doc !== null
  );
}

function driveDocuments(): GoogleWorkspaceDocument[] {
  const withOwner = FILES.map((file) => ({
    ...file,
    webViewLink: `https://drive.google.com/file/d/${file.id}/view`,
    owners: [{ emailAddress: ACCOUNT }],
  }));
  const folders = driveFolderPaths(withOwner);
  return withOwner.map(({ text, ...file }) =>
    driveFileToDocument({
      file,
      folderPath: folders.get(file.id) ?? 'My Drive',
      accountEmail: ACCOUNT,
      content: text === undefined ? undefined : { kind: 'fetched', text, truncated: false },
    })
  );
}

async function googleIntegrationId(): Promise<string> {
  await prisma.user.upsert({
    where: { userId: USER_ID },
    create: { userId: USER_ID, isAnonymous: false },
    update: {},
  });
  const existing = await prisma.integration.findFirst({
    where: { userId: USER_ID, name: 'gmail' },
    select: { id: true },
  });
  if (existing !== null) return existing.id;
  const created = await prisma.integration.create({
    data: {
      userId: USER_ID,
      name: 'gmail',
      type: IntegrationType.DATA_SOURCE,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * The account the frozen rows belong to. It carries the full grant so Calendar
 * and Drive count as connected, and placeholder tokens that are never sent: the
 * frozen sync state means no search refreshes, and an already-expired token
 * means any other reader fails at refresh instead of calling Google with it.
 */
async function ensureAccount(integrationId: string): Promise<void> {
  const data = {
    integrationId,
    accessToken: 'benchmark-fixture-placeholder',
    refreshToken: 'benchmark-fixture-placeholder',
    expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    scopes: [...GOOGLE_OAUTH_SCOPES],
    state: 'connected',
    lastErrorReason: null,
  };
  const existing = await prisma.emailIntegrationCredential.findFirst({
    where: { userId: USER_ID, provider: EmailProvider.GMAIL, email: ACCOUNT },
    select: { id: true },
  });
  if (existing === null) {
    await prisma.emailIntegrationCredential.create({
      data: { ...data, userId: USER_ID, provider: EmailProvider.GMAIL, email: ACCOUNT },
    });
  } else {
    await prisma.emailIntegrationCredential.update({ where: { id: existing.id }, data });
  }
}

async function freezeSyncState(): Promise<void> {
  for (const source of GOOGLE_WORKSPACE_SOURCES) {
    const state = {
      status: 'CONNECTED',
      lastStartedAt: new Date(),
      lastSuccessfulSyncAt: FROZEN_UNTIL,
      lastError: null,
      cursor: { accounts: {} },
    };
    await prisma.userDataProviderSyncState.upsert({
      where: { userId_source: { userId: USER_ID, source } },
      create: { userId: USER_ID, source, ...state },
      update: state,
    });
  }
}

async function summarize(): Promise<Manifest> {
  const [events, files, lease] = await Promise.all([
    prisma.userDataDocument.findMany({
      where: { userId: USER_ID, source: GOOGLE_CALENDAR_SOURCE, googleAccountEmail: ACCOUNT },
      select: { title: true, metadata: true },
    }),
    prisma.userDataDocument.count({
      where: { userId: USER_ID, source: GOOGLE_DRIVE_SOURCE, googleAccountEmail: ACCOUNT },
    }),
    prisma.userDataDocument.findFirst({
      where: {
        userId: USER_ID,
        source: GOOGLE_DRIVE_SOURCE,
        externalId: `${ACCOUNT}:bench-lease-current`,
      },
      select: { metadata: true },
    }),
  ]);
  const onDay = events.filter(
    (event) => (event.metadata as { startDate?: string } | null)?.startDate === CALENDAR_DAY
  );
  return {
    fixture: 'google_workspace_benchmark_v1',
    user_id: USER_ID,
    account: ACCOUNT,
    event_count: events.length,
    file_count: files,
    calendar_day: CALENDAR_DAY,
    calendar_day_events: onDay.map((event) => event.title).sort(),
    lease_path: `drive/${String((lease?.metadata as { path?: string } | null)?.path ?? '')}`,
  };
}

async function apply(): Promise<Manifest> {
  const integrationId = await googleIntegrationId();
  await ensureAccount(integrationId);
  // Only the frozen account's rows may answer: rows a base image carries for
  // other accounts would make the expected answers depend on that image.
  await prisma.userDataDocument.deleteMany({
    where: { userId: USER_ID, source: { in: [...GOOGLE_WORKSPACE_SOURCES] } },
  });
  await applyGoogleDocuments({
    userId: USER_ID,
    source: GOOGLE_CALENDAR_SOURCE,
    accountEmail: ACCOUNT,
    documents: calendarDocuments(),
  });
  await applyGoogleDocuments({
    userId: USER_ID,
    source: GOOGLE_DRIVE_SOURCE,
    accountEmail: ACCOUNT,
    documents: driveDocuments(),
  });
  await freezeSyncState();
  return summarize();
}

async function cleanup(): Promise<void> {
  await prisma.userDataDocument.deleteMany({
    where: {
      userId: USER_ID,
      source: { in: [...GOOGLE_WORKSPACE_SOURCES] },
      googleAccountEmail: ACCOUNT,
    },
  });
  await prisma.userDataProviderSyncState.deleteMany({
    where: { userId: USER_ID, source: { in: [...GOOGLE_WORKSPACE_SOURCES] } },
  });
  await prisma.emailIntegrationCredential.deleteMany({
    where: { userId: USER_ID, provider: EmailProvider.GMAIL, email: ACCOUNT },
  });
}

/**
 * This fixture deletes a user's Calendar and Drive rows and freezes their sync
 * state. Against production that would replace real synced data with these
 * rows, so it only ever runs against a database on this machine.
 */
function assertLocalDatabase(): void {
  const raw = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    host = '';
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(
      `google-workspace-benchmark-fixture refuses a non-local DATABASE_URL (host "${host}")`
    );
  }
}

async function main(): Promise<void> {
  assertLocalDatabase();
  const action = process.argv[2] || 'summary';
  let manifest: Manifest | Record<string, never>;
  if (action === 'apply') manifest = await apply();
  else if (action === 'cleanup') {
    await cleanup();
    manifest = {};
  } else if (action === 'summary') manifest = await summarize();
  else throw new Error(`Unknown action: ${action}`);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
