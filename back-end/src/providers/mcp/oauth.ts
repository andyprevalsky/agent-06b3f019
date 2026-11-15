/**
 * OAuth for remote MCP servers (MCP authorization spec: RFC 9728 resource
 * metadata → RFC 8414 server metadata → RFC 7591 dynamic registration →
 * authorization code + PKCE S256, `resource` audience-bound).
 *
 *   begin(server URL, WWW-Authenticate metadata URL, redirect)
 *     ──► { grant (client + metadata + verifier + state), authorizeUrl }
 *   complete(grant, code) ──► tokens (access, rotating refresh, expires_at)
 *   refresh(grant) ──► new tokens (old refresh token kept if none returned)
 *
 * Every request goes through `mcpNetwork.fetch` (public hosts only).
 */
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomBytes } from 'node:crypto';
import { mcpNetwork } from './publicFetch';

export interface McpOAuthGrant {
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  client: OAuthClientInformationMixed;
  redirectUri: string;
  resource?: string;
  state?: string;
  codeVerifier?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server did not say. */
  expiresAt?: number;
}

const fetchFn = (url: string | URL, init?: RequestInit) => mcpNetwork.fetch(url, init);

function withTokens(grant: McpOAuthGrant, tokens: OAuthTokens, now: number): McpOAuthGrant {
  return {
    ...grant,
    state: undefined,
    codeVerifier: undefined,
    accessToken: tokens.access_token,
    // Refresh tokens rotate; keep the previous one only when none is returned.
    refreshToken: tokens.refresh_token ?? grant.refreshToken,
    expiresAt: tokens.expires_in === undefined ? undefined : now + tokens.expires_in * 1000,
  };
}

/**
 * RFC 9728 §3.3: the advertised resource must identify this server (same origin,
 * path a prefix of the server's), or a server could obtain another server's token.
 */
export function assertResourceCoversServer(resource: string | undefined, serverUrl: string): void {
  if (resource === undefined) return;
  let advertised: URL;
  try {
    advertised = new URL(resource);
  } catch {
    throw new Error('The server advertised an invalid OAuth resource');
  }
  const server = new URL(serverUrl);
  const prefix = advertised.pathname.endsWith('/')
    ? advertised.pathname
    : `${advertised.pathname}/`;
  if (
    advertised.origin !== server.origin ||
    !(server.pathname === advertised.pathname || server.pathname.startsWith(prefix))
  )
    throw new Error(`The server's OAuth resource ${resource} does not match ${serverUrl}`);
}

export async function beginMcpOAuth(
  serverUrl: string,
  resourceMetadataUrl: URL | undefined,
  redirectUri: string,
  previous?: McpOAuthGrant
): Promise<{ grant: McpOAuthGrant; authorizeUrl: string }> {
  const info = await discoverOAuthServerInfo(serverUrl, { resourceMetadataUrl, fetchFn });
  assertResourceCoversServer(info.resourceMetadata?.resource, serverUrl);
  const metadata = info.authorizationServerMetadata;
  const reuse =
    previous !== undefined &&
    previous.authorizationServerUrl === info.authorizationServerUrl &&
    previous.redirectUri === redirectUri;
  const scopes = info.resourceMetadata?.scopes_supported;
  const scope = scopes && scopes.length > 0 ? scopes.join(' ') : undefined;
  const client = reuse
    ? previous.client
    : await registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: 'Rose',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          // The SDK's inferred schema type lists these optional URIs as required keys.
          logo_uri: undefined,
          tos_uri: undefined,
          ...(scope ? { scope } : {}),
        },
        fetchFn,
      });
  const resource = info.resourceMetadata?.resource;
  const state = randomBytes(24).toString('base64url');
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: redirectUri,
    scope,
    state,
    resource: resource ? new URL(resource) : undefined,
  });
  return {
    grant: {
      authorizationServerUrl: info.authorizationServerUrl,
      metadata,
      client,
      redirectUri,
      resource,
      state,
      codeVerifier,
    },
    authorizeUrl: authorizationUrl.toString(),
  };
}

export async function completeMcpOAuth(
  grant: McpOAuthGrant,
  code: string,
  now = Date.now()
): Promise<McpOAuthGrant> {
  if (!grant.codeVerifier) throw new Error('No sign-in is pending for this MCP server');
  const tokens = await exchangeAuthorization(grant.authorizationServerUrl, {
    metadata: grant.metadata,
    clientInformation: grant.client,
    authorizationCode: code,
    codeVerifier: grant.codeVerifier,
    redirectUri: grant.redirectUri,
    resource: grant.resource ? new URL(grant.resource) : undefined,
    fetchFn,
  });
  return withTokens(grant, tokens, now);
}

export async function refreshMcpOAuth(
  grant: McpOAuthGrant,
  now = Date.now()
): Promise<McpOAuthGrant> {
  if (!grant.refreshToken) throw new Error('The MCP sign-in expired');
  const tokens = await refreshAuthorization(grant.authorizationServerUrl, {
    metadata: grant.metadata,
    clientInformation: grant.client,
    refreshToken: grant.refreshToken,
    resource: grant.resource ? new URL(grant.resource) : undefined,
    fetchFn,
  });
  return withTokens(grant, tokens, now);
}

/** Expired or about to expire within a minute. */
export function mcpGrantNeedsRefresh(grant: McpOAuthGrant, now = Date.now()): boolean {
  return grant.expiresAt !== undefined && grant.expiresAt - now < 60_000;
}
