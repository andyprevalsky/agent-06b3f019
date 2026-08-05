import { callOrgTool as defaultCallOrgTool, type AgentCardOrgToolCaller } from './org-runtime';
import { extractAgentCardOrgWallet } from './org-wallet-monitor';
import { retryWithBackoff } from '../retry';

/**
 * Minimum sandbox pool the benchmark payment fixture requires, in cents.
 *
 * The four sandbox lifecycle tasks each hold at most one card at a time
 * (max-concurrency 1) for up to ~$44, releasing the hold on abandon/close, so
 * $100 is >2x the largest single reservation with margin for sequential runs.
 * The retired v1 flow topped the wallet up to $500 via a `test-fund` REST
 * endpoint; v2 has no programmatic sandbox funding (the pool is provisioned via
 * the dashboard / USDC deposit), so this is a *verification* floor, not a
 * top-up target. Override with BENCHMARK_AGENTCARD_MIN_FLOAT_CENTS.
 */
const DEFAULT_MIN_SANDBOX_FLOAT_CENTS = 10_000;
const MAX_RATE_LIMIT_ATTEMPTS = 4;
const MAX_RATE_LIMIT_WAIT_MS = 65_000;

const AGENTCARD_DASHBOARD_URL = 'https://dashboard.agentcard.sh';
const BENCHMARK_CARDHOLDER_EMAIL = 'agentcard-benchmark@roselabs.ai';

export interface AgentCardSandboxFloat {
  balanceCents: number;
  availableCents: number;
  committedCents: number;
}

export interface AgentCardSandboxCardholder {
  id: string;
  email?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function extractCardholders(result: unknown): AgentCardSandboxCardholder[] {
  const outer = asRecord(result);
  const structured = asRecord(outer?.structuredContent) ?? outer;
  const raw = structured?.cardholders;
  if (!Array.isArray(raw)) {
    throw new Error('AgentCard list_cardholders returned no cardholders array');
  }
  return raw.flatMap((item) => {
    const record = asRecord(item);
    const id = optionalString(record?.id);
    if (id === undefined) return [];
    return [
      {
        id,
        ...(optionalString(record?.email) !== undefined
          ? { email: optionalString(record?.email) }
          : {}),
      },
    ];
  });
}

function preferredBenchmarkCardholderIds(
  env: Record<string, string | undefined> = process.env
): string[] {
  const preferred = [env.BENCHMARK_AGENTCARD_CARDHOLDER_ID, env.AGENTCARD_CARDHOLDER_ID]
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value !== '');
  return [...new Set(preferred)];
}

/**
 * Resolve a sandbox org cardholder that actually exists for the OAuth client.
 *
 * Stale `BENCHMARK_AGENTCARD_CARDHOLDER_ID` values previously seeded Integration
 * rows that made every `create_card` return "Cardholder not found", which the
 * purchase path then rewrote as a funding-in-progress retry loop.
 */
export async function resolveBenchmarkCardholderId(
  preferredIds: string[] = preferredBenchmarkCardholderIds(),
  callOrgTool: AgentCardOrgToolCaller = defaultCallOrgTool
): Promise<string> {
  const cardholders = extractCardholders(await callOrgTool('list_cardholders', {}));
  if (cardholders.length === 0) {
    throw new Error(
      'AgentCard sandbox org has no cardholders. Create one in sandbox mode at ' +
        `${AGENTCARD_DASHBOARD_URL} (auth uses AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET).`
    );
  }

  for (const preferredId of preferredIds) {
    if (cardholders.some((cardholder) => cardholder.id === preferredId)) {
      return preferredId;
    }
  }

  const byEmail = cardholders.find(
    (cardholder) => cardholder.email?.toLowerCase() === BENCHMARK_CARDHOLDER_EMAIL
  );
  if (byEmail !== undefined) return byEmail.id;
  return cardholders[0].id;
}

function minSandboxFloatCents(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BENCHMARK_AGENTCARD_MIN_FLOAT_CENTS?.trim();
  if (!raw) return DEFAULT_MIN_SANDBOX_FLOAT_CENTS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIN_SANDBOX_FLOAT_CENTS;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function retryAfterMs(error: unknown, nowMs: number = Date.now()): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/rate limit exceeded/i.test(message)) return undefined;
  const match = message.match(/["']?retryAfter["']?\s*:\s*(\d+)/i);
  if (!match) return undefined;
  const retryAtMs = Number(match[1]);
  if (!Number.isFinite(retryAtMs)) return undefined;
  return Math.max(0, retryAtMs - nowMs) + 250;
}

async function readWalletWithRateLimitRetry(callOrgTool: AgentCardOrgToolCaller): Promise<unknown> {
  return retryWithBackoff(() => callOrgTool('get_company_wallet', {}), {
    maxRetries: MAX_RATE_LIMIT_ATTEMPTS,
    isRetryable: (error) => {
      const waitMs = retryAfterMs(error);
      return waitMs !== undefined && waitMs <= MAX_RATE_LIMIT_WAIT_MS;
    },
    getBackoffDelayMs: (error) => retryAfterMs(error) ?? 0,
    component: 'AgentCardBenchmarkFloat',
  });
}

/**
 * Confirm the AgentCard sandbox company wallet holds enough float for the
 * benchmark payment lifecycle.
 *
 * Authentication is machine-to-machine OAuth 2.1 client credentials
 * (AGENTCARD_ORG_OAUTH_CLIENT_ID / AGENTCARD_ORG_OAUTH_CLIENT_SECRET), minted
 * and refreshed non-interactively by {@link AgentCardOrgToolCaller}. Unlike the
 * retired interactive admin/user JWT sessions (`~/.agent-cards*.json`), these
 * credentials never require a browser magic-link re-auth, so the deploy gate no
 * longer breaks when a session token silently expires.
 */
export async function ensureAgentCardSandboxFloat(
  minCents: number = minSandboxFloatCents(),
  callOrgTool: AgentCardOrgToolCaller = defaultCallOrgTool
): Promise<AgentCardSandboxFloat> {
  const wallet = extractAgentCardOrgWallet(await readWalletWithRateLimitRetry(callOrgTool));

  if (wallet.livemode) {
    throw new Error(
      'AgentCard benchmark requires sandbox OAuth credentials; get_company_wallet resolved to a live wallet. ' +
        'Point AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET at the sandbox org so the float never draws on live funds.'
    );
  }

  if (wallet.availableCents < minCents) {
    throw new Error(
      `AgentCard sandbox pool too low: ${formatUsd(wallet.availableCents)} available ` +
        `(< ${formatUsd(minCents)} required). v2 has no programmatic sandbox top-up; ` +
        `re-up the org wallet in sandbox mode at ${AGENTCARD_DASHBOARD_URL} ` +
        `(auth uses AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET — no interactive login needed).`
    );
  }

  return {
    balanceCents: wallet.balanceCents,
    availableCents: wallet.availableCents,
    committedCents: wallet.committedCents,
  };
}
