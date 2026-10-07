/**
 * Shared fixtures for the `calendar` and `drive` grep source tests: a user with
 * a connected Google account, stored events and files, and the HTTP helpers.
 */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { EmailProvider, IntegrationStatus, IntegrationType, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import {
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_DRIVE_SOURCE,
  calendarEventToDocument,
  driveFileToDocument,
  type GoogleWorkspaceDocument,
} from '../../services/integrations/googleWorkspaceDocuments';
config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
export const API_KEY = process.env.BACKEND_API_KEY || '';
export const DAY_MS = 86_400_000;
export const FOLDER = 'application/vnd.google-apps.folder';
export const GDOC = 'application/vnd.google-apps.document';

export interface Match {
  source: string;
  path: string;
  pointer: string;
  timestamp: string;
  content: string;
  location: { source: string; path: string; document_id?: string };
}
export interface GrepBody {
  matches: Match[];
  total_matches: number;
  display_order: string;
  sources: string[];
  has_more: boolean;
  next_offset: number | null;
  message?: string;
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function headers(userId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, 'X-User-Id': userId };
}

export async function grep(userId: string, body: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: headers(userId),
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as unknown };
}

export async function grepOk(userId: string, body: Record<string, unknown>): Promise<GrepBody> {
  const res = await grep(userId, body);
  assert(res.status === 200, `Expected HTTP 200, got ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data as GrepBody;
}

export async function expectInvalid(userId: string, body: Record<string, unknown>, label: string) {
  const res = await grep(userId, body);
  assert(res.status === 400, `${label}: expected HTTP 400, got ${res.status}`);
}

/** Local date (YYYY-MM-DD) `days` from today, as an event in UTC-7 would carry it. */
export function day(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

export function timedEvent(id: string, summary: string, date: string, time: string, extra = {}) {
  return {
    id,
    status: 'confirmed',
    summary,
    start: { dateTime: `${date}T${time}:00-07:00`, timeZone: 'America/Los_Angeles' },
    end: { dateTime: `${date}T${time}:00-07:00`, timeZone: 'America/Los_Angeles' },
    ...extra,
  };
}

export async function store(userId: string, docs: GoogleWorkspaceDocument[]): Promise<void> {
  await prisma.userDataDocument.createMany({
    data: docs.map((doc) => ({
      userId,
      source: doc.source,
      googleAccountEmail: doc.googleAccountEmail,
      externalId: doc.externalId,
      title: doc.title,
      content: doc.content,
      url: doc.url,
      metadata: doc.metadata as Prisma.InputJsonObject,
      sourceUpdatedAt: doc.sourceUpdatedAt,
      contentHash: doc.contentHash,
    })),
  });
}

/** Mark both sources as just refreshed so a grep reads the seeded rows as-is. */
export async function markFresh(userId: string): Promise<void> {
  for (const source of [GOOGLE_CALENDAR_SOURCE, GOOGLE_DRIVE_SOURCE]) {
    await prisma.userDataProviderSyncState.upsert({
      where: { userId_source: { userId, source } },
      create: { userId, source, status: 'CONNECTED', lastSuccessfulSyncAt: new Date() },
      update: { status: 'CONNECTED', lastSuccessfulSyncAt: new Date() },
    });
  }
}

export async function createUser(
  prefix: string,
  scopes: readonly string[] = GOOGLE_OAUTH_SCOPES
): Promise<{ userId: string; email: string }> {
  const userId = `${prefix}-${randomUUID()}`;
  const email = `${userId.slice(-8)}@example.com`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: IntegrationType.DATA_SOURCE,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
    },
  });
  await prisma.emailIntegrationCredential.create({
    data: {
      userId,
      integrationId: integration.id,
      provider: EmailProvider.GMAIL,
      email,
      accessToken: 'access-token-for-test',
      refreshToken: 'refresh-token-for-test',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...scopes],
      state: 'connected',
    },
  });
  return { userId, email };
}

export async function seedGoogleRows(userId: string, email: string): Promise<void> {
  const events = [
    timedEvent('old', 'Quarterly review', day(-10), '09:00'),
    timedEvent('sync', 'Project Sync', day(1), '10:00', {
      location: 'Room 4',
      description: 'Agenda: launch checklist',
      attendees: [{ email: 'sam@example.com', responseStatus: 'accepted' }],
    }),
    timedEvent('lunch', 'Lunch with Alex', day(1), '12:00'),
    timedEvent('dentist', 'Dentist', day(6), '15:00'),
    { id: 'offsite', summary: 'Offsite', start: { date: day(3) }, end: { date: day(5) } },
  ];
  const files = [
    { id: 'legal', name: 'Legal', mimeType: FOLDER, folder: 'My Drive' },
    {
      id: 'lease',
      name: 'Lease',
      mimeType: GDOC,
      folder: 'My Drive/Legal',
      modifiedTime: '2026-09-20T12:00:00.000Z',
      text: 'Residential lease\nTenant: Andy\nLease ends December 31, 2026\nRent due on the 1st',
    },
    {
      id: 'scan',
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      folder: 'My Drive/Legal',
      modifiedTime: '2026-09-22T12:00:00.000Z',
    },
    {
      id: 'notes',
      name: 'notes.txt',
      mimeType: 'text/plain',
      folder: 'My Drive',
      modifiedTime: '2026-09-25T12:00:00.000Z',
      text: 'remember the milk',
    },
  ];
  await store(userId, [
    ...events
      .map((event) => calendarEventToDocument(event, email))
      .filter((doc): doc is GoogleWorkspaceDocument => doc !== null),
    ...files.map((file) =>
      driveFileToDocument({
        file,
        folderPath: file.folder,
        accountEmail: email,
        content:
          file.text === undefined
            ? undefined
            : { kind: 'fetched', text: file.text, truncated: false },
      })
    ),
  ]);
  await markFresh(userId);
}
