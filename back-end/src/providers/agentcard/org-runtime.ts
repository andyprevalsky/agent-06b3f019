import { AGENTCARD_MCP_RESOURCE } from './config';
import { mcpCallTool } from './runtime';

const DEFAULT_ORG_TOKEN_ENDPOINT = 'https://api.agentcard.sh/api/v1/oauth/token';
const DEFAULT_ORG_TOKEN_TIMEOUT_MS = 15_000;
const MIN_STALE_TOKEN_VALIDITY_MS = 5_000;
/**
 * AgentCard throttles the organization MCP per fixed window (observed: 120 requests/minute, shared
 * by EVERY org caller — card issuance, wallet reclaim polling, the minute cron reconciler and the
 * payment-lifecycle fan-out). A throttled window therefore drains and refills within seconds, so a
 * small bounded wait converts a hard failure into a successful call.
 *
 * Bounded by a TOTAL delay budget rather than a per-attempt delay: some callers (the wallet-funding
 * release observer) already poll this runtime up to 20 times, and a per-attempt bound would let the
 * nested waits multiply into a multi-minute request. The budget caps what one `callTool` can ever
 * add, so the outer poll loop's own timing stays the dominant term.
 */
const RATE_LIMIT_RETRY_ATTEMPTS = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_TOTAL_DELAY_BUDGET_MS = 10_000;

function orgTokenTimeoutMs(): number {
  const raw = process.env.AGENTCARD_ORG_TOKEN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ORG_TOKEN_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ORG_TOKEN_TIMEOUT_MS;
}

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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
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
  const clientId = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET?.trim();
  return Boolean(clientId && clientSecret);
}

function looksLikeAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]token|expired organization token/i.test(
    message
  );
}

function directAccessToken(): string | undefined {
  const token = process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN?.trim();
  return token && !token.startsWith('sk_') ? token : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The MCP transport surfaces an AgentCard throttle as an opaque transport error whose text embeds
 * the provider's JSON body, so match on the body's wording rather than a status field.
 */
function looksLikeRateLimitError(error: unknown): boolean {
  return /too many requests|rate.?limit|\b429\b/i.test(errorMessage(error));
}

/**
 * AgentCard reports `retryAfter` as an ABSOLUTE epoch-milliseconds window reset, not a duration.
 * Honour it when it fits the remaining budget, otherwise fall back to exponential backoff. Returns
 * null when no further wait fits, which ends the retry loop.
 */
function rateLimitDelayMs(
  error: unknown,
  attempt: number,
  remainingBudgetMs: number
): number | null {
  if (remainingBudgetMs <= 0) return null;
  const match = /"retryAfter"\s*:\s*(\d+)/.exec(errorMessage(error));
  if (match !== null) {
    // Clear the window boundary rather than racing it.
    const waitMs = Number(match[1]) - Date.now() + 250;
    if (Number.isFinite(waitMs) && waitMs > 0) {
      return waitMs <= remainingBudgetMs ? waitMs : null;
    }
  }
  return Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1), remainingBudgetMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentCardOrgRuntime {
  private cachedToken?: { accessToken: string; expiresAtMs: number };
  /**
   * Client-credential tokens can enter their refresh window while several org
   * reads are fanned out together (for example, the payment lifecycle reads a
   * card and two transfer views concurrently). Coalesce that burst into one
   * token exchange. Besides avoiding needless load, this prevents one member
   * of the burst timing out after its siblings have already refreshed the same
   * credential.
   */
  private inFlightToken?: Promise<string>;

  constructor(
    private readonly toolCaller: TokenMcpToolCaller = mcpCallTool,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  /**
   * Calls an organization MCP tool, transparently recovering from the two failure modes that are
   * expected on a healthy provider: an expired token (refresh once) and a throttled request window
   * (wait for the window to refill, bounded). Everything else propagates untouched.
   *
   * A throttle used to escape as a raw transport error, so every caller that lacked its own
   * rate-limit handling turned a few seconds of provider backpressure into a hard failure.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    let lastRateLimitError: unknown;
    let remainingBudgetMs = RATE_LIMIT_TOTAL_DELAY_BUDGET_MS;
    for (let attempt = 1; attempt <= RATE_LIMIT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.callToolOnce(toolName, args);
      } catch (error) {
        if (!looksLikeRateLimitError(error)) throw error;
        lastRateLimitError = error;
        if (attempt === RATE_LIMIT_RETRY_ATTEMPTS) break;
        const waitMs = rateLimitDelayMs(error, attempt, remainingBudgetMs);
        if (waitMs === null) break;
        remainingBudgetMs -= waitMs;
        await delay(waitMs);
      }
    }
    // Keep the words "rate limit" in the message: callers that already detect provider throttling
    // by message text (the wallet-funding release observer) must keep recognising this outcome.
    throw new AgentCardOrgRuntimeError(
      `AgentCard Organization MCP rate limit exhausted for ${toolName}`,
      429,
      'agentcard_org_mcp_rate_limited',
      { tool: toolName, error: errorMessage(lastRateLimitError) }
    );
  }

  private async callToolOnce(toolName: string, args: Record<string, unknown>): Promise<unknown> {
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

    const cachedToken = this.cachedToken;
    if (cachedToken !== undefined && cachedToken.expiresAtMs > Date.now() + 60_000) {
      return cachedToken.accessToken;
    }

    let tokenPromise = this.inFlightToken;
    if (tokenPromise === undefined) {
      tokenPromise = this.fetchAccessToken().finally(() => {
        if (this.inFlightToken === tokenPromise) this.inFlightToken = undefined;
      });
      this.inFlightToken = tokenPromise;
    }

    try {
      return await tokenPromise;
    } catch (error) {
      // A proactive refresh must not turn a still-valid organization token into
      // an outage when AgentCard's token endpoint is temporarily unavailable.
      // Forced refreshes follow an MCP auth rejection, so they must never reuse
      // the rejected token.
      if (
        !forceClientCredentials &&
        cachedToken !== undefined &&
        cachedToken.expiresAtMs > Date.now() + MIN_STALE_TOKEN_VALIDITY_MS &&
        error instanceof AgentCardOrgRuntimeError &&
        error.code === 'agentcard_org_token_unavailable'
      ) {
        return cachedToken.accessToken;
      }
      throw error;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(
        process.env.AGENTCARD_ORG_TOKEN_ENDPOINT?.trim() || DEFAULT_ORG_TOKEN_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: requiredEnv('AGENTCARD_ORG_OAUTH_CLIENT_ID'),
            client_secret: requiredEnv('AGENTCARD_ORG_OAUTH_CLIENT_SECRET'),
            // Bind the token to the MCP audience (RFC 8707), matching the per-user OAuth flow.
            resource: AGENTCARD_MCP_RESOURCE,
          }),
          // Fail fast instead of hanging wallet funding/monitoring/reconciliation if the token
          // endpoint stalls.
          signal: AbortSignal.timeout(orgTokenTimeoutMs()),
        }
      );
    } catch (error) {
      if (error instanceof AgentCardOrgRuntimeError) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AgentCardOrgRuntimeError(
        timedOut
          ? 'Timed out acquiring an AgentCard Organization MCP access token'
          : 'Could not reach the AgentCard Organization MCP token endpoint',
        timedOut ? 504 : 502,
        'agentcard_org_token_unavailable',
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
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
