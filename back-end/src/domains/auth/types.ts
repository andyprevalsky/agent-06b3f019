// Twilio Verify response types
export interface TwilioVerifyResponse {
  sid?: string;
  status?: string;
  to?: string;
  channel?: string;
  valid?: boolean;
  // Error fields
  code?: number;
  message?: string;
  more_info?: string;
}

// Supabase Admin API response types
export interface SupabaseAdminUserResponse {
  id: string;
  phone?: string;
  email?: string;
  phone_confirmed_at?: string;
  created_at?: string;
}

export interface SupabaseAdminUsersListResponse {
  users: SupabaseAdminUserResponse[];
}

// Session token shapes are owned by the canonical minter so the auth domain and
// admin-health (admin account switching) can never drift apart.
export type { AnonymousSessionResult, SessionTokens } from '../../providers/sessionTokens';
