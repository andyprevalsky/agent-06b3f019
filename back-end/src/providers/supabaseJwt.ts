import { createSecretKey, type KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { createLogger } from './logger';

/**
 * Canonical Supabase access-token verifier used by every auth middleware.
 *
 * Two token shapes are legitimate and both must be accepted:
 *
 *  1. **HS256 (backend-minted).** After phone-OTP verification our backend mints
 *     its own session with `jwt.sign(..., { algorithm: 'HS256' })` using the
 *     shared `SUPABASE_JWT_SECRET` (see domains/auth/service.session.ts). This is
 *     what real users carry.
 *
 *  2. **ES256 (Supabase-issued).** Supabase has migrated to asymmetric JWT
 *     signing keys — a direct Supabase login (`supabase.auth.signInWithPassword`,
 *     used by the chat-lifecycle ratchet and any first-party Supabase client)
 *     returns an ES256 token with a `kid`, signed by the project's JWKS key.
 *     The legacy shared secret CANNOT verify these.
 *
 * Verifying HS256 only (the previous behavior) rejected every Supabase-issued
 * token with 401 "Invalid or expired token" — which broke the ratchet's browser
 * session (`isFullySignedIn: false`, no chat, 0 realtime bubbles) and would
 * break any real user the moment Supabase stops dual-minting the legacy secret.
 *
 * We branch on the token header `alg`: HS256 → shared secret; anything
 * asymmetric → the project JWKS. Both enforce the Supabase issuer and standard
 * expiry. jose's remote key set caches keys and handles rotation.
 */

const log = createLogger('SupabaseJwt');

let cachedSecretKey: KeyObject | null = null;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getIssuer(): string {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (supabaseUrl === undefined || supabaseUrl === '') {
    throw new Error('Missing SUPABASE_URL environment variable');
  }
  return `${supabaseUrl}/auth/v1`;
}

function getHs256Secret(): KeyObject {
  if (cachedSecretKey !== null) return cachedSecretKey;
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret === undefined || secret === '') {
    throw new Error('Missing SUPABASE_JWT_SECRET environment variable');
  }
  cachedSecretKey = createSecretKey(Buffer.from(secret));
  return cachedSecretKey;
}

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks !== null) return cachedJwks;
  cachedJwks = createRemoteJWKSet(new URL(`${getIssuer()}/.well-known/jwks.json`));
  return cachedJwks;
}

/** Resolver shape accepted by jose's `jwtVerify` for asymmetric keys. */
type JwksResolver = Parameters<typeof jwtVerify>[1];

/**
 * The operator acting on behalf of `sub`, from the RFC 8693 `act` claim.
 *
 * This repo has TWO authentication middlewares over the same tokens
 * (providers/auth.ts and providers/hybridAuth.ts). When only one of them read
 * this claim, impersonated sessions were invisible to every route behind the
 * other — which is how an admin's machine data reached another user's account.
 * Both MUST derive the actor here so they cannot drift apart again.
 *
 * Returns undefined for an ordinary login.
 */
export function impersonatorFromPayload(payload: jwt.JwtPayload): string | undefined {
  const actor = (payload as { act?: { sub?: unknown } }).act?.sub;
  return typeof actor === 'string' && actor !== '' ? actor : undefined;
}

/**
 * How the session was established: the first `amr` method (`otp`,
 * `impersonation`, `anonymous`, `preview_handoff`, ...), or undefined when the
 * token carries none. Both auth middlewares expose it as `req.user.authMethod`
 * so a route can refuse a preview-handoff session that tries to mint further
 * credentials.
 */
export function sessionMethodFromPayload(payload: jwt.JwtPayload): string | undefined {
  const amr = (payload as { amr?: unknown }).amr;
  if (!Array.isArray(amr) || amr.length === 0) return undefined;
  const method = (amr[0] as { method?: unknown } | null)?.method;
  return typeof method === 'string' && method !== '' ? method : undefined;
}

/**
 * Verify a Supabase access token and return its payload, or throw if the token
 * is invalid/expired/wrong-issuer. Accepts both the backend's HS256 tokens and
 * Supabase's asymmetric (ES256) tokens.
 *
 * `jwksOverride` exists only for hermetic tests — inject a local JWKS so the
 * ES256 branch can be exercised without hitting the network. Production always
 * uses the cached remote Supabase JWKS.
 */
export async function verifySupabaseAccessToken(
  token: string,
  jwksOverride?: JwksResolver
): Promise<jwt.JwtPayload> {
  const issuer = getIssuer();

  const decoded = jwt.decode(token, { complete: true });
  const alg = decoded !== null && typeof decoded === 'object' ? decoded.header.alg : undefined;

  let payload: jwt.JwtPayload;
  if (alg === 'HS256') {
    // Backend-minted token — verify with the shared secret.
    payload = jwt.verify(token, getHs256Secret(), {
      issuer,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
  } else {
    // Supabase-issued asymmetric token — verify against the project JWKS.
    // Pin to ES256 (the project's current signing alg) so a future non-ES256
    // key in the JWKS can't silently widen the set of accepted algorithms.
    try {
      const result = await jwtVerify(token, jwksOverride ?? getJwks(), {
        issuer,
        algorithms: ['ES256'],
      });
      payload = result.payload as JWTPayload as jwt.JwtPayload;
    } catch (err) {
      // Surface a concise reason; callers translate to 401.
      log.error('JWKS verification failed', {
        alg: typeof alg === 'string' ? alg : 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Both auth middlewares dereference `payload.sub!`, and a token without `exp`
  // would never expire — require both before trusting the token.
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Token is missing a subject (sub) claim');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('Token is missing an expiry (exp) claim');
  }

  return payload;
}
