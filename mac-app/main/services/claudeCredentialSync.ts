/**
 * Legacy entry path for the claude-credential-sync domain.
 *
 * The implementation lives in `main/domains/claude-credential-sync/`; this
 * shim preserves the pre-refactor import path for callers (handlers/registry,
 * blackbox tests) without forcing them to update their imports.
 */

export { ClaudeCredentialSync } from '../domains/claude-credential-sync/runtime';
