/**
 * Short-lived bearer tokens that let ONE code-agent session act in its own
 * Rose agent tree (list agents, send messages, grep trajectories) without a
 * user session or the backend API key.
 *
 *   rag.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>
 *
 * Claims bind the user, the tree root, the owning Rose agent and the code
 * session, so every graph route derives its scope from the token alone. The
 * HMAC secret is AGENT_GRAPH_TOKEN_SECRET, else a labelled derivation of
 * SUPABASE_JWT_SECRET (never the raw secret, never BACKEND_API_KEY).
 */
import crypto from 'crypto';

export const AGENT_GRAPH_SCOPE = 'agent-graph';
export const AGENT_GRAPH_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const TOKEN_PREFIX = 'rag.';

export interface AgentGraphClaims {
  /** userId */
  sub: string;
  scope: string;
  rootAgentId: string;
  /** Rose agent that spawned the code session. */
  ownerAgentId: string;
  /** ClaudeCodeSession.id (the code agent's id in the graph). */
  sessionId: string;
  provider: 'claude' | 'codex';
  iat: number;
  exp: number;
}

export type AgentGraphTokenInput = Omit<AgentGraphClaims, 'scope' | 'iat' | 'exp'>;

function tokenSecret(): Buffer {
  const explicit = process.env.AGENT_GRAPH_TOKEN_SECRET?.trim();
  if (explicit) return Buffer.from(explicit, 'utf8');
  const base = process.env.SUPABASE_JWT_SECRET?.trim();
  if (!base) throw new Error('AGENT_GRAPH_TOKEN_SECRET or SUPABASE_JWT_SECRET must be configured');
  return crypto.createHmac('sha256', base).update('rose-agent-graph-token-v1').digest();
}

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(`${TOKEN_PREFIX}${payload}`)
    .digest('base64url');
}

export function isAgentGraphToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

/** `scope`/`ttlSeconds`/`nowSeconds` exist for tests of rejection paths. */
export function mintAgentGraphToken(
  input: AgentGraphTokenInput,
  options: { scope?: string; ttlSeconds?: number; nowSeconds?: number } = {}
): { token: string; expiresAt: string } {
  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (options.ttlSeconds ?? AGENT_GRAPH_TOKEN_TTL_SECONDS);
  const claims: AgentGraphClaims = {
    ...input,
    scope: options.scope ?? AGENT_GRAPH_SCOPE,
    iat,
    exp,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    token: `${TOKEN_PREFIX}${payload}.${sign(payload)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export type AgentGraphTokenCheck =
  | { ok: true; claims: AgentGraphClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'scope' | 'expired' };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function verifyAgentGraphToken(token: string): AgentGraphTokenCheck {
  if (!isAgentGraphToken(token)) return { ok: false, reason: 'malformed' };
  const [payload, signature, ...rest] = token.slice(TOKEN_PREFIX.length).split('.');
  if (!payload || !signature || rest.length > 0) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'signature' };
  }
  let claims: Partial<AgentGraphClaims>;
  try {
    claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as Partial<AgentGraphClaims>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    !nonEmpty(claims.sub) ||
    !nonEmpty(claims.rootAgentId) ||
    !nonEmpty(claims.ownerAgentId) ||
    !nonEmpty(claims.sessionId) ||
    (claims.provider !== 'claude' && claims.provider !== 'codex') ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.scope !== AGENT_GRAPH_SCOPE) return { ok: false, reason: 'scope' };
  if (claims.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, claims: claims as AgentGraphClaims };
}
