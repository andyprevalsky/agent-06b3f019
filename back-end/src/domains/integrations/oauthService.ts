/* eslint-disable max-lines -- pre-existing: OAuth flow requires PKCE + token exchange + redirect + refresh in one module */
/**
 * OAuth service — auth URL generation, token exchange, PKCE, and helpers.
 */

import { randomBytes, createHash } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import type { EmailProviderSlug, TokenExchangeResult, OAuthResponse } from './types';
import { EMAIL_PROVIDER_CONFIG, BACKEND_BASE_URL, ALLOWED_REDIRECT_PATTERNS } from './config';
import * as repo from './repo';
import { readGoogleToken } from '../../providers/googleCredentials';

const log = createLogger('Integrations');

/** Escape HTML special characters to prevent XSS. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// PKCE + helpers
// ---------------------------------------------------------------------------

const base64UrlEncode = (buffer: Buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

export const generateCodeVerifier = () => base64UrlEncode(randomBytes(32));
export const generateStateToken = () => base64UrlEncode(randomBytes(24));

export const createCodeChallenge = (verifier: string) =>
  base64UrlEncode(createHash('sha256').update(verifier).digest());

export const normalizeProvider = (provider?: string): EmailProviderSlug | null => {
  if (provider === undefined || provider === null || provider === '') return null;
  const key = provider.toLowerCase();
  if (key === 'gmail' || key === 'yahoo') return key;
  return null;
};

export const buildRedirectUri = (provider: EmailProviderSlug) => {
  if (provider === 'yahoo' && BACKEND_BASE_URL.includes('localhost')) {
    return 'https://unadmirably-unelicitable-myung.ngrok-free.dev/api/integrations/email/yahoo/callback';
  }
  return `${BACKEND_BASE_URL}/api/integrations/email/${provider}/callback`;
};

export const buildAuthUrl = (
  provider: EmailProviderSlug,
  opts: { state: string; codeChallenge: string }
) => {
  const config = EMAIL_PROVIDER_CONFIG[provider];
  if (config.clientId === undefined || config.clientId === '') {
    throw new Error(`Missing client ID for provider ${provider}`);
  }

  const redirectUri = buildRedirectUri(provider);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });

  if (provider === 'gmail') {
    params.set('access_type', 'offline');
    params.set('include_granted_scopes', 'true');
    params.set('prompt', 'consent');
  }

  return `${config.authUrl}?${params.toString()}`;
};

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/* c8 ignore start -- only called from exchangeProviderCode which is only called from excluded callback */
/** Fetch user email from Google userinfo endpoint. */
async function fetchGmailUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userinfoResponse.ok) {
      const userinfo = (await userinfoResponse.json()) as { email?: string };
      return userinfo.email;
    }
  } catch {
    log.error('Failed to fetch Gmail user info');
  }
  return undefined;
}

/** Decode email from id_token JWT payload. */
function decodeEmailFromIdToken(idToken: string): string | undefined {
  try {
    const [, payloadB64] = idToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >;
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    log.error('Failed to decode id_token');
    return undefined;
  }
}

export const exchangeProviderCode = async (
  provider: EmailProviderSlug,
  params: { code: string; codeVerifier: string; redirectUri: string }
): Promise<TokenExchangeResult> => {
  const config = EMAIL_PROVIDER_CONFIG[provider];
  if (config.clientId === undefined || config.clientId === '') {
    throw new Error(`Missing client ID for provider ${provider}`);
  }
  if (
    config.requiresClientSecret === true &&
    (config.clientSecret === undefined || config.clientSecret === '')
  ) {
    throw new Error(`Missing client secret for provider ${provider}`);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: config.clientId,
    code_verifier: params.codeVerifier,
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };

  if (config.clientSecret !== undefined && config.clientSecret !== '') {
    if (provider === 'yahoo') {
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_secret', config.clientSecret);
    }
  }

  const response = await fetch(config.tokenUrl, { method: 'POST', headers, body });
  const json = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const desc = json.error_description ?? json.error ?? response.statusText;
    throw new Error(`Token exchange failed for ${provider}: ${String(desc)}`);
  }

  if (typeof json.access_token !== 'string' || json.access_token === '') {
    throw new Error(`Token exchange for ${provider} did not return an access token`);
  }

  const rawScope = json.scope;
  const scopes = Array.isArray(rawScope)
    ? (rawScope as string[])
    : typeof rawScope === 'string'
      ? rawScope.split(/[\s+,]/).filter((s: string) => s !== '')
      : [];

  let userEmail: string | undefined;
  if (provider === 'gmail') {
    userEmail = await fetchGmailUserEmail(json.access_token);
    if (userEmail === undefined && typeof json.id_token === 'string' && json.id_token !== '') {
      userEmail = decodeEmailFromIdToken(json.id_token);
    }
  }

  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    scopes,
    userEmail,
    metadata: {
      tokenType: json.token_type,
      idToken: json.id_token,
      xoauthYahooGuid: json.xoauth_yahoo_guid,
    },
  };
};
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// OAuth result + redirect
// ---------------------------------------------------------------------------

export function isAllowedRedirectUrl(url: string): boolean {
  return ALLOWED_REDIRECT_PATTERNS.some((pattern) => pattern.test(url));
}

