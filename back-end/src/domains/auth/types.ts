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

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
}

export interface AnonymousSessionResult {
  user: { id: string; is_anonymous: boolean };
  session: SessionTokens;
}
