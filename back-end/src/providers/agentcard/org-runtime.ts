import { createLogger } from '../logger';
import { AGENTCARD_MCP_RESOURCE } from './config';

const log = createLogger('AgentCardOrgRuntime');

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
const ORG_MCP_TOOL_TIMEOUT_MS = 30_000;
const ORG_MCP_AUTH_RETRY_ATTEMPTS = 3;
const ORG_MCP_AUTH_RETRY_DELAY_MS = 250;

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

function looksLikeMcpTimeoutError(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }
  return /aborted due to timeout|operation was aborted/i.test(errorMessage(error));
}

/**
 * undici surfaces a request that never produced an HTTP response as `TypeError: fetch failed`
 * with the Node/undici error on `.cause` (an AggregateError for a multi-address ECONNREFUSED).
 * Connect-phase codes mean the request never left this process: undici's own 10 s connect
 * timeout (`UND_ERR_CONNECT_TIMEOUT`), a refused port or a transient resolver failure. The
 * request-phase codes mean the socket died after the request may have reached the provider.
 * treasury-rails 2026-10-31: one connect timeout on `list_recoveries` after ~60 healthy calls
 * failed the deploy gate as `retryable=false` while 19.9 s of retry budget remained.
 */
const CONNECT_PHASE_FETCH_FAILURE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const REQUEST_PHASE_FETCH_FAILURE_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** The transient transport code behind a `fetch failed`, or undefined for any other failure. */
function fetchTransportFailureCode(error: unknown): string | undefined {
  // `fetch failed`: no response at all; `terminated`: undici aborted the body read mid-stream.
  if (!(error instanceof Error) || !['fetch failed', 'terminated'].includes(error.message)) {
    return undefined;
  }
  const codes: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || typeof value !== 'object' || value === null) return;
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string') codes.push(record.code);
    visit(record.cause, depth + 1);
    if (Array.isArray(record.errors)) for (const nested of record.errors) visit(nested, depth + 1);
  };
  visit((error as { cause?: unknown }).cause, 0);
  return codes.find(
    (code) =>
      CONNECT_PHASE_FETCH_FAILURE_CODES.has(code) || REQUEST_PHASE_FETCH_FAILURE_CODES.has(code)
  );
}

function looksLikeTransientUnavailableError(error: unknown): boolean {
  return (
    /temporarily unavailable|service unavailable/i.test(errorMessage(error)) ||
    looksLikeMcpTimeoutError(error)
  );
}

function shouldRetryOrgMcpError(error: unknown): boolean {
  return looksLikeRateLimitError(error) || looksLikeTransientUnavailableError(error);
}

function mcpStructuredResultRetryableError(
  result: unknown,
  toolName: string
): AgentCardOrgRuntimeError | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const structured =
    typeof record.structuredContent === 'object' && record.structuredContent !== null
      ? (record.structuredContent as Record<string, unknown>)
      : record;
  const message = typeof structured.message === 'string' ? structured.message : '';
  const status = structured.status;
  if (status !== 'error' && status !== 'unavailable') return undefined;
  if (looksLikeRateLimitError(message)) {
    return new AgentCardOrgRuntimeError(
      `AgentCard Organization MCP ${toolName} is rate limited: ${message}`,
      429,
      'agentcard_org_mcp_rate_limited',
      { tool: toolName, message }
    );
  }
  if (/temporarily unavailable|service unavailable/i.test(message)) {
    return new AgentCardOrgRuntimeError(
      `AgentCard Organization MCP ${toolName} is temporarily unavailable: ${message}`,
      503,
      'agentcard_org_mcp_unavailable',
      { tool: toolName, message }
    );
  }
  return undefined;
}

/**
 * AgentCard also reports its upstream API-key throttle as an HTTP-200 `isError` tools/call result
 * without a structured status ("<tool> failed: API key rate limit exceeded, please try again
 * later", no `retryAfter`), which {@link mcpStructuredResultRetryableError} cannot see.
 */
