import type { EmailProvider, Prisma } from '@prisma/client';

// Re-export Prisma types for other layers (keeps @prisma/client out of service files)
export { IntegrationType, IntegrationStatus, EmailProvider, MessageChannel } from '@prisma/client';
export type { Prisma } from '@prisma/client';

/** Minimal response interface so service files don't depend on Express. */
export interface OAuthResponse {
  redirect(url: string): void;
  status(code: number): { send(body: string): void };
}

export type EmailProviderSlug = 'gmail' | 'yahoo';

export interface EmailProviderConfig {
  provider: EmailProvider;
  authUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes: string[];
  requiresClientSecret?: boolean;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scopes: string[];
  userEmail?: string;
  metadata?: Record<string, unknown>;
}

export interface IndexedDBRecord {
  key: string | number | (string | number)[];
  value: unknown;
  error?: string;
}

export interface IndexedDBObjectStore {
  name: string;
  records: IndexedDBRecord[];
}

export interface IndexedDBDatabase {
  name: string;
  objectStores: IndexedDBObjectStore[];
}

export interface IndexedDBOriginData {
  origin: string;
  databases: IndexedDBDatabase[];
  error?: string;
}

export interface CacheInfo {
  name: string;
  size?: number;
}

export interface CacheStorageOriginData {
  origin: string;
  caches: CacheInfo[];
}

export interface LocalStoragePayload {
  byOrigin: Record<string, { key: string; value: string }[]>;
  hashes: Record<string, string>;
  batchIndex: number;
  totalBatches: number;
  entryCount: number;
  originCount: number;
}

export interface IndexedDBPayload {
  origins: IndexedDBOriginData[];
  hashes: Record<string, string>;
  batchIndex: number;
  totalBatches: number;
}

export interface CacheStoragePayload {
  origins: CacheStorageOriginData[];
  hashes: Record<string, string>;
  originCount: number;
}

export interface PermissionPayload {
  grants: Array<{ origin: string; permission: string; setting: number }>;
  hash: string;
  grantCount: number;
}

export interface PasswordPayloadEntry {
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsed: number;
  dateCreated: number;
  browserSource: string;
  browserProfile?: { id?: string; path?: string } | string | null;
}

export interface PasswordPayload {
  passwords: PasswordPayloadEntry[];
}

export interface PasskeyPayloadEntry {
  // rpId is required; authRealm/origin are derived from it if omitted.
  rpId: string;
  credentialId: string;
  // Raw PKCS#8 private key (base64). Encrypted in transit by the AES envelope;
  // re-encrypted server-side with the RSA storage envelope before persistence.
  privateKey: string;
  userHandle?: string | null;
  signCount?: number;
  authRealm?: string;
  origin?: string | null;
  browserSource?: string;
}

export interface PasskeyPayload {
  passkeys: PasskeyPayloadEntry[];
}

export interface ApplePasswordEntry {
  title: string;
  url: string;
  username: string;
  password: string;
  notes: string;
  otpAuth: string;
}

/**
 * Helper to parse a Prisma JsonValue into a mutable JsonObject.
 */
export const parseConfig = (value: Prisma.JsonValue | null | undefined): Prisma.JsonObject => {
  if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Prisma.JsonObject) };
  }
  return {};
};

/**
 * Merge existing JSON config with partial updates.
 */
export const mergeJson = (
  existing: Prisma.JsonValue | null | undefined,
  updates?: Record<string, unknown>
): Prisma.InputJsonValue | undefined => {
  if (!updates) {
    return (existing as Prisma.InputJsonValue | null) ?? undefined;
  }
  return { ...parseConfig(existing), ...updates } as Prisma.JsonObject;
};

/** IndexedDB machine-upload JSON failed schema/shape validation (client fault). */
export class IndexedDBUploadPayloadInvalidError extends Error {
  constructor(detail: string) {
    super(`Invalid IndexedDB payload: ${detail}`);
    this.name = 'IndexedDBUploadPayloadInvalidError';
  }
}

/** IndexedDB machine-upload exceeded the decompressed size ceiling (client fault). */
export class IndexedDBUploadPayloadTooLargeError extends Error {
  readonly limitBytes: number;
  readonly actualBytes: number;
  constructor(limitBytes: number, actualBytes: number) {
    super(`IndexedDB upload exceeds ${limitBytes} byte limit (got ${actualBytes} bytes)`);
    this.name = 'IndexedDBUploadPayloadTooLargeError';
    this.limitBytes = limitBytes;
    this.actualBytes = actualBytes;
  }
}
