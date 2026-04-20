/**
 * Legacy entry path for the atlas-credential-store domain.
 *
 * The implementation lives in `main/domains/atlas-credential-store/`; this
 * shim preserves the pre-refactor import path for callers (handlers/registry,
 * browser-state-sync, blackbox tests) without forcing them to update their
 * imports.
 */

export { AtlasCredentialStore } from '../domains/atlas-credential-store/runtime';
