/**
 * Browser OAuth for ChatGPT-managed Codex credentials.
 *
 * This mirrors the public Codex CLI login contract: auth.openai.com, PKCE S256,
 * the allow-listed localhost callback, and a complete id/access/refresh token
 * set. The browser may be remote; CDP reads the callback URL before Chromium's
 * failed localhost navigation can hide the one-time code.
 */

import { createHash, randomBytes } from 'node:crypto';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

const b64url = (value: Buffer) => value.toString('base64url');

export interface CodexAuthorizeRequest {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

export interface CodexGrant {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  accountEmail?: string;
  expiresIn: number;
}

/** Build the same authorization request as the first-party Codex CLI. */
export function buildCodexAuthorizeUrl(): CodexAuthorizeRequest {
  const verifier = b64url(randomBytes(64));
  const state = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'codex_cli_rs',
  });
  return {
    url: `${CODEX_AUTHORIZE_URL}?${query.toString()}`,
    verifier,
    state,
    redirectUri: CODEX_REDIRECT_URI,
  };
}

/**
 * Run in every page target because SSO can move the callback to a popup.
 * Only the allow-listed Codex loopback ports and exact callback path qualify.
 */
export const READ_CODEX_CALLBACK = `(function(){
  try {
    var u = new URL(location.href);
    if (u.protocol !== 'http:' || u.hostname !== 'localhost') return null;
    if (u.port !== '1455' && u.port !== '1457') return null;
    if (u.pathname !== '/auth/callback') return null;
    if (!u.searchParams.get('code') && !u.searchParams.get('error')) return null;
    return u.href;
  } catch (_) {
    return null;
  }
})()`;

export function parseCodexCallbackUrl(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl);
  const callbackPort = url.port === '1455' || url.port === '1457';
  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'localhost' ||
    !callbackPort ||
    url.pathname !== '/auth/callback'
  ) {
    throw new Error('unexpected Codex OAuth callback URL');
  }
  const state = url.searchParams.get('state');
  if (state === null || state !== expectedState) {
    throw new Error('Codex OAuth state mismatch');
  }
  const providerError = url.searchParams.get('error');
  if (providerError !== null) {
    const description = url.searchParams.get('error_description');
    throw new Error(
      `Codex OAuth denied: ${providerError}${description ? ` (${description})` : ''}`
    );
  }
  const code = url.searchParams.get('code');
  if (code === null || code.length === 0) throw new Error('Codex OAuth callback had no code');
  return code;
}

function jwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  if (encoded === undefined || encoded.length === 0) return {};
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function identityFromIdToken(idToken: string): {
  accountId?: string;
  accountEmail?: string;
} {
  const claims = jwtPayload(idToken);
  const auth =
    claims['https://api.openai.com/auth'] !== null &&
    typeof claims['https://api.openai.com/auth'] === 'object'
      ? (claims['https://api.openai.com/auth'] as Record<string, unknown>)
      : {};
  const profile =
    claims['https://api.openai.com/profile'] !== null &&
    typeof claims['https://api.openai.com/profile'] === 'object'
      ? (claims['https://api.openai.com/profile'] as Record<string, unknown>)
      : {};
  return {
    accountId: stringField(auth.chatgpt_account_id) ?? stringField(claims.chatgpt_account_id),
    accountEmail: stringField(claims.email) ?? stringField(profile.email),
  };
}

function accessTokenLifetimeSeconds(accessToken: string): number {
  const exp = jwtPayload(accessToken).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return 3600;
  return Math.max(1, Math.floor(exp - Date.now() / 1000));
}

/** Exchange the one-time callback code with the original PKCE verifier. */
export async function exchangeCodexAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri = CODEX_REDIRECT_URI,
  fetchImpl: typeof fetch = fetch
): Promise<CodexGrant> {
  if (code.length === 0 || verifier.length === 0) {
    throw new Error('Codex OAuth exchange requires a code and PKCE verifier');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  });
  const response = await fetchImpl(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Codex OAuth exchange failed ${response.status}: ${detail}`);
  }
  const tokens = (await response.json()) as {
    id_token?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
  };
  const idToken = stringField(tokens.id_token);
  const accessToken = stringField(tokens.access_token);
  const refreshToken = stringField(tokens.refresh_token);
  if (idToken === undefined || accessToken === undefined || refreshToken === undefined) {
    throw new Error('Codex OAuth exchange returned an incomplete token set');
  }
  const identity = identityFromIdToken(idToken);
  if (identity.accountId === undefined) {
    throw new Error('Codex ID token did not contain a ChatGPT account id');
  }
  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: identity.accountId,
    accountEmail: identity.accountEmail,
    expiresIn: accessTokenLifetimeSeconds(accessToken),
  };
}
