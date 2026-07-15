/**
 * AgentCard OAuth 2.1 + PKCE primitives (pure, no I/O beyond the token endpoint).
 *
 * Gotchas enforced here:
 *  - `resource` (= the MCP server URL) is MANDATORY on /authorize AND /token.
 *  - PKCE is always enforced (S256), even for confidential clients.
 *  - Confidential clients send `client_secret` on BOTH the code exchange and refresh.
 *  - Refresh ROTATES the refresh token — callers must persist the returned one.
 */

import { randomBytes, createHash } from '../crypto';
import {
  AGENTCARD_AUTHORIZE_ENDPOINT,
  AGENTCARD_TOKEN_ENDPOINT,
  AGENTCARD_MCP_RESOURCE,
  AgentCardOAuthError,
} from './config';
import type { PkcePair, TokenSet } from './types';

export type { PkcePair, TokenSet } from './types';

const base64Url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

/** code_verifier = base64url(32 random bytes); code_challenge = base64url(sha256(verifier)). */
export function generatePkce(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64Url(randomBytes(24));
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    resource: AGENTCARD_MCP_RESOURCE,
    state: opts.state,
  });
  return `${AGENTCARD_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

type FetchLike = typeof fetch;

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postToken(body: URLSearchParams, fetchImpl: FetchLike): Promise<TokenSet> {
  const response = await fetchImpl(AGENTCARD_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });

  const json = (await response.json().catch(() => ({}))) as RawTokenResponse;

  if (!response.ok) {
    const code = typeof json.error === 'string' ? json.error : String(response.status);
    const detail = typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
    throw new AgentCardOAuthError(
      `AgentCard token request failed (${code})${detail}`,
      response.status
    );
  }

  if (typeof json.access_token !== 'string' || json.access_token === '') {
    throw new AgentCardOAuthError('AgentCard token response did not include an access_token');
  }

  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 86400;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'bearer',
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

/** Exchange an authorization code for tokens (Part 2). */
export async function exchangeCodeForToken(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  verifier: string;
  fetchImpl?: FetchLike;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
    resource: AGENTCARD_MCP_RESOURCE,
  });
  if (opts.clientSecret !== undefined && opts.clientSecret !== '') {
    body.set('client_secret', opts.clientSecret);
  }
  return postToken(body, opts.fetchImpl ?? fetch);
}

/**
 * Refresh an access token. The refresh token is ROTATED — the caller must persist
 * `result.refreshToken` (falling back to the old one only if the server omitted it).
 */
export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  fetchImpl?: FetchLike;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    resource: AGENTCARD_MCP_RESOURCE,
  });
  if (opts.clientSecret !== undefined && opts.clientSecret !== '') {
    body.set('client_secret', opts.clientSecret);
  }
  const result = await postToken(body, opts.fetchImpl ?? fetch);
  // Preserve the prior refresh token if the server did not rotate one this time.
  if (result.refreshToken === undefined) {
    result.refreshToken = opts.refreshToken;
  }
  return result;
}

/** Whether a token is expired (or within `skewMs` of expiry). Default skew 60s. */
export function isExpired(token: Pick<TokenSet, 'expiresAt'>, skewMs = 60_000): boolean {
  return Date.now() >= token.expiresAt - skewMs;
}
