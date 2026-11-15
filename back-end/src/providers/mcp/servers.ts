/**
 * User-connected remote MCP servers (Streamable HTTP). One Integration row per
 * (user, server URL): name 'mcp', type TOOL_SETUP.
 *
 *   connect(url, headers?) ──probe──► 200: CONNECTED, tools cached
 *                            │       401, no headers: OAuth begin → EXPIRED (needs_auth)
 *                            │                        + authorize_url for the browser
 *                            │       401 with headers: refused (wrong key)
 *                            └─────► other failure: refused with the server's reason
 *   completeOAuth(state, code) ──► tokens ──probe──► CONNECTED
 *   agents: list connected servers + tools; call(tool, args) proxies through
 *     the backend, so headers and OAuth tokens never enter a sandbox. Access
 *     tokens refresh under a row lock (refresh tokens rotate).
 *
 * Secrets (headers, OAuth grant) live in one encrypted envelope in config;
 * config also holds the cached tool list and the pending OAuth `state`.
 * Everything is per user and per row: no fan-in across users (10k agents read
 * one indexed row set per user).
 *
 * Team sharing (docs/plans/completed/share-mcp-servers.md): agents also list and
 * call servers a teammate currently shares (`resolveTeamDataAccess`, revalidated
 * on every list and call). The call runs with the OWNER's headers / OAuth token
 * server-side; the teammate never receives them.
 */
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma, runTransactionWithRetry } from '../database';
import { createLogger } from '../logger';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/secrets';
import {
  beginMcpOAuth,
  completeMcpOAuth,
  mcpGrantNeedsRefresh,
  refreshMcpOAuth,
  type McpOAuthGrant,
} from './oauth';
import { mcpNetwork, McpUrlError } from './publicFetch';
import { resolveTeamDataAccess } from '../teamAccess';
import { McpProbeUnauthorized, openMcpSession, type McpTool } from './session';

const log = createLogger('McpServers');
const MAX_SERVERS = 50;
const CALL_TIMEOUT_MS = 5 * 60_000;

export class McpServerError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Auth = 'none' | 'headers' | 'oauth';
interface Secret {
  headers?: Record<string, string>;
  oauth?: McpOAuthGrant;
}
interface McpConfig {
  kind: 'mcp-server-v1';
  name: string;
  /** The user typed the name; otherwise it follows the server's own serverInfo name. */
  named?: boolean;
  slug: string;
  url: string;
  auth: Auth;
  tools: McpTool[];
  secret?: string;
  oauth_state?: string;
}
type Row = {
  id: string;
  status: string;
  config: Prisma.JsonValue;
  failureReason: string | null;
};

function mcpConfig(raw: Prisma.JsonValue): McpConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.kind !== 'mcp-server-v1' || typeof raw.url !== 'string') return null;
  return raw as unknown as McpConfig;
}
function secretOf(config: McpConfig): Secret {
  if (!config.secret) return {};
  const plain = decryptProjectSecret(config.secret);
  return plain ? (JSON.parse(plain) as Secret) : {};
}
function sealed(secret: Secret): string | undefined {
  return secret.headers || secret.oauth ? encryptProjectSecret(JSON.stringify(secret)) : undefined;
}
function requestHeaders(secret: Secret): Record<string, string> {
  return {
    ...(secret.headers ?? {}),
    ...(secret.oauth?.accessToken ? { Authorization: `Bearer ${secret.oauth.accessToken}` } : {}),
  };
}

