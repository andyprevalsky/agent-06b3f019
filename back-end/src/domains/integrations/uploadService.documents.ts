/**
 * Integrations upload service - normalized text documents and user snapshot revisions.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../../providers/logger';
import { IntegrationStatus, IntegrationType, type Prisma } from './types';
import * as repo from './repo';
import * as documentRepo from './repo.documents';

const log = createLogger('Integrations');

const MAX_DOCUMENTS_PER_UPLOAD = 500;
const MAX_CONTENT_CHARS = 250_000;
export const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  'chatgpt',
  'claude',
  'apple_notes',
  'obsidian',
  'openai',
  'anthropic',
  'generic',
]);

export interface DocumentUploadInput {
  source: string;
  externalId?: unknown;
  title?: unknown;
  content?: unknown;
  url?: unknown;
  sourceUpdatedAt?: unknown;
  metadata?: unknown;
}

export interface SnapshotRevisionInput {
  source?: unknown;
  documentExternalId?: unknown;
  before?: unknown;
  after?: unknown;
  changes?: unknown;
  model?: unknown;
  promptKey?: unknown;
}

export interface DocumentsUploadInput {
  source?: unknown;
  documents?: unknown;
  snapshotRevision?: unknown;
  dryRun?: unknown;
}

function sanitizeString(value: string): string {
  return [...value]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    })
    .join('');
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return sanitizeString(value.trim());
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return sanitizeString(value.trim());
}

function parseSource(value: unknown): string {
  const source = requireNonEmptyString(value, 'source')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!KNOWN_SOURCES.has(source)) {
    throw new Error(`source must be one of: ${Array.from(KNOWN_SOURCES).sort().join(', ')}`);
  }
  return source;
}

function parseDryRun(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error('dryRun must be a boolean');
  return value;
}

function parseDate(value: unknown, label: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid ISO timestamp`);
  return parsed;
}

function jsonValue(value: unknown, label: string): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  try {
    JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  return value as Prisma.InputJsonValue;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function syncDefaults(source: string): {
  nextSyncAt: Date;
  realtimeEnabled: boolean;
  config: Record<string, unknown>;
} {
  const now = Date.now();
  if (
    source === 'chatgpt' ||
    source === 'claude' ||
    source === 'openai' ||
    source === 'anthropic'
  ) {
    return {
      nextSyncAt: new Date(now + 6 * 60 * 60 * 1000),
      realtimeEnabled: false,
      config: { reconcileIntervalMinutes: 360, ingestionMode: 'export_import' },
    };
  }
  if (source === 'apple_notes') {
    return {
      nextSyncAt: new Date(now + 15 * 60 * 1000),
      realtimeEnabled: true,
      config: {
        reconcileIntervalMinutes: 15,
        fullRescanIntervalMinutes: 24 * 60,
        debounceSeconds: 60,
      },
    };
  }
  if (source === 'obsidian') {
    return {
      nextSyncAt: new Date(now + 60 * 60 * 1000),
      realtimeEnabled: true,
      config: { reconcileIntervalMinutes: 60, debounceSeconds: 2 },
    };
  }
  return {
    nextSyncAt: new Date(now + 60 * 60 * 1000),
    realtimeEnabled: false,
    config: { reconcileIntervalMinutes: 60 },
  };
}

function normalizeDocument(
  source: string,
  raw: unknown
): {
  source: string;
  externalId: string;
  title: string;
  content: string;
  url?: string;
  metadata: Prisma.InputJsonValue;
  sourceUpdatedAt?: Date;
  contentHash: string;
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('each document must be an object');
  }
  const doc = raw as DocumentUploadInput;
  const content = requireNonEmptyString(doc.content, 'document.content');
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`document.content exceeds ${MAX_CONTENT_CHARS} characters`);
  }
  const externalId = optionalString(doc.externalId, 'document.externalId') ?? contentHash(content);
  const title = optionalString(doc.title, 'document.title') ?? externalId;
  return {
    source,
    externalId,
    title,
    content,
    url: optionalString(doc.url, 'document.url'),
    metadata: jsonValue(doc.metadata, 'document.metadata'),
    sourceUpdatedAt: parseDate(doc.sourceUpdatedAt, 'document.sourceUpdatedAt'),
    contentHash: contentHash(content),
  };
}

async function recordSnapshotRevision(params: {
  userId: string;
  source: string;
  revision: SnapshotRevisionInput;
  documents: Array<{ id: string; externalId: string }>;
}): Promise<{ snapshotVersion: number; revisionId: string } | null> {
  const after = params.revision.after;
  if (after === undefined || after === null) return null;

  const beforeJson = jsonValue(params.revision.before, 'snapshotRevision.before');
  const afterJson = jsonValue(after, 'snapshotRevision.after');
  const changesJson = jsonValue(params.revision.changes, 'snapshotRevision.changes');
  const revisionSource =
    optionalString(params.revision.source, 'snapshotRevision.source') ?? params.source;
  return documentRepo.recordUserSnapshotRevision({
    userId: params.userId,
    documents: params.documents,
    revision: {
      source: revisionSource,
      before: beforeJson,
      after: afterJson,
      changes: changesJson,
      documentExternalId: optionalString(
        params.revision.documentExternalId,
        'snapshotRevision.documentExternalId'
      ),
      model: optionalString(params.revision.model, 'snapshotRevision.model'),
      promptKey: optionalString(params.revision.promptKey, 'snapshotRevision.promptKey'),
    },
  });
}

function buildDryRunResult(
  source: string,
  documents: Array<{ externalId: string }>,
  sync: ReturnType<typeof syncDefaults>
) {
  return {
    integration: {
      id: 'dry-run',
      name: source,
      status: IntegrationStatus.CONNECTED,
    },
    documents: documents.map((doc) => ({
      id: `dry-run:${doc.externalId}`,
      externalId: doc.externalId,
    })),
    documentCount: documents.length,
    snapshotRevision: null,
    syncState: {
      id: 'dry-run',
      source,
      status: IntegrationStatus.CONNECTED,
      nextSyncAt: sync.nextSyncAt,
    },
    dryRun: true,
  };
}

export async function processDocumentsUpload(userId: string, input: DocumentsUploadInput) {
  const source = parseSource(input.source);
  const dryRun = parseDryRun(input.dryRun);
  if (!Array.isArray(input.documents)) {
    throw new Error('documents must be an array');
  }
  if (input.documents.length > MAX_DOCUMENTS_PER_UPLOAD) {
    throw new Error(`documents cannot contain more than ${MAX_DOCUMENTS_PER_UPLOAD} items`);
  }

  const documents = input.documents.map((doc) => normalizeDocument(source, doc));
  const sync = syncDefaults(source);
  if (dryRun) {
    return buildDryRunResult(source, documents, sync);
  }

  await documentRepo.ensureUser(userId);
  const upserted = await documentRepo.upsertDataDocuments(userId, documents);
  const snapshotRevision =
    input.snapshotRevision !== undefined && input.snapshotRevision !== null
      ? await recordSnapshotRevision({
          userId,
          source,
          revision: input.snapshotRevision as SnapshotRevisionInput,
          documents: upserted,
        })
      : null;
  const syncState = await documentRepo.upsertProviderSyncState(userId, {
    source,
    status: IntegrationStatus.CONNECTED,
    config: {
      ...sync.config,
      documentCount: upserted.length,
      lastDocumentTitles: documents.slice(0, 10).map((doc) => doc.title),
      snapshotVersion: snapshotRevision?.snapshotVersion,
    },
    cursor: {
      lastContentHashes: documents.slice(0, 50).map((doc) => ({
        externalId: doc.externalId,
        contentHash: doc.contentHash,
      })),
    },
    lastStartedAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    lastError: null,
    nextSyncAt: sync.nextSyncAt,
    realtimeEnabled: sync.realtimeEnabled,
  });

  const integration = await repo.upsertIntegration({
    userId,
    name: source,
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: {
      documentCount: upserted.length,
      lastDocumentTitles: documents.slice(0, 10).map((doc) => doc.title),
      snapshotVersion: snapshotRevision?.snapshotVersion,
    },
  });

  log.info('Documents uploaded', {
    userId,
    source,
    documentCount: upserted.length,
    snapshotRevisionId: snapshotRevision?.revisionId,
  });

  return {
    integration,
    documents: upserted,
    documentCount: upserted.length,
    snapshotRevision,
    syncState,
    dryRun: false,
  };
}
