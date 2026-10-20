/**
 * Short-lived bearer tokens that let ONE code-agent sandbox post media into
 * ONE agent's trajectory (`rose-display` CLI → POST /api/display/:agentId).
 *
 *   rdsp.<base64url(JSON {sub, agt, scope, iat, exp})>.<base64url(HMAC-SHA256)>
 *
 * `sub` is the agent owner's user id, `agt` the agent whose trajectory the
 * token may post to. The HMAC key is DISPLAY_TOKEN_SECRET, else a labelled
 * derivation of USER_UI_TOKEN_SECRET / SUPABASE_JWT_SECRET distinct from the
 * rose-ui publish key, so neither token can be replayed as the other (or as a
 * session JWT).
 */
import crypto from 'crypto';

export const DISPLAY_TOKEN_SCOPE = 'display:post';
export const DISPLAY_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const TOKEN_PREFIX = 'rdsp.';

interface DisplayTokenClaims {
  sub: string;
  agt: string;
  scope: string;
  iat: number;
  exp: number;
}

function tokenSecret(): Buffer {
  const explicit = process.env.DISPLAY_TOKEN_SECRET?.trim();
  if (explicit) return Buffer.from(explicit, 'utf8');
  const base = process.env.USER_UI_TOKEN_SECRET?.trim() || process.env.SUPABASE_JWT_SECRET?.trim();
  if (!base) {
    throw new Error(
      'DISPLAY_TOKEN_SECRET, USER_UI_TOKEN_SECRET or SUPABASE_JWT_SECRET must be set'
    );
  }
  return crypto.createHmac('sha256', base).update('rose-display-token-v1').digest();
}

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(`${TOKEN_PREFIX}${payload}`)
    .digest('base64url');
}

export function isDisplayToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

/** Mint a token. `scope`/`ttlSeconds`/`nowSeconds` exist for rejection-path tests. */
export function mintDisplayToken(
  userId: string,
  agentId: string,
  options: { scope?: string; ttlSeconds?: number; nowSeconds?: number } = {}
): { token: string; expiresAt: string } {
  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (options.ttlSeconds ?? DISPLAY_TOKEN_TTL_SECONDS);
  const claims: DisplayTokenClaims = {
    sub: userId,
    agt: agentId,
    scope: options.scope ?? DISPLAY_TOKEN_SCOPE,
    iat,
    exp,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    token: `${TOKEN_PREFIX}${payload}.${sign(payload)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export type DisplayTokenCheck =
  | { ok: true; userId: string; agentId: string }
  | { ok: false; reason: 'malformed' | 'signature' | 'scope' | 'expired' };

export function verifyDisplayToken(token: string): DisplayTokenCheck {
  if (!isDisplayToken(token)) return { ok: false, reason: 'malformed' };
  const [payload, signature, ...rest] = token.slice(TOKEN_PREFIX.length).split('.');
  if (!payload || !signature || rest.length > 0) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'signature' };
  }
  let claims: Partial<DisplayTokenClaims>;
  try {
    claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as Partial<DisplayTokenClaims>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    typeof claims.agt !== 'string' ||
    claims.agt.length === 0 ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.scope !== DISPLAY_TOKEN_SCOPE) return { ok: false, reason: 'scope' };
  if (claims.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, userId: claims.sub, agentId: claims.agt };
}
