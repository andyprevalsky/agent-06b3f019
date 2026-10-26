/**
 * Per-user AgentCard MCP runtime.
 *
 * Builds an MCP client using the END USER's bearer token and forwards the FULL
 * live toolset. tools/list is called at RUNTIME and EVERY advertised tool is
 * returned dynamically (name + description + inputSchema); nothing is hardcoded
 * or curated, so tools AgentCard adds later work with zero code change.
 *
 * Access tokens are refreshed proactively on near-expiry and reactively on 401.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger } from '../logger';
import { AGENTCARD_MCP_RESOURCE, AgentCardOAuthError, loadOAuthConfig } from './config';
import { isExpired, refreshAccessToken } from './oauth';
import { getUserToken, saveUserToken } from './store';
import { withSerializedLock } from '../sharedState';
import type { AgentCardTool } from './types';

export type { AgentCardTool } from './types';

const log = createLogger('AgentCardMCP');

/** Per-tool MCP call ceiling. Unbounded client.callTool has hung mint for 15+ minutes. */
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30_000;

/** Node setTimeout coerces delays above this to 1ms — reject them. */
const MAX_MCP_TOOL_TIMEOUT_MS = 2_147_483_647;

export function mcpToolTimeoutMs(): number {
  const raw = process.env.AGENTCARD_MCP_TOOL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= MAX_MCP_TOOL_TIMEOUT_MS
    ? value
    : DEFAULT_MCP_TOOL_TIMEOUT_MS;
}

export class AgentCardNotConnectedError extends Error {
  constructor(readonly userId: string) {
    super('User has not connected AgentCard');
    this.name = 'AgentCardNotConnectedError';
  }
}

export class AgentCardMcpTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number
  ) {
    super(`AgentCard MCP tool ${toolName} timed out after ${timeoutMs}ms`);
    this.name = 'AgentCardMcpTimeoutError';
  }
}

/**
 * Coalesces concurrent refreshes for the same user into a single in-flight promise. AgentCard
 * ROTATES the refresh token on every use, so two parallel refreshes of the same bundle would race:
 * one wins and the other fails with `invalid_grant` (or overwrites the freshly-stored token).
 * The map only coalesces callers inside this process; a per-user Postgres advisory lock
 * serializes refreshes across backend instances.
 */
const inFlightRefreshes = new Map<string, Promise<string>>();

/**
 * Returns a currently-valid access token for the user, refreshing (and persisting
 * the rotated refresh token) when the current one is expired/near-expiry or when
 * `forceRefresh` is set (used after a 401). Refreshes are single-flighted per user.
 */
export async function getValidAccessToken(userId: string, forceRefresh = false): Promise<string> {
  const token = await getUserToken(userId);
  if (token === undefined) throw new AgentCardNotConnectedError(userId);

  if (!forceRefresh && !isExpired(token)) return token.accessToken;

  const existing = inFlightRefreshes.get(userId);
  if (existing !== undefined) return existing;

  const refreshPromise = withSerializedLock(`agentcard-refresh:${userId}`, () =>
    refreshUserToken(userId, forceRefresh, token.accessToken)
  ).finally(() => {
    inFlightRefreshes.delete(userId);
  });
  inFlightRefreshes.set(userId, refreshPromise);
  return refreshPromise;
}

async function refreshUserToken(
  userId: string,
  forceRefresh: boolean,
  staleAccessToken: string
): Promise<string> {
  // Re-read under the cross-instance lock: a concurrent refresh (here or on another instance) may
  // already have rotated and persisted a fresh bundle, which we must reuse rather than burn the
  // refresh token. A forced refresh (after a 401) also reuses a token that replaced the stale one.
  const token = await getUserToken(userId);
  if (token === undefined) throw new AgentCardNotConnectedError(userId);
  const rotatedMeanwhile = token.accessToken !== staleAccessToken;
  if ((!forceRefresh || rotatedMeanwhile) && !isExpired(token)) return token.accessToken;

  if (token.refreshToken === undefined) {
    // Expired and nothing to refresh with — force a reconnect.
    throw new AgentCardNotConnectedError(userId);
  }

  const { clientId, clientSecret } = loadOAuthConfig();
  const refreshed = await refreshAccessToken({
    refreshToken: token.refreshToken,
    clientId,
    clientSecret,
  });
  // Refresh rotates the refresh token — persist the new bundle immediately.
  await saveUserToken(userId, refreshed);
  log.info('Refreshed AgentCard access token', { user_id: maskId(userId) });
  return refreshed.accessToken;
}

function maskId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function looksLikeAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized|invalid_token|invalid_grant|forbidden|\b403\b/i.test(message);
}

/** Runs `op` with a freshly-connected per-user MCP client, then closes it. */
async function withClient<T>(
  accessToken: string,
  op: (client: Client) => Promise<T>,
  fetchImpl?: FetchLike
): Promise<T> {
  const client = new Client({ name: 'rose-labs-agentcard', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(AGENTCARD_MCP_RESOURCE), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json, text/event-stream',
      },
    },
    fetch: fetchImpl,
  });
  try {
    await client.connect(transport);
    return await op(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Token-injected MCP core (exported for tests; used by the per-user wrappers).
// These forward the FULL live toolset — no hardcoded allowlist, no curation.
// ---------------------------------------------------------------------------

/** tools/list -> EVERY advertised tool, mapped verbatim (name/description/inputSchema). */
export async function mcpListTools(
  accessToken: string,
  fetchImpl?: FetchLike
): Promise<AgentCardTool[]> {
  return withClient(
    accessToken,
    async (client) => {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    fetchImpl
  );
}

/** tools/call for a single tool; result returned verbatim (may carry PAN/CVV — never logged). */
export async function mcpCallTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  fetchImpl?: FetchLike
): Promise<unknown> {
  const timeoutMs = mcpToolTimeoutMs();
  return withClient(
    accessToken,
    async (client) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          client.callTool({ name, arguments: args }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new AgentCardMcpTimeoutError(name, timeoutMs)),
              timeoutMs
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    fetchImpl
  );
}

/**
 * Runs an MCP op for a user, transparently refreshing the token and retrying once
 * if the first attempt fails with an auth error.
 */
async function runForUser<T>(userId: string, op: (client: Client) => Promise<T>): Promise<T> {
  const accessToken = await getValidAccessToken(userId);
  try {
    return await withClient(accessToken, op);
  } catch (error) {
    if (!looksLikeAuthError(error)) throw error;
    log.warn('AgentCard MCP auth error, refreshing token and retrying', {
      user_id: maskId(userId),
    });
    const refreshed = await getValidAccessToken(userId, true);
    return withClient(refreshed, op);
  }
}

/** List EVERY tool the AgentCard MCP server advertises for this user (dynamic). */
export async function listUserTools(userId: string): Promise<AgentCardTool[]> {
  return runForUser(userId, (client) =>
    client.listTools().then((result) =>
      result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
    )
  );
}

/** Call any advertised tool by name with arbitrary arguments. Result is returned verbatim. */
export async function callUserTool(
  userId: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AgentCardOAuthError('tool name is required');
  }
  return runForUser(userId, (client) => {
    // Never log `args`/results here: tool results can carry PAN/CVV.
    log.info('Calling AgentCard MCP tool', { user_id: maskId(userId), tool: name });
    return client.callTool({ name, arguments: args });
  });
}
