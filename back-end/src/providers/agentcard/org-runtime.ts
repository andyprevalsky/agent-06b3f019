import { mcpCallTool } from './runtime';

const DEFAULT_ORG_TOKEN_ENDPOINT = 'https://api.agentcard.sh/api/v1/oauth/token';

type FetchLike = typeof fetch;
type TokenMcpToolCaller = (
  accessToken: string,
  toolName: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export type AgentCardOrgToolCaller = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export class AgentCardOrgRuntimeError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'agentcard_org_mcp_unavailable',
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AgentCardOrgRuntimeError';
  }
}

function requiredEnv(name: string, fallbackName?: string): string {
  const value = process.env[name]?.trim() || process.env[fallbackName ?? '']?.trim();
  if (!value) {
    throw new AgentCardOrgRuntimeError(
      `Missing ${name} environment variable for AgentCard Organization MCP`,
      409,
      'agentcard_org_mcp_unavailable',
      { missingEnv: name }
    );
  }
  return value;
}

function hasClientCredentials(): boolean {
  const clientId =
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim() ||
    process.env.AGENTCARD_OAUTH_CLIENT_ID?.trim();
  const clientSecret =
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET?.trim() ||
    process.env.AGENTCARD_OAUTH_CLIENT_SECRET?.trim();
  return Boolean(clientId && clientSecret);
}

function looksLikeAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]token|expired organization token/i.test(
    message
  );
}

function directAccessToken(): string | undefined {
  const token =
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN ??
    process.env.AGENTCARD_API_KEY ??
    process.env.AGENTCARD_ADMIN_MCP_ACCESS_TOKEN;
  return token?.trim() || undefined;
}

export class AgentCardOrgRuntime {
  private cachedToken?: { accessToken: string; expiresAtMs: number };

  constructor(
    private readonly toolCaller: TokenMcpToolCaller = mcpCallTool,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    try {
      return await this.toolCaller(accessToken, toolName, args);
    } catch (error) {
      if (!hasClientCredentials() || !looksLikeAuthError(error)) throw error;
      this.cachedToken = undefined;
      return this.toolCaller(await this.getAccessToken(true), toolName, args);
    }
  }

  private async getAccessToken(forceClientCredentials = false): Promise<string> {
    const direct = directAccessToken();
    if (!forceClientCredentials && !hasClientCredentials() && direct !== undefined) return direct;

    if (this.cachedToken !== undefined && this.cachedToken.expiresAtMs > Date.now() + 60_000) {
      return this.cachedToken.accessToken;
    }

    const response = await this.fetchImpl(
      process.env.AGENTCARD_ORG_TOKEN_ENDPOINT?.trim() || DEFAULT_ORG_TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: requiredEnv('AGENTCARD_ORG_OAUTH_CLIENT_ID', 'AGENTCARD_OAUTH_CLIENT_ID'),
          client_secret: requiredEnv(
            'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
            'AGENTCARD_OAUTH_CLIENT_SECRET'
          ),
        }),
      }
    );
    const bodyText = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = { message: bodyText };
    }
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new AgentCardOrgRuntimeError(
        'Could not obtain an AgentCard Organization MCP access token',
        response.status >= 400 && response.status < 500 ? response.status : 502,
        'agentcard_org_token_unavailable',
        {
          status: response.status,
          error: body.error,
          errorDescription: body.error_description,
          message: body.message,
        }
      );
    }
    const expiresInSeconds =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in
        : 3600;
    this.cachedToken = {
      accessToken: body.access_token,
      expiresAtMs: Date.now() + expiresInSeconds * 1000,
    };
    return this.cachedToken.accessToken;
  }
}

const runtime = new AgentCardOrgRuntime();

export const callOrgTool: AgentCardOrgToolCaller = (toolName, args) =>
  runtime.callTool(toolName, args);
