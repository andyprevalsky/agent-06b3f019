/**
 * Mobbin design references for code agents, so the agent displays they build
 * (`rose display`) can follow real app and website UI patterns.
 *
 *   backend env MOBBIN_MCP_TOKEN
 *     set ──► withAgentTools
 *     │        ├─ ~/.rose/mcp.json  mobbin: http https://api.mobbin.com/mcp,
 *     │        │    Authorization "Bearer ${MOBBIN_MCP_TOKEN}"   (placeholder; the
 *     │        │    file never holds the secret, Claude Code expands it from env)
 *     │        └─ session env MOBBIN_MCP_TOKEN ──► ws-server ──► Claude Code (--mcp-config)
 *     │                                                     └──► Codex (-c mcp_servers.mobbin.*)
 *     unset ─► no mobbin entry, no env, one warning; the session starts normally.
 *
 * Mobbin serves Streamable HTTP and authorizes with an OAuth bearer token
 * (https://docs.mobbin.com/mcp/introduction). A sandbox cannot run its browser
 * sign-in, so the backend supplies the token. The token belongs to one Mobbin
 * account, so the ws-servers expose only the catalog search tools; the
 * account's collections, saves and comments stay out of reach of every user's
 * code agent.
 */
import { createLogger } from '../logger';

const log = createLogger('AgentToolsMobbin');

export const MOBBIN_MCP_SERVER_NAME = 'mobbin';
export const MOBBIN_MCP_URL = 'https://api.mobbin.com/mcp';
export const MOBBIN_MCP_TOKEN_ENV = 'MOBBIN_MCP_TOKEN';

export interface MobbinMcpServerConfig {
  type: 'http';
  url: string;
  headers: { Authorization: string };
}

let warnedMissing = false;

/** The configured bearer token, or null (warns once per process). */
export function mobbinMcpToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env[MOBBIN_MCP_TOKEN_ENV]?.trim();
  if (token) return token;
  if (!warnedMissing) {
    warnedMissing = true;
    log.warn(`${MOBBIN_MCP_TOKEN_ENV} is not set; code agents start without the Mobbin MCP server`);
  }
  return null;
}

/** Claude Code `--mcp-config` entry; the header is an env placeholder, not the token. */
export function mobbinMcpServerConfig(): MobbinMcpServerConfig {
  return {
    type: 'http',
    url: MOBBIN_MCP_URL,
    headers: { Authorization: `Bearer \${${MOBBIN_MCP_TOKEN_ENV}}` },
  };
}
