/**
 * Canonical Supabase session-token minter.
 *
 * This is the ONE place that signs user JWTs. It lives in providers/ (not in
 * domains/auth) because more than one domain needs to mint a session:
 *   - domains/auth      → OTP verification + anonymous bootstrap
 *   - domains/admin-health → admin account switching (impersonation)
 *   - codePreview/handoff → one-time preview sign-in (Rose-in-Rose, L-APPS2)
 *
 * ESLint bans `jsonwebtoken` inside src/domains/**, and the structural
 * layer-deps test bans cross-domain imports, so the shared minting logic has to
 * live here rather than being re-imported across domains.
 */

import jwt from 'jsonwebtoken';

import { randomUUID } from './crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/** Access token expiry: 90 days in seconds */
export const SESSION_EXPIRES_IN = 7776000;

/** Refresh token expiry: 180 days in seconds */
export const REFRESH_TOKEN_EXPIRES_IN = 15552000;

/**
 * Impersonated-session expiry: 1 hour in seconds.
 *
 * Admin account switching is an operator action, not a login, so the minted
 * session is deliberately short-lived and non-renewable beyond that window.
 */
export const IMPERSONATION_EXPIRES_IN = 3600;

/**
 * Preview-handoff session expiry: 8 hours in seconds. The session lives in a
 * code-agent preview origin whose dev server the agent controls, so it is
 * short-lived and cannot be refreshed.
 */
export const PREVIEW_HANDOFF_EXPIRES_IN = 8 * 60 * 60;

/** `amr` method of a preview-handoff session; credential-minting routes refuse it. */
export const PREVIEW_HANDOFF_AMR = 'preview_handoff';

/** Identifies the admin acting on behalf of the target user. */
export interface ImpersonationContext {
  actorUserId: string;
}

/** The code-agent task whose preview a handoff session signs into. */
export interface PreviewHandoffContext {
  taskId: string;
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

export class AuthConfigError extends Error {
  constructor(detail: string) {
    super(`Auth configuration error: ${detail}`);
  }
}

function requireSigningConfig(): { secret: string; issuer: string } {
  // SUPABASE_URL is required, not optional: it forms the `iss` claim. Falling
  // back to '' would silently mint tokens with iss '/auth/v1', which fails
  // downstream issuer verification while giving no signal about the real cause.
  if (
    SUPABASE_JWT_SECRET === undefined ||
    SUPABASE_JWT_SECRET === '' ||
    SUPABASE_URL === undefined ||
    SUPABASE_URL === ''
  ) {
    throw new AuthConfigError('Missing SUPABASE_JWT_SECRET or SUPABASE_URL');
  }
  return { secret: SUPABASE_JWT_SECRET, issuer: SUPABASE_URL + '/auth/v1' };
}

/** Lifetime, renewability and `amr`/actor claims of one phone-user session. */
interface UserSessionShape {
  lifetime: number;
  /** false: the refresh token expires with the access token (no renewal). */
  refreshable: boolean;
  method: string;
  appMetadata: Record<string, string>;
  actorUserId?: string;
}

function signUserSession(userId: string, phone: string, shape: UserSessionShape): SessionTokens {
  const { secret, issuer } = requireSigningConfig();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + shape.lifetime;
  const refreshExpiresAt = shape.refreshable ? now + REFRESH_TOKEN_EXPIRES_IN : expiresAt;
  // RFC 8693 `act` (actor) claim: identifies who is acting on behalf of `sub`.
  // Without it an impersonated action is indistinguishable from the target
  // user's own activity.
  const act = shape.actorUserId !== undefined ? { act: { sub: shape.actorUserId } } : {};

  const sessionId = randomUUID();
  const accessPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: issuer,
    sub: userId,
    email: '',
    phone,
    phone_confirmed_at: new Date().toISOString(),
    app_metadata: {
      provider: 'phone',
      providers: ['phone'],
      ...shape.appMetadata,
    },
    user_metadata: {},
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: shape.method, timestamp: now }],
    session_id: sessionId,
    is_anonymous: false,
    ...act,
  };

  const refreshPayload = {
    aud: 'authenticated',
    exp: refreshExpiresAt,
    iat: now,
    iss: issuer,
    sub: userId,
    session_id: sessionId,
    ...act,
  };

  const access_token = jwt.sign(accessPayload, secret, { algorithm: 'HS256' });
  const refresh_token = jwt.sign(refreshPayload, secret, { algorithm: 'HS256' });

  return {
    access_token,
    refresh_token,
    expires_in: shape.lifetime,
    expires_at: expiresAt,
    token_type: 'bearer',
  };
}

/**
 * Generate JWT session tokens signed with HS256.
 * Uses the JWT secret directly as a string.
 */
export function generateSupabaseSession(
  userId: string,
  phone: string,
  impersonation?: ImpersonationContext
): SessionTokens {
  if (impersonation === undefined) {
    return signUserSession(userId, phone, {
      lifetime: SESSION_EXPIRES_IN,
      refreshable: true,
      method: 'otp',
      appMetadata: {},
    });
  }
  // An impersonated session is a short-lived operator tool, not a login. It must
  // not inherit the 90-day lifetime of a real phone session. The operator is
  // mirrored into app_metadata so log/analytics consumers that only read
  // app_metadata can still attribute the action.
  return signUserSession(userId, phone, {
    lifetime: IMPERSONATION_EXPIRES_IN,
    refreshable: false,
    method: 'impersonation',
    appMetadata: { impersonated_by: impersonation.actorUserId },
    actorUserId: impersonation.actorUserId,
  });
}

/**
 * The session a one-time preview handoff code redeems to (Rose-in-Rose,
 * L-APPS2): the user's own identity for 8 h, never refreshable, marked
 * `amr: preview_handoff` so credential-minting routes can refuse it.
 * app_metadata names the preview task.
 */
export function generatePreviewHandoffSession(
  userId: string,
  phone: string,
  handoff: PreviewHandoffContext
): SessionTokens {
  return signUserSession(userId, phone, {
    lifetime: PREVIEW_HANDOFF_EXPIRES_IN,
    refreshable: false,
    method: PREVIEW_HANDOFF_AMR,
    appMetadata: { preview_task_id: handoff.taskId },
  });
}

/**
 * Generate anonymous session tokens.
 * Anonymous users get a UUID and can use the service without phone verification.
 */
export function generateAnonymousSession(): AnonymousSessionResult {
  const { secret, issuer } = requireSigningConfig();
  const userId = randomUUID();
  const sessionId = randomUUID();

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_EXPIRES_IN;
  const refreshExpiresAt = now + REFRESH_TOKEN_EXPIRES_IN;

  const accessPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: issuer,
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
    // The refresh token must outlive the access token, otherwise the session can
    // never be refreshed — it would expire at the same instant it needs renewing.
    exp: refreshExpiresAt,
    iat: now,
    iss: issuer,
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
