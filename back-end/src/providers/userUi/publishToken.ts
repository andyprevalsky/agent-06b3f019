/**
 * Short-lived, single-purpose bearer tokens that let a code-agent sandbox
 * publish its user's rose_user_ui bundle without holding a user session or the
 * backend API key.
 *
 *   ruip.<base64url(JSON {sub, scope, iat, exp, agt?})>.<base64url(HMAC-SHA256)>
 *
 * `agt` is the code agent whose session holds the token, so a publish can be
 * announced on that agent's realtime channel (and its root's).
 *
 * The HMAC secret is USER_UI_TOKEN_SECRET, else a labelled derivation of
 * SUPABASE_JWT_SECRET (never BACKEND_API_KEY, and never the raw JWT secret, so
 * a publish token can never be confused with a session JWT).
 */
import crypto from 'crypto';

export const USER_UI_PUBLISH_SCOPE = 'user-ui:publish';
export const USER_UI_PUBLISH_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const TOKEN_PREFIX = 'ruip.';

export interface UserUiPublishClaims {
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  agt?: string;
}

function tokenSecret(): Buffer {
  const explicit = process.env.USER_UI_TOKEN_SECRET?.trim();
  if (explicit) return Buffer.from(explicit, 'utf8');
  const base = process.env.SUPABASE_JWT_SECRET?.trim();
  if (!base) throw new Error('USER_UI_TOKEN_SECRET or SUPABASE_JWT_SECRET must be configured');
  return crypto.createHmac('sha256', base).update('rose-user-ui-publish-token-v1').digest();
}

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(`${TOKEN_PREFIX}${payload}`)
    .digest('base64url');
}

export function isUserUiPublishToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

/** Mint a token. `scope`/`ttlSeconds`/`nowSeconds` exist for tests of rejection paths. */
export function mintUserUiPublishToken(
  userId: string,
  options: { agentId?: string; scope?: string; ttlSeconds?: number; nowSeconds?: number } = {}
): { token: string; expiresAt: string } {
  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (options.ttlSeconds ?? USER_UI_PUBLISH_TOKEN_TTL_SECONDS);
  const claims: UserUiPublishClaims = {
    sub: userId,
    scope: options.scope ?? USER_UI_PUBLISH_SCOPE,
    iat,
    exp,
    ...(options.agentId ? { agt: options.agentId } : {}),
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    token: `${TOKEN_PREFIX}${payload}.${sign(payload)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export type UserUiPublishTokenCheck =
  | { ok: true; userId: string; agentId: string | null }
  | { ok: false; reason: 'malformed' | 'signature' | 'scope' | 'expired' };

export function verifyUserUiPublishToken(token: string): UserUiPublishTokenCheck {
  if (!isUserUiPublishToken(token)) return { ok: false, reason: 'malformed' };
  const [payload, signature, ...rest] = token.slice(TOKEN_PREFIX.length).split('.');
  if (!payload || !signature || rest.length > 0) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'signature' };
  }
  let claims: Partial<UserUiPublishClaims>;
  try {
    claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as Partial<UserUiPublishClaims>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || typeof claims.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.scope !== USER_UI_PUBLISH_SCOPE) return { ok: false, reason: 'scope' };
  if (claims.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  const agentId = typeof claims.agt === 'string' && claims.agt.length > 0 ? claims.agt : null;
  return { ok: true, userId: claims.sub, agentId };
}
