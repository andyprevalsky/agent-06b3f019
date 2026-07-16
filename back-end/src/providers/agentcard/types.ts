/**
 * Shared AgentCard domain types (lowest layer — no intra-domain imports).
 */

/** OAuth token bundle for a user. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
  scope?: string;
}

/** PKCE verifier/challenge pair. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A tool as advertised by the AgentCard MCP server (forwarded verbatim). */
export interface AgentCardTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** JSON-safe token bundle persisted in `Integration.config` (no `undefined` values). */
export type StoredTokenConfig = Record<string, string | number>;
