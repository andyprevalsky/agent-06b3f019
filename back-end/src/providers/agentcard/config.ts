/**
 * AgentCard "for companies" OAuth 2.1 + PKCE + MCP configuration.
 *
 * This integration lets the Rose app issue and manage AgentCard virtual cards ON
 * BEHALF OF each end user: every user authenticates once via "Connect with
 * AgentCard" (OAuth 2.1 + PKCE) and we then call the AgentCard MCP server with
 * that user's bearer token. Cards are isolated per (client, user).
 *
 * The endpoints below match the live discovery documents (verified against
 *   GET https://mcp.agentcard.sh/.well-known/oauth-authorization-server
 *   GET https://mcp.agentcard.sh/.well-known/oauth-protected-resource)
 * and are overridable via env so they can move without a code change.
 */

import crypto from 'node:crypto';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** OAuth 2.1 authorization server (issuer) base. */
export const AGENTCARD_AUTH_SERVER = trimTrailingSlash(
  process.env.AGENTCARD_AUTH_SERVER_URL ?? 'https://mcp.agentcard.sh'
);

/**
 * The MCP protected resource. This exact string is the MANDATORY `resource`
 * parameter on BOTH /authorize and /token, and is the URL we POST JSON-RPC to.
 */
export const AGENTCARD_MCP_RESOURCE = trimTrailingSlash(
  process.env.AGENTCARD_MCP_URL ?? 'https://mcp.agentcard.sh/mcp'
);

export const AGENTCARD_AUTHORIZE_ENDPOINT =
  process.env.AGENTCARD_AUTHORIZE_ENDPOINT ?? `${AGENTCARD_AUTH_SERVER}/authorize`;
export const AGENTCARD_TOKEN_ENDPOINT =
  process.env.AGENTCARD_TOKEN_ENDPOINT ?? `${AGENTCARD_AUTH_SERVER}/token`;
export const AGENTCARD_REVOKE_ENDPOINT =
  process.env.AGENTCARD_REVOKE_ENDPOINT ?? `${AGENTCARD_AUTH_SERVER}/revoke`;

/** The integration row name used to persist each user's token bundle. */
export const AGENTCARD_INTEGRATION_NAME = 'agentcard';

export class AgentCardOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'AgentCardOAuthError';
  }
}

function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new AgentCardOAuthError(`Missing ${name} environment variable`);
  }
  return value.trim();
}

export interface AgentCardOAuthConfig {
  clientId: string;
  /** Present for confidential clients; sent on BOTH token exchange and refresh. */
  clientSecret?: string;
  /** Public base URL (tunnel in local dev). redirect_uri = `${publicUrl}/api/agentcard/callback`. */
  redirectUri: string;
}

/**
 * Reads the pinned confidential-client credentials from the environment. Secrets
 * are read from process.env at call time and never logged.
 */
export function loadOAuthConfig(): AgentCardOAuthConfig {
  const clientId = requiredEnv('AGENTCARD_OAUTH_CLIENT_ID', process.env.AGENTCARD_OAUTH_CLIENT_ID);
  const publicUrl = trimTrailingSlash(
    requiredEnv('AGENTCARD_PUBLIC_URL', process.env.AGENTCARD_PUBLIC_URL)
  );
  const clientSecret = process.env.AGENTCARD_OAUTH_CLIENT_SECRET?.trim();
  return {
    clientId,
    clientSecret: clientSecret !== undefined && clientSecret !== '' ? clientSecret : undefined,
    redirectUri: `${publicUrl}/api/agentcard/callback`,
  };
}

/**
 * The `/connect` route is a browser-tappable GET with no session, so the `user`
 * query param alone is untrusted — anyone could initiate account linking for an
 * arbitrary userId. We therefore bind each connect link to a short-lived HMAC
 * signature over the userId: only the backend (holding the secret) can mint a
 * valid link, and `/connect` rejects any user/signature it did not issue.
 */
const CONNECT_TOKEN_TTL_MS = 15 * 60 * 1000;

function connectSigningSecret(): string {
  const secret =
    process.env.AGENTCARD_CONNECT_SECRET?.trim() || process.env.SUPABASE_JWT_SECRET?.trim();
  if (secret === undefined || secret === '') {
    throw new AgentCardOAuthError(
      'Missing AGENTCARD_CONNECT_SECRET or SUPABASE_JWT_SECRET for connect-link signing'
    );
  }
  return secret;
}

function connectSignature(userId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', connectSigningSecret())
    .update(`${userId}.${expiresAt}`)
    .digest('base64url');
}

/** Mint a short-lived signed connection token bound to `userId`. */
export function signConnectToken(userId: string, now: number = Date.now()): string {
  const expiresAt = now + CONNECT_TOKEN_TTL_MS;
  return `${expiresAt}.${connectSignature(userId, expiresAt)}`;
}

/** Verify a connection token was issued by us for `userId` and has not expired. */
export function verifyConnectToken(
  userId: string,
  token: string,
  now: number = Date.now()
): boolean {
  const separator = token.indexOf('.');
  if (separator <= 0) return false;
  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = connectSignature(userId, expiresAt);
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuffer);
}

/** Public, browser-tappable "Connect with AgentCard" link the app hands to a user. */
export function connectUrlForUser(userId: string): string {
  const publicUrl = trimTrailingSlash(
    requiredEnv('AGENTCARD_PUBLIC_URL', process.env.AGENTCARD_PUBLIC_URL)
  );
  const token = signConnectToken(userId);
  return `${publicUrl}/api/agentcard/connect?user=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
}
