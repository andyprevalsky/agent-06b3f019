/**
 * Legacy entry point for the auth domain.
 *
 * The implementation now lives in `main/domains/auth/`; this file re-exports
 * the `AuthService` runtime facade so existing importers (and blackbox tests
 * that `vi.mock('../../main/services/auth', ...)`) keep working without
 * edits.
 */

export { AuthService } from '../domains/auth/runtime';
