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
 * Bounded by a TOTAL delay budget rather than a per-attempt delay, and that budget is anchored to a
 * DEADLINE THE CALLER OWNS rather than re-armed inside every `callTool`. A per-call budget bounds
 * exactly one call and nothing more: the callers that poll this runtime in a loop (the
 * wallet-funding release observer, the card-mint transfer-visibility poll) re-enter `callTool` per
 * observation, so a per-call budget multiplies — 6 observations could add 6 budgets (180s) and the
 * mint's 12 reads 12 budgets (360s), swamping the poll's own schedule and overrunning the upstream
 * request/activity timeout. A looping caller therefore takes ONE deadline from
 * {@link orgRetryDeadlineAtMs} before its loop and threads it through every call in that loop, so
 * the whole loop can never add more than one budget. A call that passes no deadline still gets a
 * full fresh budget, so single-shot callers are unaffected.
 *
 * Retrying is the LAST line of defence, not the fix: the budget is far smaller than the throttle
 * window (60s), so the durable remedy is issuing fewer requests. See `org-poll-schedule.ts` for the
 * backoff that removed most of the volume, and `inFlightReads` below for the coalescing that
 * removes duplicate concurrent reads.
 *
 * The budget is sized off the provider's OWN advertised reset, not guessed. A measured throttle
 * during the payment-lifecycle read advertised `retryAfter` 13.8s out; the previous 10s budget
 * missed it by ~4s, so every throttle fell straight through to a hard failure having waited less
 * than a millisecond. Honouring a documented Retry-After is the client's side of the rate-limit
 * contract, so the budget covers half the 60s window: far enough to ride out a mid-refill window,
 * while a reset more than half a window away still surrenders to the caller instead of parking the
 * request behind a throttle that deep.
 */
const RATE_LIMIT_RETRY_ATTEMPTS = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_TOTAL_DELAY_BUDGET_MS = 30_000;

/**
 * One rate-limit retry budget, anchored now.
 *
 * A caller that issues a single organization call can ignore this: `callTool` arms a fresh budget
 * per call by default. A caller that LOOPS over `callTool` must take ONE deadline before its loop
 * and pass it to every call inside the loop — otherwise each iteration re-arms the budget and the
 * loop accumulates one budget per iteration instead of one in total.
 */
export function orgRetryDeadlineAtMs(): number {
  return Date.now() + RATE_LIMIT_TOTAL_DELAY_BUDGET_MS;
}

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
  args: Record<string, unknown>,
  /**
   * Rate-limit retry deadline shared with the caller's other calls. Omit it for a one-shot call;
   * see {@link orgRetryDeadlineAtMs} for why a looping caller must supply one.
   */
  deadlineAtMs?: number
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
 *
 * Deliberately does NOT match a bare `429`: provider errors routinely carry unrelated numbers
 * (transfer amounts in cents, record counts, id fragments), and misreading one as a throttle
 * relabels the real failure as a rate limit and hides it. Only an explicit HTTP-status form or the
 * provider's own wording counts.
 */
function looksLikeRateLimitError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /too many requests|rate.?limit/i.test(message) ||
    /\b(?:status|code|http)\D{0,10}429\b/i.test(message)
  );
}

/**
 * AgentCard reports `retryAfter` as an ABSOLUTE epoch-milliseconds window reset, not a duration.
 *
 * Honour it when it fits the remaining budget, otherwise fail fast. Returns null when no further
 * wait fits, which ends the retry loop.
 *
 * Failing fast is deliberate, and is NOT the same as giving up cheaply: when the provider advertises
 * a reset minutes away, three more requests will not succeed, and issuing them adds load to a
 * resource that is already refusing work. The caller gets a typed 429 instead, immediately. The
 * cost of that choice is that a far window produces a sub-millisecond "exhausted" error, which
 * reads like a bug in the retry — hence the upstream body is now embedded in the thrown message.
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

/**
 * Organization tools that only READ provider state. Two identical reads issued while one is still
 * in flight cannot observe different data, so they are coalesced into a single request. Mutations
 * (`create_card`, `close_card`, `confirm_collection`, `test_charge`, the KYC/onboarding starters)
 * are deliberately absent: they must reach AgentCard once per caller.
 */
