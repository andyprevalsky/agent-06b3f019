/**
 * Shared fixtures for the Google Calendar and Drive sync tests: Google faked at
 * the `fetch` boundary, and users with a connected Google account.
 */

import { randomUUID } from 'crypto';
import { EmailProvider, IntegrationStatus, IntegrationType } from '@prisma/client';
import { prisma } from '../../providers/database';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import type { Fetcher } from '../../services/integrations/googleWorkspaceApi';
import type {
  GoogleCalendarEvent,
  GoogleDriveFile,
} from '../../services/integrations/googleWorkspaceDocuments';

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
export function equal<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

export const ACCESS_TOKEN = 'access-token-for-test';
export const T0 = new Date('2026-10-05T12:00:00.000Z');
export const later = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
export const FOLDER = 'application/vnd.google-apps.folder';
export const GDOC = 'application/vnd.google-apps.document';

/** A small Drive: one folder holding a doc, a text file and a PDF. */
export const LEGAL: GoogleDriveFile = {
  id: 'legal',
  name: 'Legal',
  mimeType: FOLDER,
  parents: ['root'],
};
export const LEASE: GoogleDriveFile = {
  id: 'lease',
  name: 'Lease',
  mimeType: GDOC,
  parents: ['legal'],
  modifiedTime: '2026-09-20T12:00:00.000Z',
};
export const NOTES: GoogleDriveFile = {
  id: 'notes',
  name: 'notes.txt',
  mimeType: 'text/plain',
  parents: ['root'],
  size: '20',
  modifiedTime: '2026-09-21T12:00:00.000Z',
};
export const SCAN: GoogleDriveFile = {
  id: 'scan',
  name: 'scan.pdf',
  mimeType: 'application/pdf',
  parents: ['legal'],
  size: '900',
  modifiedTime: '2026-09-22T12:00:00.000Z',
};

/** Google at the fetch boundary: mutable state plus a log of what was asked. */
export class FakeGoogle {
  events: GoogleCalendarEvent[] = [];
  files: GoogleDriveFile[] = [];
  text = new Map<string, string>();
  driveChanged = false;
  calendarStatus = 200;
  /** Answer every text download with Drive's rate-limit 403. */
  rateLimitDownloads = false;
  /** How long Google takes to answer each call. */
  delayMs = 0;
  /** Files per page of the Drive listing; 0 returns them all in one page. */
  pageSize = 0;
  /** Runs while a text download is in flight, before Google answers it. */
  onDownload: ((fileId: string) => Promise<void>) | null = null;
  calls: string[] = [];
  private token = 1;

  count(kind: string): number {
    return this.calls.filter((call) => call === kind).length;
  }

  reset(): void {
    this.calls = [];
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization');
    assert(auth === `Bearer ${ACCESS_TOKEN}`, 'every Google call must carry the stored token');
    const path = url.pathname;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (path.endsWith('/calendars/primary/events')) {
      this.calls.push('calendar');
      assert(url.searchParams.get('singleEvents') === 'true', 'recurring events must be expanded');
      return this.calendarStatus === 200
        ? this.json({ items: this.events })
        : this.json({ error: { code: this.calendarStatus } }, this.calendarStatus);
    }
    if (path.endsWith('/changes/startPageToken')) {
      this.calls.push('startToken');
      return this.json({ startPageToken: `page-${this.token}` });
    }
    if (path.endsWith('/changes')) {
      this.calls.push('changes');
      this.token += 1;
      return this.json({
        changes: this.driveChanged ? [{ fileId: 'changed' }] : [],
        newStartPageToken: `page-${this.token}`,
      });
    }
    if (path.endsWith('/drive/v3/files')) {
      this.calls.push('list');
      if (this.pageSize <= 0) return this.json({ files: this.files });
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const end = start + this.pageSize;
      return this.json({
        files: this.files.slice(start, end),
        ...(end < this.files.length ? { nextPageToken: String(end) } : {}),
      });
    }
    const fileId = /\/files\/([^/]+)/.exec(path)?.[1];
    if (fileId !== undefined) {
      this.calls.push('download');
      if (this.onDownload !== null) await this.onDownload(fileId);
      if (this.rateLimitDownloads) {
        return this.json(
          { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
          403
        );
      }
      const text = this.text.get(fileId);
      return text === undefined
        ? this.json({ error: { code: 403 } }, 403)
        : new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return this.json({ error: { code: 404 } }, 404);
  };
}

export async function addAccount(
  userId: string,
  integrationId: string,
  email: string,
  scopes: readonly string[] = GOOGLE_OAUTH_SCOPES
): Promise<void> {
  await prisma.emailIntegrationCredential.create({
    data: {
      userId,
      integrationId,
      provider: EmailProvider.GMAIL,
      email,
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-token-for-test',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...scopes],
      state: 'connected',
    },
  });
}

export async function withUser(
  run: (ctx: { userId: string; email: string; integrationId: string }) => Promise<void>
): Promise<void> {
  const userId = randomUUID();
  const email = `gws-${userId.slice(0, 8)}@example.com`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    const integration = await prisma.integration.create({
      data: {
        userId,
        name: 'gmail',
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });
    await addAccount(userId, integration.id, email);
    await run({ userId, email, integrationId: integration.id });
  } finally {
    await prisma.googleDataPurge.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { userId } });
  }
}

export async function rows(userId: string, source: string) {
  return prisma.userDataDocument.findMany({
    where: { userId, source },
    orderBy: { externalId: 'asc' },
  });
}

export function pathOf(row: { metadata: unknown }): string {
  return String((row.metadata as { path?: string }).path);
}

export function event(id: string, summary: string, start: string): GoogleCalendarEvent {
  return {
    id,
    status: 'confirmed',
    summary,
    start: { dateTime: start },
    end: { dateTime: start },
  };
}

export interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

/** Run the cases in order, print one line each, and exit non-zero on any failure. */
export async function runSuite(title: string, tests: TestCase[]): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  console.log(`\n${title}\n`);
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

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