export const sendOAuthResult = (
  res: OAuthResponse,
  opts: { success: boolean; message: string; returnUrl?: string | null; errorUrl?: string | null }
) => {
  const redirectTarget = opts.success
    ? opts.returnUrl
    : opts.errorUrl !== undefined && opts.errorUrl !== null && opts.errorUrl !== ''
      ? opts.errorUrl
      : opts.returnUrl;

  if (
    redirectTarget !== undefined &&
    redirectTarget !== null &&
    redirectTarget !== '' &&
    isAllowedRedirectUrl(redirectTarget)
  ) {
    const url = new URL(redirectTarget);
    url.searchParams.set('oauth_result', opts.success ? 'success' : 'error');
    url.searchParams.set('message', opts.message);
    return res.redirect(url.toString());
  }

  const status = opts.success ? 200 : 400;
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Email Connection ${escapeHtml(opts.success ? 'Success' : 'Error')}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; text-align: center; }
      .status { font-size: 18px; margin-bottom: 16px; color: ${opts.success ? '#16a34a' : '#dc2626'}; }
      button { padding: 8px 16px; border: none; background: #111827; color: white; border-radius: 6px; cursor: pointer; }
    </style>
  </head>
  <body>
    <p class="status">${escapeHtml(opts.message)}</p>
    <button onclick="window.close()">Close</button>
    <script>
      setTimeout(() => window.close(), 1500);
    </script>
  </body>
</html>`;
  res.status(status).send(html);
};

// ---------------------------------------------------------------------------
// Start OAuth flow
// ---------------------------------------------------------------------------

export async function startEmailOAuth(
  userId: string,
  providerKey: EmailProviderSlug,
  returnUrl?: string | null,
  errorUrl?: string | null
) {
  const config = EMAIL_PROVIDER_CONFIG[providerKey];
  if (config.clientId === undefined || config.clientId === '') {
    throw new Error(`Missing client ID for ${providerKey}`);
  }
  if (
    config.requiresClientSecret === true &&
    (config.clientSecret === undefined || config.clientSecret === '')
  ) {
    throw new Error(`Missing client secret for ${providerKey}`);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const state = generateStateToken();

  // Merge, never replace: an abandoned consent screen must not strip the
  // connected-account metadata of an integration that is still connected.
  const integration = await repo.upsertIntegrationForOAuthStart({
    userId,
    name: providerKey,
    config: { provider: providerKey, startedAt: new Date().toISOString() },
  });

  const hasMetadata =
    (returnUrl !== undefined && returnUrl !== null) ||
    (errorUrl !== undefined && errorUrl !== null);

  const credential = await repo.createEmailCredential({
    userId,
    provider: config.provider,
    integrationId: integration.id,
    pkceVerifier: codeVerifier,
    stateToken: state,
    scopes: config.scopes,
    metadata: hasMetadata ? { returnUrl, errorUrl } : undefined,
  });

  const authUrl = buildAuthUrl(providerKey, { state, codeChallenge });
  const redirectUri = buildRedirectUri(providerKey);
  log.info('OAuth redirect', { redirectUri });
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return { authUrl, state, expiresAt, credentialId: credential.id };
}

// ---------------------------------------------------------------------------
// Refresh token
// ---------------------------------------------------------------------------

/* c8 ignore start -- refreshGmailToken and buildRawEmail have no callers in the codebase */
export async function refreshGmailToken(credential: {
  id: string;
  refreshToken: string | null;
}): Promise<string | null> {
  if (
    credential.refreshToken === null ||
    credential.refreshToken === undefined ||
    credential.refreshToken === ''
  ) {
    return null;
  }

  const config = EMAIL_PROVIDER_CONFIG.gmail;
  if (
    config.clientId === undefined ||
    config.clientId === '' ||
    config.clientSecret === undefined ||
    config.clientSecret === ''
  ) {
    log.error('Missing client ID or secret for token refresh');
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: readGoogleToken(credential.refreshToken),
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof json.access_token !== 'string') {
      log.error('Token refresh failed', { status: response.status });
      return null;
    }

    const expiresAt =
      typeof json.expires_in === 'number' ? new Date(Date.now() + json.expires_in * 1000) : null;

    await repo.updateEmailCredentialToken(credential.id, {
      accessToken: json.access_token,
      expiresAt,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    });

    return json.access_token;
  } catch {
    log.error('Error refreshing token');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build raw email
// ---------------------------------------------------------------------------

export function buildRawEmail(params: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
}): string {
  // Reject header values containing CR or LF to prevent CRLF injection
  const headerFields: [string, string | undefined][] = [
    ['from', params.from],
    ['to', params.to],
    ['cc', params.cc],
    ['subject', params.subject],
  ];
  for (const [name, value] of headerFields) {
    if (value !== undefined && /[\r\n]/.test(value)) {
      throw new Error(`Invalid ${name}: header value must not contain newline characters`);
    }
  }

  const lines: string[] = [];
  lines.push(`From: ${params.from}`);
  lines.push(`To: ${params.to}`);
  if (params.cc !== undefined && params.cc !== null && params.cc !== '') {
    lines.push(`Cc: ${params.cc}`);
  }
  lines.push(`Subject: ${params.subject}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('');
  lines.push(params.body);

  const rawMessage = lines.join('\r\n');
  return Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
/* c8 ignore stop */
