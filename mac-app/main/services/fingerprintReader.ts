/**
 * Legacy entry path for the fingerprint-reader domain.
 *
 * The implementation lives in `main/domains/fingerprint-reader/`; this shim
 * preserves the pre-refactor import path for callers (handlers/registry,
 * browser-state-sync, blackbox tests) without forcing them to update their
 * imports.
 */

export { FingerprintReader } from '../domains/fingerprint-reader/runtime';
