/**
 * Legacy entry path for the permission-reader domain.
 *
 * The implementation lives in `main/domains/permission-reader/`; this shim
 * preserves the pre-refactor import path for callers (browser-state-sync
 * service, blackbox tests) without forcing them to update their imports.
 *
 * New code should import from 'main/domains/permission-reader/runtime'.
 */

export { PermissionReader } from '../domains/permission-reader/runtime';
export type { PermissionData, PermissionGrant } from '../domains/permission-reader/runtime';
