import { callOrgTool as defaultCallOrgTool, type AgentCardOrgToolCaller } from './org-runtime';
import { getOrgCardholderVerificationStatus } from './org-onboarding';
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
/**
 * Prefer the already-KYC'd Andy cardholder on the live org, then the dedicated
 * sandbox benchmark cardholder (also verified). Never invent a new cardholder
 * or fall into onboarding when either of these exists for the OAuth org.
 */
export const BENCHMARK_CARDHOLDER_EMAILS = [
  'andy@roselabs.ai',
  'agentcard-benchmark@roselabs.ai',
] as const;

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

  for (const email of BENCHMARK_CARDHOLDER_EMAILS) {
    const byEmail = cardholders.find(
      (cardholder) => cardholder.email?.toLowerCase() === email
    );
    if (byEmail !== undefined) return byEmail.id;
  }
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

function maskCardholderId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isCardholderNotFoundMessage(message: string): boolean {
  return /\bcardholder not found\b/i.test(message);
}

/**
 * Confirm the benchmark cardholder exists in the same OAuth org as the sandbox wallet float
 * check. Wallet balance alone is insufficient: a mismatched BENCHMARK_AGENTCARD_CARDHOLDER_ID
 * passes float verification but mint loops forever on "Cardholder not found".
 */
export async function ensureBenchmarkOrgCardholder(
  cardholderId: string,
  callOrgTool: AgentCardOrgToolCaller = defaultCallOrgTool
): Promise<{ verificationStatus: string }> {
  const trimmedCardholderId = cardholderId.trim();
  if (trimmedCardholderId === '') {
    throw new Error(
      'BENCHMARK_AGENTCARD_CARDHOLDER_ID is required for the AgentCard payment lifecycle fixture'
    );
  }

  let verificationStatus: string;
  try {
    verificationStatus = await getOrgCardholderVerificationStatus(trimmedCardholderId, {
      callOrgTool,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isCardholderNotFoundMessage(message)) {
      throw new Error(
        'AgentCard benchmark cardholder does not exist in the OAuth org tied to ' +
          'AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET. Set BENCHMARK_AGENTCARD_ORG_ID and ' +
          'BENCHMARK_AGENTCARD_CARDHOLDER_ID together to a cardholder that belongs to that org ' +
          `(wallet float passed but cardholder ${maskCardholderId(trimmedCardholderId)} was not found).`
      );
    }
    throw new Error(`AgentCard benchmark cardholder readiness check failed: ${message}`);
  }

  if (verificationStatus !== 'verified' && verificationStatus !== 'approved') {
    throw new Error(
      `AgentCard benchmark cardholder is not KYC-ready (${verificationStatus}); ` +
        'complete sandbox cardholder verification before running the payment lifecycle gate.'
    );
  }

  return { verificationStatus };
}
