/**
 * Bearer tokens that let ONE code-agent sandbox call the Rose agent tools
 * (`rose` CLI / `rose mcp` → /api/agent-tools/:agentId/...) for ONE agent.
 *
 *   rtt.<base64url(JSON {sub, agt, prv, tsk, scope, iat, exp})>.<base64url(HMAC-SHA256)>
 *
 * `sub` is the agent owner's user id, `agt` the agent whose trajectory the
 * session belongs to (the agent that spawned the code agent), `prv` the code
 * provider (claude | codex) used to label the requesting agent, `tsk` the code
 * session's task id (the chip's `task_id`, so its messages group under it). The HMAC key is
 * AGENT_TOOLS_TOKEN_SECRET, else a labelled derivation of USER_UI_TOKEN_SECRET /
 * SUPABASE_JWT_SECRET distinct from the rose-ui publish key, so neither token
 * can be replayed as the other (or as a session JWT).
 *
 * Lifetime: code agents have no runtime limit (plan row C11) and paused
 * sessions resume later, so the token lives 30 days; it never widens past its
 * one agent.
 */
import crypto from 'crypto';

export const AGENT_TOOLS_TOKEN_SCOPE = 'agent-tools';
export const AGENT_TOOLS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PREFIX = 'rtt.';

export type AgentToolsProvider = 'claude' | 'codex';

interface AgentToolsTokenClaims {
  sub: string;
  agt: string;
  prv?: AgentToolsProvider;
  tsk?: string;
  scope: string;
  iat: number;
  exp: number;
}

function tokenSecret(): Buffer {
  const explicit = process.env.AGENT_TOOLS_TOKEN_SECRET?.trim();
  if (explicit) return Buffer.from(explicit, 'utf8');
  const base = process.env.USER_UI_TOKEN_SECRET?.trim() || process.env.SUPABASE_JWT_SECRET?.trim();
  if (!base) {
    throw new Error(
      'AGENT_TOOLS_TOKEN_SECRET, USER_UI_TOKEN_SECRET or SUPABASE_JWT_SECRET must be set'
    );
  }
  return crypto.createHmac('sha256', base).update('rose-agent-tools-token-v1').digest();
}

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(`${TOKEN_PREFIX}${payload}`)
    .digest('base64url');
}

export function isAgentToolsToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

/** Mint a token. `scope`/`ttlSeconds`/`nowSeconds` exist for rejection-path tests. */
export function mintAgentToolsToken(
  userId: string,
  agentId: string,
  options: {
    provider?: AgentToolsProvider;
    taskId?: string;
    scope?: string;
    ttlSeconds?: number;
    nowSeconds?: number;
  } = {}
): { token: string; expiresAt: string } {
  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (options.ttlSeconds ?? AGENT_TOOLS_TOKEN_TTL_SECONDS);
  const claims: AgentToolsTokenClaims = {
    sub: userId,
    agt: agentId,
    ...(options.provider ? { prv: options.provider } : {}),
    ...(options.taskId ? { tsk: options.taskId } : {}),
    scope: options.scope ?? AGENT_TOOLS_TOKEN_SCOPE,
    iat,
    exp,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    token: `${TOKEN_PREFIX}${payload}.${sign(payload)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export type AgentToolsTokenCheck =
  | {
      ok: true;
      userId: string;
      agentId: string;
      provider: AgentToolsProvider | null;
      taskId: string | null;
    }
  | { ok: false; reason: 'malformed' | 'signature' | 'scope' | 'expired' };

export function verifyAgentToolsToken(token: string): AgentToolsTokenCheck {
  if (!isAgentToolsToken(token)) return { ok: false, reason: 'malformed' };
  const [payload, signature, ...rest] = token.slice(TOKEN_PREFIX.length).split('.');
  if (!payload || !signature || rest.length > 0) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'signature' };
  }
  let claims: Partial<AgentToolsTokenClaims>;
  try {
    claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as Partial<AgentToolsTokenClaims>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    typeof claims.agt !== 'string' ||
    claims.agt.length === 0 ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.scope !== AGENT_TOOLS_TOKEN_SCOPE) return { ok: false, reason: 'scope' };
  if (claims.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  const provider = claims.prv === 'claude' || claims.prv === 'codex' ? claims.prv : null;
  const taskId = typeof claims.tsk === 'string' && claims.tsk.length > 0 ? claims.tsk : null;
  return { ok: true, userId: claims.sub, agentId: claims.agt, provider, taskId };
}
