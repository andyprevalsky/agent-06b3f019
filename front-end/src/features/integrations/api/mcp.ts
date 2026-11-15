/**
 * MCP server integration API (back-end/src/domains/integrations/routes.mcp.ts).
 *
 *   GET    /api/integrations/mcp                 -> { servers: McpServer[] }
 *   POST   /api/integrations/mcp                 { url, name?, headers?, redirect_uri }
 *                                                 -> 201 { server, authorize_url? }
 *   POST   /api/integrations/mcp/oauth/complete  { code, state } -> { server }
 *   POST   /api/integrations/mcp/:id/reconnect   { redirect_uri } -> { server, authorize_url? }
 *   DELETE /api/integrations/mcp/:id             -> 204
 *
 * Errors come back as { error: string }.
 */

import { getAuthHeaders } from '../api';
import { API_BASE_WITH_PATH } from '../config';

export interface McpTool {
  name: string;
  description: string;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: 'none' | 'headers' | 'oauth';
  status: 'connected' | 'needs_auth' | 'failed';
  tools: McpTool[];
  error: string | null;
}

/** A connect or reconnect result; `authorize_url` means OAuth sign-in is still needed. */
export interface McpServerResult {
  server: McpServer;
  authorize_url?: string;
}

export interface McpConnectInput {
  url: string;
  name?: string;
  headers?: Record<string, string>;
}

const MCP_URL = `${API_BASE_WITH_PATH}/integrations/mcp`;

async function mcpResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error || fallback);
  if (payload === null) throw new Error('Unexpected MCP server response');
  return payload;
}

export async function fetchMcpServers(): Promise<McpServer[]> {
  const response = await fetch(MCP_URL, { headers: getAuthHeaders() });
  const { servers } = await mcpResponse<{ servers?: unknown }>(
    response,
    'Could not load MCP servers',
  );
  if (!Array.isArray(servers)) throw new Error('Unexpected MCP server response');
  return servers as McpServer[];
}

export async function connectMcpServer(
  input: McpConnectInput,
  redirectUri: string,
): Promise<McpServerResult> {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ ...input, redirect_uri: redirectUri }),
  });
  return mcpResponse<McpServerResult>(response, 'Could not connect MCP server');
}

export async function reconnectMcpServer(
  id: string,
  redirectUri: string,
): Promise<McpServerResult> {
  const response = await fetch(`${MCP_URL}/${encodeURIComponent(id)}/reconnect`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ redirect_uri: redirectUri }),
  });
  return mcpResponse<McpServerResult>(response, 'Could not reconnect MCP server');
}

/** Finish OAuth sign-in with the signed-in user's own session (callback page). */
export async function completeMcpServerOAuth(code: string, state: string): Promise<McpServer> {
  const response = await fetch(`${MCP_URL}/oauth/complete`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ code, state }),
  });
  return (await mcpResponse<{ server: McpServer }>(response, 'Could not finish MCP sign-in'))
    .server;
}

export async function deleteMcpServer(id: string): Promise<void> {
  const response = await fetch(`${MCP_URL}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error || 'Could not remove MCP server');
}
