import { encryptGoogleToken } from '../../providers/googleCredentials';
import { missingGoogleScopes } from './googleScopes';
import type { EmailProviderSlug, TokenExchangeResult } from './types';

/** Turn Google's actual grant into a stored, user-visible credential state. */
export function storedOAuthGrant(
  provider: EmailProviderSlug,
  token: TokenExchangeResult,
  priorRefreshToken: string | null
) {
  const refreshToken = token.refreshToken ?? priorRefreshToken;
  const complete = provider !== 'gmail' || missingGoogleScopes(token.scopes).length === 0;
  return {
    accessToken: provider === 'gmail' ? encryptGoogleToken(token.accessToken) : token.accessToken,
    refreshToken:
      provider === 'gmail' && refreshToken !== null
        ? encryptGoogleToken(refreshToken)
        : refreshToken,
    state: complete ? 'connected' : 'needs_reconnect',
    lastErrorReason: complete ? null : 'Reconnect Google to grant the current permissions.',
    complete,
  };
}
