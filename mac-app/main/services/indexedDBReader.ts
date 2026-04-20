/**
 * Legacy entry path for the indexed-db-reader domain.
 *
 * The implementation lives in `main/domains/indexed-db-reader/`; this shim
 * preserves the pre-refactor import path for existing callers (browser-state-sync
 * service and blackbox tests) without forcing them to update their imports.
 *
 * New code should import from 'main/domains/indexed-db-reader/runtime'.
 */

export { IndexedDBReader } from '../domains/indexed-db-reader/runtime';
export type {
  IndexedDBData,
  IndexedDBDatabase,
  IndexedDBObjectStore,
  IndexedDBOriginData,
  IndexedDBRecord,
} from '../domains/indexed-db-reader/runtime';
