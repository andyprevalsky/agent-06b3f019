/**
 * Types for the auth domain.
 *
 * Owns the user-facing session shape (re-exported from the shared IPC bundle
 * so consumers across main/ keep a single import site) and the Supabase
 * refresh-token response envelope the service layer decodes.
 */

import type { AuthSession } from '../../../shared/types/ipc';

export type { AuthSession };

/**
 * Shape returned by
 *   POST {supabase.url}/auth/v1/token?grant_type=refresh_token
 * when the refresh succeeds. Only the fields the service layer consumes are
 * modeled; additional fields returned by Supabase are ignored.
 */
export interface SupabaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: unknown;
}