/** Agent-facing tool name: `<server slug>__<tool>`, at most 64 characters. */
export function mcpAgentToolName(slug: string, tool: string): string {
  const name = `${slug}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (name.length <= 64) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

export function mcpView(row: Row) {
  const config = mcpConfig(row.config);
  if (config === null) throw new McpServerError(404, 'MCP server not found');
  return {
    id: row.id,
    name: config.name,
    url: config.url,
    auth: config.auth,
    status:
      row.status === 'CONNECTED'
        ? ('connected' as const)
        : row.status === 'EXPIRED'
          ? ('needs_auth' as const)
          : ('failed' as const),
    tools: config.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    error: row.failureReason,
  };
}

async function rows(userId: string) {
  const found = await prisma.integration.findMany({
    where: { userId, name: 'mcp', type: 'TOOL_SETUP' },
    orderBy: { createdAt: 'asc' },
    take: MAX_SERVERS,
  });
  return found.filter((row) => mcpConfig(row.config) !== null);
}

export async function listMcpServers(userId: string) {
  return { servers: (await rows(userId)).map(mcpView) };
}

async function owned(userId: string, id: string) {
  const row = await prisma.integration.findFirst({
    where: { id, userId, name: 'mcp', type: 'TOOL_SETUP' },
  });
  const config = row === null ? null : mcpConfig(row.config);
  if (row === null || config === null) throw new McpServerError(404, 'MCP server not found');
  return { row, config };
}

function slugFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'mcp';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

export interface ConnectInput {
  url: string;
  name?: string;
  headers?: Record<string, string>;
  redirectUri: string;
}

/**
 * New URL: create (upsert keeps a concurrent create idempotent). Existing row:
 * update only that row while `guard` still holds, so a stale sign-in or probe
 * never recreates a server the user removed or overwrites a newer state.
 */
async function save(
  userId: string,
  url: string,
  data: { status: 'CONNECTED' | 'EXPIRED' | 'SYNC_FAILED'; config: McpConfig; failure?: string },
  existing?: { id: string; guard?: Prisma.IntegrationWhereInput }
) {
  const fields = {
    status: data.status,
    isActive: data.status === 'CONNECTED',
    config: data.config as unknown as Prisma.InputJsonValue,
    failureReason: data.failure ?? null,
    ...(data.status === 'CONNECTED' ? { lastSuccessfulSyncAt: new Date() } : {}),
  };
  let row;
  if (existing) {
    const updated = await prisma.integration.updateMany({
      where: { id: existing.id, userId, name: 'mcp', ...existing.guard },
      data: fields,
    });
    if (updated.count === 0)
      throw new McpServerError(409, 'This MCP server was removed or changed. Connect it again.');
    row = await prisma.integration.findUniqueOrThrow({ where: { id: existing.id } });
  } else {
    row = await prisma.integration.upsert({
      where: { userId_name_accountId: { userId, name: 'mcp', accountId: url } },
      create: { userId, name: 'mcp', type: 'TOOL_SETUP', accountId: url, ...fields },
      update: fields,
    });
  }
  log.info(`[McpServers] saved ${data.status}`, { userId, integrationId: row.id, url });
  return row;
}

/** Probe, then store as connected, pending sign-in, or (reconnects only) failed. */
export async function connectMcpServer(userId: string, input: ConnectInput) {
  let url: string;
  try {
    url = mcpNetwork.checkUrl(input.url).toString();
  } catch (error) {
    throw new McpServerError(400, reason(error));
  }
  const existing = await rows(userId);
  const current = existing.find((row) => mcpConfig(row.config)!.url === url);
  if (!current && existing.length >= MAX_SERVERS)
    throw new McpServerError(409, `You can connect up to ${MAX_SERVERS} MCP servers`);
  const previous = current ? mcpConfig(current.config)! : null;
  const secret: Secret = input.headers
    ? { headers: input.headers }
    : previous
      ? secretOf(previous)
      : {};
  const taken = new Set(
    existing.filter((row) => row !== current).map((row) => mcpConfig(row.config)!.slug)
  );
  const base = (name: string, auth: Auth, tools: McpTool[]): McpConfig => ({
    kind: 'mcp-server-v1',
    name: input.name?.trim() || (previous?.named ? previous.name : name),
    named: Boolean(input.name?.trim()) || previous?.named === true,
    slug: previous?.slug ?? slugFor(input.name?.trim() || name, taken),
    url,
    auth,
    tools,
  });
  const fallbackName = new URL(url).hostname.replace(/^(www|mcp|api)\./, '').split('.')[0];
  try {
    const probe = await openMcpSession(url, requestHeaders(secret), async (session) => ({
      tools: await session.listTools(),
      name: session.serverName(),
    }));
    const auth: Auth = secret.oauth ? 'oauth' : secret.headers ? 'headers' : 'none';
    const config = {
      ...base(probe.name || fallbackName, auth, probe.tools),
      secret: sealed(secret),
    };
    const target = current ? { id: current.id } : undefined;
    return { server: mcpView(await save(userId, url, { status: 'CONNECTED', config }, target)) };
  } catch (error) {
    if (error instanceof McpProbeUnauthorized && !input.headers) {
      let begun;
      try {
        begun = await beginMcpOAuth(
          url,
          error.resourceMetadataUrl,
          input.redirectUri,
          secret.oauth
        );
      } catch (oauthError) {
        throw new McpServerError(
          422,
          `This server needs sign-in, but its OAuth setup failed: ${reason(oauthError)}. If it uses an API key, add it as a header.`
        );
      }
      const config: McpConfig = {
        ...base(previous?.name ?? fallbackName, 'oauth', previous?.tools ?? []),
        secret: sealed({ oauth: begun.grant }),
        oauth_state: begun.grant.state,
      };
      const row = await save(
        userId,
        url,
        { status: 'EXPIRED', config },
        current ? { id: current.id } : undefined
      );
      return { server: mcpView(row), authorize_url: begun.authorizeUrl };
    }
    const message =
      error instanceof McpProbeUnauthorized
        ? 'The server rejected these credentials. Check the header name and value.'
        : `Could not connect: ${reason(error)}`;
    log.warn('[McpServers] connect failed', { userId, url, error: reason(error) });
    if (previous && current) {
      const config = { ...previous, secret: sealed(secret) };
      await save(
        userId,
        url,
        { status: 'SYNC_FAILED', config, failure: message },
        { id: current.id }
      );
    }
    throw new McpServerError(error instanceof McpUrlError ? 400 : 422, message);
  }
}

export async function completeMcpServerOAuth(userId: string, state: string, code: string) {
  const row = await prisma.integration.findFirst({
    where: {
      userId,
      name: 'mcp',
      type: 'TOOL_SETUP',
      config: { path: ['oauth_state'], equals: state },
    },
  });
  const config = row === null ? null : mcpConfig(row.config);
  if (row === null || config === null)
    throw new McpServerError(400, 'This sign-in link expired. Connect the MCP server again.');
  const grant = secretOf(config).oauth;
  if (!grant || grant.state !== state)
    throw new McpServerError(400, 'This sign-in link expired. Connect the MCP server again.');
  let signedIn: McpOAuthGrant;
  try {
    signedIn = await completeMcpOAuth(grant, code);
  } catch (error) {
    throw new McpServerError(502, `Sign-in failed: ${reason(error)}`);
  }
  const secret: Secret = { oauth: signedIn };
  // Only the row still waiting on this exact sign-in may be updated.
  const pending = { id: row.id, guard: { config: { path: ['oauth_state'], equals: state } } };
  try {
    const probe = await openMcpSession(config.url, requestHeaders(secret), async (session) => ({
      tools: await session.listTools(),
      name: session.serverName(),
    }));
    const next: McpConfig = {
      ...config,
      name: config.named || !probe.name ? config.name : probe.name,
      auth: 'oauth',
      tools: probe.tools,
      secret: sealed(secret),
    };
    delete next.oauth_state;
    return {
      server: mcpView(
        await save(userId, config.url, { status: 'CONNECTED', config: next }, pending)
      ),
    };
  } catch (error) {
    // The row was removed or re-signed meanwhile: report that, never relabel it.
    if (error instanceof McpServerError) throw error;
    const failure = `Signed in, but listing tools failed: ${reason(error)}`;
    const next: McpConfig = { ...config, secret: sealed(secret) };
    delete next.oauth_state;
    await save(userId, config.url, { status: 'SYNC_FAILED', config: next, failure }, pending);
    throw new McpServerError(502, failure);
  }
}

export async function reconnectMcpServer(userId: string, id: string, redirectUri: string) {
  const { config } = await owned(userId, id);
  return connectMcpServer(userId, { url: config.url, redirectUri });
}

export async function deleteMcpServer(userId: string, id: string): Promise<void> {
  await owned(userId, id);
  await prisma.integration.delete({ where: { id } });
  log.info('[McpServers] deleted', { userId, integrationId: id });
}

export interface McpShare {
  team_id: string;
  team_name: string;
  owner_user_id: string;
  owner_name: string | null;
}

/** Live 'mcp' grants a teammate holds, one per shared integration (lowest team id wins). */
async function mcpGrants(userId: string, integrationId?: string) {
  const byIntegration = new Map<string, McpShare>();
  const grants = (await resolveTeamDataAccess(userId)).sort((a, b) =>
    a.teamId.localeCompare(b.teamId)
  );
  for (const grant of grants) {
    if (grant.provider !== 'mcp' || grant.ownerUserId === userId) continue;
    if (integrationId !== undefined && grant.integrationId !== integrationId) continue;
    if (byIntegration.has(grant.integrationId)) continue;
    byIntegration.set(grant.integrationId, {
      team_id: grant.teamId,
      team_name: grant.teamName,
      owner_user_id: grant.ownerUserId,
      owner_name: grant.ownerName,
    });
  }
  return byIntegration;
}

/** Shared servers' rows, still owned by the granting teammate (one indexed read). */
async function sharedRows(grants: Map<string, McpShare>) {
  if (grants.size === 0) return [];
  const found = await prisma.integration.findMany({
    where: { id: { in: [...grants.keys()] }, name: 'mcp', type: 'TOOL_SETUP' },
    // Stable order keeps each shared server's de-collided slug (and tool names) fixed.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return found.filter(
    (row) => mcpConfig(row.config) !== null && grants.get(row.id)?.owner_user_id === row.userId
  );
}

/** Connected servers (own, then teammate-shared) with full tool schemas, for agent sessions. */
export async function listAgentMcpServers(userId: string) {
  const own = (await rows(userId)).filter((row) => row.status === 'CONNECTED');
  const grants = await mcpGrants(userId);
  const shared = (await sharedRows(grants)).filter((row) => row.status === 'CONNECTED');
  // Shared slugs never collide with the reader's own (or another share's) tool names.
  const taken = new Set(own.map((row) => mcpConfig(row.config)!.slug));
  const view = (row: (typeof own)[number], share: McpShare | null) => {
    const config = mcpConfig(row.config)!;
    const slug = share === null ? config.slug : slugFor(config.slug, taken);
    if (share !== null) taken.add(slug);
    // Normalization can collide (search.docs vs search_docs): suffix later ones.
    const used = new Set<string>();
    return {
      id: row.id,
      name: config.name,
      ...(share === null ? {} : { shared: share }),
      tools: config.tools.map((tool) => {
        let agentName = mcpAgentToolName(slug, tool.name);
        for (let n = 2; used.has(agentName); n += 1)
          agentName = mcpAgentToolName(slug, `${tool.name}_${n}`);
        used.add(agentName);
        return { ...tool, agent_name: agentName };
      }),
    };
  };
  return {
    servers: [
      ...own.map((row) => view(row, null)),
      ...shared.map((row) => view(row, grants.get(row.id)!)),
    ],
  };
}

/** The server `userId` may call: their own, else one a teammate currently shares. */
async function usable(userId: string, id: string) {
  const own = await prisma.integration.findFirst({
    where: { id, userId, name: 'mcp', type: 'TOOL_SETUP' },
  });
  const ownConfig = own === null ? null : mcpConfig(own.config);
  if (own !== null && ownConfig !== null) return { row: own, config: ownConfig, share: null };
  const grants = await mcpGrants(userId, id);
  const [row] = await sharedRows(grants);
  if (row === undefined) throw new McpServerError(404, 'MCP server not found');
  return { row, config: mcpConfig(row.config)!, share: grants.get(row.id)! };
}

/** Current auth headers; refreshes an OAuth access token under the row lock. */
type AuthResult =
  { kind: 'headers'; headers: Record<string, string> } | { kind: 'expired'; name: string };

async function authHeaders(
  id: string,
  force: boolean,
  shared: boolean
): Promise<Record<string, string>> {
  const result: AuthResult = await runTransactionWithRetry(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Integration" WHERE id = ${id} FOR UPDATE`;
      const row = await tx.integration.findUniqueOrThrow({ where: { id } });
      const config = mcpConfig(row.config)!;
      const secret = secretOf(config);
      if (!secret.oauth || !(force || mcpGrantNeedsRefresh(secret.oauth)))
        return { kind: 'headers', headers: requestHeaders(secret) };
      let oauth: McpOAuthGrant;
      try {
        oauth = await refreshMcpOAuth(secret.oauth);
      } catch (error) {
        log.warn('[McpServers] token refresh failed', { integrationId: id, error: reason(error) });
        // Still under the row lock, so a concurrent successful refresh cannot be overwritten.
        await tx.integration.update({
          where: { id },
          data: { status: 'EXPIRED', failureReason: 'Sign in again to keep using this server.' },
        });
        return { kind: 'expired', name: config.name };
      }
      const next = { ...config, secret: sealed({ ...secret, oauth }) };
      await tx.integration.update({
        where: { id },
        data: { config: next as unknown as Prisma.InputJsonValue },
      });
      return { kind: 'headers', headers: requestHeaders({ ...secret, oauth }) };
    },
    { timeout: 45_000, maxWait: 15_000 }
  );
  if (result.kind === 'headers') return result.headers;
  // Thrown after commit, so the EXPIRED status survives the refusal.
  throw new McpServerError(
    401,
    shared
      ? `${result.name} needs its owner to sign in again in Integrations`
      : `${result.name} needs you to sign in again in Integrations`
  );
}

