/**
 * Legacy entry path for the local-storage-reader domain.
 *
 * The implementation lives in `main/domains/local-storage-reader/`; this
 * shim preserves the pre-refactor import path for callers (browser-state-sync
 * service, blackbox tests) without forcing them to update their imports.
 *
 * New code should import from 'main/domains/local-storage-reader/runtime'.
 */

export { LocalStorageReader } from '../domains/local-storage-reader/runtime';
export type { LocalStorageData, LocalStorageEntry } from '../domains/local-storage-reader/runtime';
