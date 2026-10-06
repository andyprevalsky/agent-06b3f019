/**
 * The stored copy of one Google account's Calendar or Drive documents: reading
 * what is stored and making it equal a fresh listing.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { GoogleWorkspaceDocument, GoogleWorkspaceSource } from './googleWorkspaceDocuments';

const WRITE_CHUNK = 500;

export interface StoredRow {
  id: string;
  externalId: string;
  contentHash: string;
  metadata: Prisma.JsonValue | null;
  sourceUpdatedAt: Date | null;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

export async function storedRows(
  userId: string,
  source: GoogleWorkspaceSource,
  accountEmail: string
): Promise<Map<string, StoredRow>> {
  const rows = await prisma.userDataDocument.findMany({
    where: { userId, source, googleAccountEmail: accountEmail },
    select: {
      id: true,
      externalId: true,
      contentHash: true,
      metadata: true,
      sourceUpdatedAt: true,
    },
  });
  return new Map(rows.map((row) => [row.externalId, row]));
}

/**
 * Make the stored rows of one account equal `documents`: create what is new,
 * update what changed (by hash), delete what Google no longer returns.
 */
export async function applyGoogleDocuments(params: {
  userId: string;
  source: GoogleWorkspaceSource;
  accountEmail: string;
  documents: GoogleWorkspaceDocument[];
  stored?: Map<string, StoredRow>;
  /**
   * Set when the listing was cut off at the file cap: it covers only files
   * modified after this time. A stored row no newer than that may still exist
   * in Google, so only rows the listing would have included are removed.
   */
  listedSince?: Date;
  /** Runs after every write, so a large apply keeps its refresh lease alive. */
  keepAlive?: () => Promise<void>;
}): Promise<{ created: number; updated: number; removed: number }> {
  const { userId, source, accountEmail, documents, listedSince, keepAlive } = params;
  const stored = params.stored ?? (await storedRows(userId, source, accountEmail));
  const seen = new Set<string>();
  const creates: Prisma.UserDataDocumentCreateManyInput[] = [];
  let updated = 0;

  for (const doc of documents) {
    if (seen.has(doc.externalId)) continue;
    seen.add(doc.externalId);
    const metadata = doc.metadata as Prisma.InputJsonObject;
    const row = stored.get(doc.externalId);
    if (row === undefined) {
      creates.push({
        userId,
        source,
        googleAccountEmail: accountEmail,
        externalId: doc.externalId,
        title: doc.title,
        content: doc.content,
        url: doc.url,
        metadata,
        sourceUpdatedAt: doc.sourceUpdatedAt,
        contentHash: doc.contentHash,
      });
      continue;
    }
    if (row.contentHash === doc.contentHash) continue;
    // Written only if the row is still the one this refresh read. An on-demand
    // text download that landed in between is kept; the next refresh reads the
    // newer row and plans from it.
    const written = await prisma.userDataDocument.updateMany({
      where: { id: row.id, contentHash: row.contentHash },
      data: {
        title: doc.title,
        url: doc.url ?? null,
        metadata,
        sourceUpdatedAt: doc.sourceUpdatedAt ?? null,
        contentHash: doc.contentHash,
        lastSeenAt: new Date(),
        deletedAt: null,
        ...(doc.keepStoredContent === true ? {} : { content: doc.content }),
      },
    });
    updated += written.count;
    await keepAlive?.();
  }

  for (const batch of chunks(creates, WRITE_CHUNK)) {
    await prisma.userDataDocument.createMany({ data: batch, skipDuplicates: true });
    await keepAlive?.();
  }
  const knownGone = (row: StoredRow): boolean =>
    listedSince === undefined ||
    (row.sourceUpdatedAt !== null && row.sourceUpdatedAt.getTime() > listedSince.getTime());
  const removedIds = [...stored.values()]
    .filter((row) => !seen.has(row.externalId) && knownGone(row))
    .map((row) => row.id);
  for (const batch of chunks(removedIds, WRITE_CHUNK)) {
    await prisma.userDataDocument.deleteMany({ where: { id: { in: batch } } });
    await keepAlive?.();
  }
  return { created: creates.length, updated, removed: removedIds.length };
}