export async function callMcpTool(
  userId: string,
  id: string,
  tool: string,
  args: Record<string, unknown>
) {
  const { row, config, share } = await usable(userId, id);
  if (row.status !== 'CONNECTED')
    throw new McpServerError(
      409,
      share === null
        ? `${config.name} is not connected. Reconnect it in Integrations.`
        : `${config.name} is not connected. Ask its owner to reconnect it in Integrations.`
    );
  const ownerUserId = row.userId;
  const started = Date.now();
  const run = (headers: Record<string, string>) =>
    openMcpSession(config.url, headers, (session) => session.callTool(tool, args, CALL_TIMEOUT_MS));
  let result;
  try {
    result = await run(await authHeaders(id, false, share !== null));
  } catch (error) {
    if (!(error instanceof McpProbeUnauthorized) || config.auth !== 'oauth') {
      log.warn('[McpServers] tool call failed', {
        userId,
        ownerUserId,
        integrationId: id,
        tool,
        error: reason(error),
      });
      if (error instanceof McpServerError) throw error;
      throw new McpServerError(502, `${config.name} ${tool} failed: ${reason(error)}`);
    }
    result = await run(await authHeaders(id, true, share !== null));
  }
  await prisma.integration.updateMany({ where: { id }, data: { lastUsedAt: new Date() } });
  log.info('[McpServers] tool call', {
    userId,
    ownerUserId,
    ...(share === null ? {} : { teamId: share.team_id }),
    integrationId: id,
    tool,
    args: JSON.stringify(args).slice(0, 200),
    isError: result.isError,
    ms: Date.now() - started,
  });
  return result;
}