const IDEMPOTENT_READ_TOOLS = new Set([
  'get_card',
  'get_card_details',
  'get_cardholder_kyc_status',
  'get_company_wallet',
  'get_onboarding_session',
  'list_cards',
  'list_transfers',
]);

/** Order-independent key so two call sites building the same args share one in-flight request. */
function readKey(toolName: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args).sort(([left], [right]) => left.localeCompare(right));
  return `${toolName}:${JSON.stringify(entries)}`;
}

/**
 * Joiners get their own copy so a caller that mutates a parsed provider record cannot corrupt a
 * sibling's view. The first caller keeps the original object, so an uncoalesced call is untouched.
 */
function detachedCopy(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
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
  /**
   * In-flight idempotent reads, keyed by tool + args. The organization MCP throttle is shared by
   * EVERY org caller at 120 requests/minute, and Rose fans identical reads out constantly: each
   * concurrent payment-lifecycle read issues the same `list_transfers` status sweep, and the minute
   * cron reconciler polls the same `list_transfers` page as an in-flight wallet reclaim. Coalescing
   * makes that fan-out cost one request instead of one per caller, so request volume stays flat as
   * concurrent agents grow rather than scaling with them.
   */
  private readonly inFlightReads = new Map<string, Promise<unknown>>();

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
   *
   * `deadlineAtMs` is the caller-owned end of the rate-limit delay budget. Defaulting it here means
   * a one-shot call still gets a full budget; a looping caller passes the SAME deadline to every
   * call so the loop shares one budget (see {@link orgRetryDeadlineAtMs}).
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    deadlineAtMs: number = orgRetryDeadlineAtMs()
  ): Promise<unknown> {
    if (!IDEMPOTENT_READ_TOOLS.has(toolName))
      return this.callToolWithRateLimitRetry(toolName, args, deadlineAtMs);
    const key = readKey(toolName, args);
    const joined = this.inFlightReads.get(key);
    if (joined !== undefined) return detachedCopy(await joined);
    const read = this.callToolWithRateLimitRetry(toolName, args, deadlineAtMs).finally(() => {
      if (this.inFlightReads.get(key) === read) this.inFlightReads.delete(key);
    });
    this.inFlightReads.set(key, read);
    return read;
  }

  private async callToolWithRateLimitRetry(
    toolName: string,
    args: Record<string, unknown>,
    deadlineAtMs: number
  ): Promise<unknown> {
    let lastRateLimitError: unknown;
    for (let attempt = 1; attempt <= RATE_LIMIT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.callToolOnce(toolName, args);
      } catch (error) {
        if (!looksLikeRateLimitError(error)) throw error;
        lastRateLimitError = error;
        if (attempt === RATE_LIMIT_RETRY_ATTEMPTS) break;
        // Derived from the deadline, not decremented locally: time spent inside the throttled call
        // itself counts against the budget too, and a shared deadline already reflects every wait
        // the caller's earlier calls consumed.
        const waitMs = rateLimitDelayMs(error, attempt, deadlineAtMs - Date.now());
        if (waitMs === null) break;
        await delay(waitMs);
      }
    }
    // Keep the words "rate limit" in the message: callers that already detect provider throttling
    // by message text (the wallet-funding release observer) must keep recognising this outcome.
    //
    // Embed the provider's own text in the MESSAGE, not just `details`. Error logging prints the
    // message and drops structured details, so keeping the upstream body out of it made every
    // throttle look identical and unattributable — the failure that made this bug take three runs
    // to characterise.
    throw new AgentCardOrgRuntimeError(
      `AgentCard Organization MCP rate limit exhausted for ${toolName} ` +
        `after ${RATE_LIMIT_RETRY_ATTEMPTS} attempts; upstream: ${errorMessage(lastRateLimitError)}`,
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

    // A forced refresh must start its OWN exchange. It only ever runs after the MCP rejected the
    // token we just sent, and an exchange that was already in flight when that rejection arrived
    // can resolve to that very token (client-credential endpoints re-serve a still-unexpired token
    // for the same client). Joining it would resend the rejected credential and fail again — the
    // reachable case being the concurrent read fan-out, where one member of a burst gets a 401
    // while a sibling's proactive refresh is still pending.
    let tokenPromise = this.inFlightToken;
    if (tokenPromise === undefined || forceClientCredentials) {
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
