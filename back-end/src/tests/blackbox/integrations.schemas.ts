import { z } from 'zod';

// ==================== RESPONSE SCHEMAS ====================

export const ErrorResponse = z.object({ error: z.string() });

export const IntegrationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.enum(['TOOL_SETUP', 'DATA_SOURCE']),
  name: z.string(),
  status: z.enum(['NOT_CONNECTED', 'CONNECTED', 'SYNCING', 'SYNC_FAILED', 'EXPIRED']),
  isActive: z.boolean(),
  config: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ListIntegrationsResponse = z.object({
  integrations: z.array(IntegrationSchema.passthrough()),
  count: z.number(),
  authenticatedDomains: z.array(z.string()),
});

export const CreateIntegrationResponse = z.object({
  integration: IntegrationSchema.passthrough(),
});

export const PatchIntegrationResponse = z.object({
  integration: IntegrationSchema.passthrough(),
});

export const DeleteIntegrationResponse = z.object({
  message: z.string(),
});

export const MessagingUploadResponse = z.object({
  message: z.string(),
  integration: z.unknown(),
  jobId: z.string(),
});

export const TelegramConnectResponse = z.object({
  message: z.string(),
  integration: z.unknown(),
});

export const CookiesUploadResponse = z.object({
  message: z.string(),
  cookieCount: z.number(),
  integration: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
});

export const LocalStorageUploadResponse = z.object({
  message: z.string(),
  batchIndex: z.number(),
  totalBatches: z.number(),
  entryCount: z.number(),
  originCount: z.number(),
});

export const IndexedDBUploadResponse = z.object({
  message: z.string(),
  batchIndex: z.number(),
  totalBatches: z.number(),
  originCount: z.number(),
});

export const FingerprintUploadResponse = z.object({
  message: z.string(),
  integration: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
});

export const PermissionsUploadResponse = z.object({
  message: z.string(),
  grantCount: z.number(),
});

export const CacheStorageUploadResponse = z.object({
  message: z.string(),
  originCount: z.number(),
});

export const PasswordsUploadResponse = z.object({
  message: z.string(),
  passwordCount: z.number(),
});

export const ClaudeCodeUploadResponse = z.object({
  message: z.string(),
});

export const DocumentsUploadResponse = z.object({
  integration: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
  documents: z.array(z.object({ id: z.string(), externalId: z.string() })),
  documentCount: z.number(),
  snapshotRevision: z
    .object({
      snapshotVersion: z.number(),
      revisionId: z.string(),
    })
    .nullable(),
  syncState: z.object({
    id: z.string(),
    source: z.string(),
    status: z.string(),
    nextSyncAt: z.string().nullable(),
  }),
  dryRun: z.boolean(),
});

// ==================== HELPERS ====================

export const AnonymousResponse = z.object({
  success: z.literal(true),
  user: z.object({ id: z.string(), is_anonymous: z.literal(true) }),
  session: z.object({ access_token: z.string() }),
});
