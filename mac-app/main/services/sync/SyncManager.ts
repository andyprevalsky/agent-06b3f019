/**
 * Re-export shim — SyncManager lives in the layered domain now.
 * External consumers (main/handlers/registry.ts) still import from this path,
 * so it forwards to the runtime layer.
 */
export { SyncManager } from '../../domains/sync-manager/runtime';
