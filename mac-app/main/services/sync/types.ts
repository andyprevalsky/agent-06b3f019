/**
 * Re-export shim — the sync-manager domain owns these types. Other services
 * and tests still import from `main/services/sync`, so this barrel keeps
 * import paths stable while the implementation lives under
 * `main/domains/sync-manager`.
 */
export type { Platform, SyncConfig, SyncEvent } from '../../domains/sync-manager/types';
