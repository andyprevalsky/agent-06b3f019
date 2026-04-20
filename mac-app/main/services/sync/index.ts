/**
 * Re-export shim — the sync-manager domain is now implemented under
 * `main/domains/sync-manager`. This barrel preserves the `main/services/sync`
 * import path for the blackbox test and for any legacy consumer.
 */
export { SyncManager } from '../../domains/sync-manager/runtime';
export { IntegrationCache } from '../../domains/sync-manager/service';
export type { Platform, SyncConfig, SyncEvent } from '../../domains/sync-manager/types';