function mcpToolResultRateLimitMessage(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const record = result as Record<string, unknown>;
  if (record.isError !== true) return undefined;
  const structured =
    typeof record.structuredContent === 'object' && record.structuredContent !== null
      ? (record.structuredContent as Record<string, unknown>)
      : record;
  const text = (Array.isArray(record.content) ? record.content : [])
    .map((part) => (part as { text?: unknown } | null)?.text)
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('\n');
  const message =
    typeof structured.message === 'string' && structured.message !== '' ? structured.message : text;
  return looksLikeRateLimitError(message) ? message : undefined;
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
 * AgentCard Organization MCP authenticates with the `acs_…` client secret as the
 * Bearer token (the token endpoint's JWT is `scope: api` and MCP rejects it).
 * `initialize` 401s on a healthy secret while `tools/call` succeeds, so the org
 * runtime posts JSON-RPC tools/call directly instead of using the MCP SDK session.
 */
function parseMcpJsonRpcFrames(bodyText: string): Record<string, unknown>[] {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{')) {
    return [JSON.parse(trimmed) as Record<string, unknown>];
  }
  const frames: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]' || !payload.startsWith('{')) continue;
    try {
      frames.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // Streamable HTTP may emit a non-JSON endpoint URL as the first data line.
    }
  }
  return frames;
}

function selectMcpJsonRpcFrame(
  frames: Record<string, unknown>[],
  bodyText: string
): Record<string, unknown> {
  const withResult = [...frames].reverse().find((frame) => 'result' in frame);
  if (withResult !== undefined) return withResult;
  const withError = [...frames]
    .reverse()
    .find((frame) => frame.error !== undefined && frame.error !== null);
  if (withError !== undefined) return withError;
  return frames.at(-1) ?? { message: bodyText.trim() };
}

async function callOrgMcpTool(
  accessToken: string,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl: FetchLike = fetch
): Promise<unknown> {
  let lastError: AgentCardOrgRuntimeError | undefined;
  for (let attempt = 1; attempt <= ORG_MCP_AUTH_RETRY_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(AGENTCARD_MCP_RESOURCE, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
        signal: AbortSignal.timeout(ORG_MCP_TOOL_TIMEOUT_MS),
      });
    } catch (error) {
      const transportCode = fetchTransportFailureCode(error);
      if (
        transportCode !== undefined &&
        (CONNECT_PHASE_FETCH_FAILURE_CODES.has(transportCode) ||
          IDEMPOTENT_READ_TOOLS.has(toolName))
      ) {
        // A request that never reached the provider is safe to replay for every tool; a socket
        // that died after the request left is replayed only for the idempotent reads, exactly
        // like the text-only throttle. Same transient class as the AbortSignal timeout below.
        throw new AgentCardOrgRuntimeError(
          `AgentCard Organization MCP ${toolName} is temporarily unavailable: ` +
            `tools/call transport failed (${transportCode})`,
          503,
          'agentcard_org_mcp_unavailable',
          { tool: toolName, error: errorMessage(error), transport_code: transportCode }
        );
      }
      if (!looksLikeMcpTimeoutError(error)) throw error;
      // Convert AbortSignal.timeout into the same transient-unavailable class as a
      // structured 503 so callToolWithRateLimitRetry retries instead of failing the
      // payment/settle poll. Do not retry here — the outer loop owns the budget.
      throw new AgentCardOrgRuntimeError(
        `AgentCard Organization MCP ${toolName} is temporarily unavailable: ` +
          `tools/call timed out after ${ORG_MCP_TOOL_TIMEOUT_MS}ms`,
        503,
        'agentcard_org_mcp_unavailable',
        { tool: toolName, error: errorMessage(error) }
      );
    }
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error) {
      // Headers arrived, so the request reached the provider: replay the body-read failure only
      // for the idempotent reads (a mutation may already have changed provider state).
      const transportCode = fetchTransportFailureCode(error);
      if (!IDEMPOTENT_READ_TOOLS.has(toolName)) {
        // A mutation must never be replayed after its request reached the provider, even when
        // the body read aborted on the tools/call timeout (the outer classifier would otherwise
        // treat that AbortError as the retryable timeout class).
        // The message must not echo the underlying text: the outer classifier matches
        // "aborted due to timeout" by wording and would retry this error.
        throw new AgentCardOrgRuntimeError(
          `AgentCard Organization MCP ${toolName} response body read failed after the request ` +
            `reached the provider (${transportCode ?? 'body-read-aborted'}); not replayed`,
          502,
          'agentcard_org_mcp_unavailable',
          { tool: toolName, error: errorMessage(error), transport_code: transportCode ?? null }
        );
      }
      if (transportCode === undefined) throw error;
      throw new AgentCardOrgRuntimeError(
        `AgentCard Organization MCP ${toolName} is temporarily unavailable: ` +
          `tools/call response body read failed (${transportCode})`,
        503,
        'agentcard_org_mcp_unavailable',
        { tool: toolName, error: errorMessage(error), transport_code: transportCode }
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = selectMcpJsonRpcFrame(parseMcpJsonRpcFrames(bodyText), bodyText);
    } catch {
      parsed = { message: bodyText };
    }
    const rpcError = parsed.error;
    const hasRpcError = rpcError !== undefined && rpcError !== null && rpcError !== '';
    const errorText =
      typeof rpcError === 'string'
        ? rpcError
        : rpcError && typeof rpcError === 'object' && 'message' in rpcError
          ? String((rpcError as { message: unknown }).message)
          : typeof parsed.message === 'string'
            ? parsed.message
            : bodyText.slice(0, 200);
    if (!response.ok || hasRpcError) {
      lastError = new AgentCardOrgRuntimeError(
        `AgentCard Organization MCP ${toolName} failed: ${errorText}`,
        response.status >= 400 && response.status < 500 ? response.status : 502,
        response.status === 401 || response.status === 403
          ? 'agentcard_org_mcp_unauthorized'
          : 'agentcard_org_mcp_unavailable',
        { status: response.status, error: rpcError, message: parsed.message }
      );
      if (
        attempt === ORG_MCP_AUTH_RETRY_ATTEMPTS ||
        (response.status !== 401 && response.status !== 403)
      ) {
        throw lastError;
      }
      await delay(ORG_MCP_AUTH_RETRY_DELAY_MS);
      continue;
    }
    if ('result' in parsed) return parsed.result;
    throw new AgentCardOrgRuntimeError(
      `AgentCard Organization MCP ${toolName} failed: missing JSON-RPC result`,
      502,
      'agentcard_org_mcp_unavailable',
      { status: response.status, message: parsed.message }
    );
  }
  throw (
    lastError ??
    new AgentCardOrgRuntimeError(
      `AgentCard Organization MCP ${toolName} failed`,
      502,
      'agentcard_org_mcp_unavailable'
    )
  );
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
  'whoami',
  'list_cards',
  'list_cardholders',
  'list_recoveries',
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
  /**
   * In-flight idempotent reads, keyed by tool + args. The organization MCP throttle is shared by
   * EVERY org caller at 120 requests/minute, and Rose fans identical reads out constantly: each
   * concurrent payment-lifecycle read issues the same `list_transfers` status sweep, and the minute
   * cron reconciler polls the same `list_transfers` page as an in-flight wallet reclaim. Coalescing
   * makes that fan-out cost one request instead of one per caller, so request volume stays flat as
   * concurrent agents grow rather than scaling with them.
   */
  private readonly inFlightReads = new Map<string, Promise<unknown>>();
  private readonly toolCaller: TokenMcpToolCaller;
  private readonly fetchImpl: FetchLike;

  constructor(toolCaller?: TokenMcpToolCaller, fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
    this.toolCaller =
      toolCaller ??
      ((accessToken, toolName, args) =>
        callOrgMcpTool(accessToken, toolName, args, this.fetchImpl));
  }

  /**
   * Calls an organization MCP tool, transparently recovering from the failure modes that are
   * expected on a healthy provider: a flaky MCP 401/403 on `tools/call` (retry once), a throttled
   * request window (wait for the window to refill, bounded), a structured `{status:"error"}`
   * tools/call result (HTTP 200) reporting a sandbox outage or rate limit, and a read whose
   * text-only `isError` result reports an upstream API-key throttle (retried exactly like a
   * transport throttle). Everything else propagates untouched.
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
    let lastRetryError: unknown;
    for (let attempt = 1; attempt <= RATE_LIMIT_RETRY_ATTEMPTS; attempt += 1) {
      const startedAtMs = Date.now();
      try {
        const result = await this.callToolOnce(toolName, args);
        const retryableError = mcpStructuredResultRetryableError(result, toolName);
        if (retryableError !== undefined) throw retryableError;
        // A text-only throttle carries no structured status, so only reads are replayed: it can
        // arrive after a multi-step mutation's earlier upstream steps already changed provider state.
        const throttled = IDEMPOTENT_READ_TOOLS.has(toolName)
          ? mcpToolResultRateLimitMessage(result)
          : undefined;
        if (throttled !== undefined) {
          throw new AgentCardOrgRuntimeError(
            `AgentCard Organization MCP ${toolName} rate limited: ${throttled}`,
            429,
            'agentcard_org_mcp_rate_limited',
            { tool: toolName, message: throttled }
          );
        }
        log.info('Organization MCP tool call succeeded', {
          tool: toolName,
          attempt,
          duration_ms: Date.now() - startedAtMs,
        });
        return result;
      } catch (error) {
        const retryable = shouldRetryOrgMcpError(error);
        // Derived from the deadline, not decremented locally: time spent inside the throttled call
        // itself counts against the budget too, and a shared deadline already reflects every wait
        // the caller's earlier calls consumed.
        const waitMs =
          retryable && attempt < RATE_LIMIT_RETRY_ATTEMPTS
            ? rateLimitDelayMs(error, attempt, deadlineAtMs - Date.now())
            : null;
        log.warn('Organization MCP tool call failed', {
          tool: toolName,
          attempt,
          duration_ms: Date.now() - startedAtMs,
          error: errorMessage(error),
          retryable,
          retry_after_advertised: /"retryAfter"\s*:\s*\d+/.test(errorMessage(error)),
          retry_wait_ms: waitMs,
          retry_budget_remaining_ms: Math.max(0, deadlineAtMs - Date.now()),
        });
        if (!retryable) throw error;
        lastRetryError = error;
        if (waitMs === null) break;
        await delay(waitMs);
      }
    }
    if (
      looksLikeTransientUnavailableError(lastRetryError) &&
      !looksLikeRateLimitError(lastRetryError)
    ) {
      throw new AgentCardOrgRuntimeError(
        `AgentCard Organization MCP ${toolName} is temporarily unavailable ` +
          `after ${RATE_LIMIT_RETRY_ATTEMPTS} attempts; upstream: ${errorMessage(lastRetryError)}`,
        503,
        'agentcard_org_mcp_unavailable',
        { tool: toolName, error: errorMessage(lastRetryError) }
      );
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
        `after ${RATE_LIMIT_RETRY_ATTEMPTS} attempts; upstream: ${errorMessage(lastRetryError)}`,
      429,
      'agentcard_org_mcp_rate_limited',
      { tool: toolName, error: errorMessage(lastRetryError) }
    );
  }

  private async callToolOnce(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const accessToken = this.getAccessToken();
    try {
      return await this.toolCaller(accessToken, toolName, args);
    } catch (error) {
      if (!hasClientCredentials() || !looksLikeAuthError(error)) throw error;
      return this.toolCaller(this.getAccessToken(), toolName, args);
    }
  }

  /**
   * Organization MCP takes the `acs_…` client secret as Bearer. JWT exchange is
   * the user-OAuth path; those tokens come back `scope: api` and MCP 401s them.
   */
  private getAccessToken(): string {
    if (hasClientCredentials()) {
      return requiredEnv('AGENTCARD_ORG_OAUTH_CLIENT_SECRET');
    }
    const direct = directAccessToken();
    if (direct !== undefined) return direct;
    throw new AgentCardOrgRuntimeError(
      'Missing AGENTCARD_ORG_OAUTH_CLIENT_ID environment variable for AgentCard Organization MCP',
      409,
      'agentcard_org_mcp_unavailable',
      { missingEnv: 'AGENTCARD_ORG_OAUTH_CLIENT_ID' }
    );
  }
}

const runtime = new AgentCardOrgRuntime();

export const callOrgTool: AgentCardOrgToolCaller = (toolName, args, deadlineAtMs) =>
  runtime.callTool(toolName, args, deadlineAtMs);
