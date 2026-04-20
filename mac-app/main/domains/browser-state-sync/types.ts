import type { IndexedDBData, IndexedDBOriginData } from '../../services/indexedDBReader';
import type { LocalStorageData } from '../../services/localStorageReader';
import type { PermissionData } from '../../services/permissionReader';
import type { CacheStorageData } from '../../services/cacheStorageReader';

export type UploadResult = { success: boolean; message?: string };

export interface LocalStorageBatch {
  byOrigin: Record<string, { key: string; value: string }[]>;
  hashes: Record<string, string>;
  batchIndex: number;
  totalBatches: number;
  entryCount: number;
  originCount: number;
}

export interface IndexedDBBatch {
  origins: IndexedDBOriginData[];
  hashes: Record<string, string>;
  batchIndex: number;
  totalBatches: number;
}

export interface PasswordRecord {
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsed: number;
  dateCreated: number;
  browserSource: string;
}

export interface SyncBrowserOptions {
  keychainPassword?: string;
}

// Re-export provider-level types consumed by this domain's external contract
export type {
  LocalStorageData,
  IndexedDBData,
  IndexedDBOriginData,
  PermissionData,
  CacheStorageData,
};
