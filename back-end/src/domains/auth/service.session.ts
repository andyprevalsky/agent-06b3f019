import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import {
  SUPABASE_URL,
  SUPABASE_JWT_SECRET,
  SESSION_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
} from './config';
import type { SessionTokens, AnonymousSessionResult } from './types';

export class AuthConfigError extends Error {
  constructor(detail: string) {
    super(`Auth configuration error: ${detail}`);
  }
}

/**
 * Generate JWT session tokens signed with HS256.
 * Uses the JWT secret directly as a string.
 */
export function generateSupabaseSession(userId: string, phone: string): SessionTokens {
  if (SUPABASE_JWT_SECRET === undefined || SUPABASE_JWT_SECRET === '') {
    throw new AuthConfigError('Missing SUPABASE_JWT_SECRET');
  }

  const secret = SUPABASE_JWT_SECRET;

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_EXPIRES_IN;
  const refreshExpiresAt = now + REFRESH_TOKEN_EXPIRES_IN;

  const sessionId = uuidv4();
  const accessPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: (SUPABASE_URL ?? '') + '/auth/v1',
    sub: userId,
    email: '',
    phone,
    phone_confirmed_at: new Date().toISOString(),
    app_metadata: {
      provider: 'phone',
      providers: ['phone'],
    },
    user_metadata: {},
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'otp', timestamp: now }],
    session_id: sessionId,
    is_anonymous: false,
  };

  const refreshPayload = {
    aud: 'authenticated',
    exp: refreshExpiresAt,
    iat: now,
    iss: (SUPABASE_URL ?? '') + '/auth/v1',
    sub: userId,
    session_id: sessionId,
  };

  const access_token = jwt.sign(accessPayload, secret, { algorithm: 'HS256' });
  const refresh_token = jwt.sign(refreshPayload, secret, { algorithm: 'HS256' });

  return {
    access_token,
    refresh_token,
    expires_in: SESSION_EXPIRES_IN,
    expires_at: expiresAt,
    token_type: 'bearer',
  };
}

/**
 * Generate anonymous session tokens.
 * Anonymous users get a UUID and can use the service without phone verification.
 */
export function generateAnonymousSession(): AnonymousSessionResult {
  if (
    SUPABASE_JWT_SECRET === undefined ||
    SUPABASE_JWT_SECRET === '' ||
    SUPABASE_URL === undefined ||
    SUPABASE_URL === ''
  ) {
    throw new AuthConfigError('Missing SUPABASE_JWT_SECRET or SUPABASE_URL');
  }

  const secret = SUPABASE_JWT_SECRET;
  const userId = uuidv4();
  const sessionId = uuidv4();

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_EXPIRES_IN;

  const accessPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: SUPABASE_URL + '/auth/v1',
    sub: userId,
    email: '',
    phone: '',
    app_metadata: {
      provider: 'anonymous',
      providers: ['anonymous'],
    },
    user_metadata: {},
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'anonymous', timestamp: now }],
    session_id: sessionId,
    is_anonymous: true,
  };

  const refreshPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: SUPABASE_URL + '/auth/v1',
    sub: userId,
    session_id: sessionId,
  };

  const access_token = jwt.sign(accessPayload, secret, { algorithm: 'HS256' });
  const refresh_token = jwt.sign(refreshPayload, secret, { algorithm: 'HS256' });

  return {
    user: {
      id: userId,
      is_anonymous: true,
    },
    session: {
      access_token,
      refresh_token,
      expires_in: SESSION_EXPIRES_IN,
      expires_at: expiresAt,
      token_type: 'bearer',
    },
  };
}
