/**
 * Session minting for the auth domain.
 *
 * The signing logic itself lives in providers/sessionTokens.ts because
 * domains/admin-health also mints sessions (admin account switching) and
 * cross-domain imports are banned by the structural layer-deps test. This file
 * stays as the auth domain's entry point so existing callers keep their import
 * path.
 */

export {
  AuthConfigError,
  generateAnonymousSession,
  generateSupabaseSession,
  REFRESH_TOKEN_EXPIRES_IN,
  SESSION_EXPIRES_IN,
} from '../../providers/sessionTokens';
