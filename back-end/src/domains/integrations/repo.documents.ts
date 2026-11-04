/**
 * Integrations domain repo - normalized document and user snapshot persistence.
 */

import { type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export interface NormalizedDocumentRow {
  source: string;
  externalId: string;
  title: string;
  content: string;
  url?: string;
  metadata: Prisma.InputJsonValue;
  sourceUpdatedAt?: Date;
  contentHash: string;
}

export interface ProviderSyncStateRow {
  source: string;
  status: string;
  config: Prisma.InputJsonValue;
  cursor: Prisma.InputJsonValue;
  lastStartedAt?: Date;
  lastSuccessfulSyncAt?: Date;
  lastError?: string | null;
  nextSyncAt?: Date;
  realtimeEnabled: boolean;
}

export interface SnapshotRevisionRow {
  source: string;
  documentExternalId?: string;
  before: Prisma.InputJsonValue;
  after: Prisma.InputJsonValue;
  changes: Prisma.InputJsonValue;
  model?: string;
  promptKey?: string;
}

export async function ensureUser(userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { userId },
    create: { userId, isAnonymous: true },
    update: {},
  });
}

export async function upsertDataDocuments(
  userId: string,
  documents: NormalizedDocumentRow[],
  client: Prisma.TransactionClient = prisma
): Promise<Array<{ id: string; externalId: string }>> {
  const rows: Array<{ id: string; externalId: string }> = [];
  for (const doc of documents) {
    const row = await client.userDataDocument.upsert({
      where: {
        userId_source_externalId: {
          userId,
          source: doc.source,
          externalId: doc.externalId,
        },
      },
      create: {
        userId,
        source: doc.source,
        externalId: doc.externalId,
        title: doc.title,
        content: doc.content,
        url: doc.url,
        metadata: doc.metadata,
        sourceUpdatedAt: doc.sourceUpdatedAt,
        contentHash: doc.contentHash,
      },
      update: {
        title: doc.title,
        content: doc.content,
        url: doc.url,
        metadata: doc.metadata,
        sourceUpdatedAt: doc.sourceUpdatedAt,
        contentHash: doc.contentHash,
        lastSeenAt: new Date(),
        deletedAt: null,
      },
      select: { id: true, externalId: true },
    });
    rows.push(row);
  }
  return rows;
}

export async function upsertProviderSyncState(
  userId: string,
  state: ProviderSyncStateRow
): Promise<{ id: string; source: string; status: string; nextSyncAt: Date | null }> {
  return prisma.userDataProviderSyncState.upsert({
    where: {
      userId_source: {
        userId,
        source: state.source,
      },
    },
    create: {
      userId,
      source: state.source,
      status: state.status,
      config: state.config,
      cursor: state.cursor,
      lastStartedAt: state.lastStartedAt,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
      lastError: state.lastError,
      nextSyncAt: state.nextSyncAt,
      realtimeEnabled: state.realtimeEnabled,
    },
    update: {
      status: state.status,
      config: state.config,
      cursor: state.cursor,
      lastStartedAt: state.lastStartedAt,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
      lastError: state.lastError,
      nextSyncAt: state.nextSyncAt,
      realtimeEnabled: state.realtimeEnabled,
    },
    select: { id: true, source: true, status: true, nextSyncAt: true },
  });
}

export async function recordUserSnapshotRevision(params: {
  userId: string;
  revision: SnapshotRevisionRow;
  documents: Array<{ id: string; externalId: string }>;
}): Promise<{ snapshotVersion: number; revisionId: string }> {
  const document =
    params.revision.documentExternalId === undefined
      ? null
      : (params.documents.find((row) => row.externalId === params.revision.documentExternalId) ??
        null);

  const snapshot = await prisma.userSnapshot.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId, content: params.revision.after, version: 1 },
    update: { content: params.revision.after, version: { increment: 1 } },
    select: { id: true, version: true },
  });

  const revision = await prisma.userSnapshotRevision.create({
    data: {
      userId: params.userId,
      snapshotId: snapshot.id,
      documentId: document?.id,
      source: params.revision.source,
      before: params.revision.before,
      after: params.revision.after,
      changes: params.revision.changes,
      model: params.revision.model,
      promptKey: params.revision.promptKey,
    },
    select: { id: true },
  });

  return { snapshotVersion: snapshot.version, revisionId: revision.id };
}
