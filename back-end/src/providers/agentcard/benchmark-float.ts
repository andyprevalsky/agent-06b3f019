import {
  AgentCardOrgRuntimeError,
  callOrgTool as defaultCallOrgTool,
  orgRetryDeadlineAtMs,
  type AgentCardOrgToolCaller,
} from './org-runtime';
import { getOrgCardholderVerificationStatus } from './org-onboarding';
import { readAgentCardOrgWallet } from './org-wallet-monitor';
import { retryWithBackoff } from '../retry';

/**
 * Minimum sandbox pool the benchmark payment fixture requires, in cents.
 *
 * The sandbox lifecycle tasks are smoke tasks: every guest of a parallel smoke
 * fleet may hold one card for up to ~$44 at the same moment, so the floor covers
 * the predeploy hard cap (20 tasks) each holding the largest sandbox lifecycle
 * reservation, with margin. v2 has no programmatic sandbox funding (the pool is
 * provisioned via the dashboard / USDC deposit), so this is a *verification*
 * floor, not a top-up target. Override with BENCHMARK_AGENTCARD_MIN_FLOAT_CENTS.
 */
export const DEFAULT_MIN_SANDBOX_FLOAT_CENTS = 100_000;
const MAX_RATE_LIMIT_ATTEMPTS = 4;
const MAX_RATE_LIMIT_WAIT_MS = 65_000;
/**
 * AgentCard documents an org-wide "120 requests per minute" limit per API key, shared by every
 * devbox's smoke fleet and production. Its text-only throttle ("Too many requests, please try
 * again later") advertises no reset, so wait a jittered share of that one-minute window: guests
 * released together by the smoke start barrier must not retry in lockstep.
 */
const UNADVERTISED_RATE_LIMIT_WAIT_MS = 15_000;

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
    const outerKeys = outer ? Object.keys(outer).join(',') : 'non-object';
    const structuredKeys = structured ? Object.keys(structured).join(',') : 'none';
    throw new Error(
      `AgentCard list_cardholders returned no cardholders array (outer=${outerKeys}; structured=${structuredKeys})`
    );
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

/** AgentCard's terminal, mint-capable verification states. */
const KYC_READY_STATUSES = new Set(['verified', 'approved']);

/**
 * Resolve a sandbox org cardholder that actually exists AND can mint.
 *
 * Stale `BENCHMARK_AGENTCARD_CARDHOLDER_ID` values previously seeded Integration
 * rows that made every `create_card` return "Cardholder not found", which the
 * purchase path then rewrote as a funding-in-progress retry loop.
 *
 * Existing is necessary but NOT sufficient: a cardholder stuck at KYC `pending` resolves fine and
 * then fails the lifecycle gate at bootstrap. That is not hypothetical — the sandbox org holds two
 * cardholders, and `AGENTCARD_CARDHOLDER_ID` in `agents/.env` names the `pending` one, so plain
 * preference order deterministically picked the unusable cardholder while a `verified` one sat
 * right beside it. Preference order (including `BENCHMARK_CARDHOLDER_EMAILS`) is still honoured;
 * it is just filtered to cardholders that can actually mint. Ordering by known-good email and
 * filtering by live KYC state are complementary: the list encodes intent, the filter proves it.
 *
 * When nothing is verified we return the first candidate unchanged, so the caller's existing (and
 * more specific) KYC error is what the operator sees rather than a vaguer one from here.
 */
export async function resolveBenchmarkCardholderId(
  preferredIds: string[] = preferredBenchmarkCardholderIds(),
  callOrgTool: AgentCardOrgToolCaller = defaultCallOrgTool
): Promise<string> {
  // Resolution loops over candidates, so every read shares one rate-limit budget.
  const deadlineAtMs = orgRetryDeadlineAtMs();
  const callWithinBudget: AgentCardOrgToolCaller = (toolName, args) =>
    callOrgTool(toolName, args, deadlineAtMs);
  const cardholders = extractCardholders(await callWithinBudget('list_cardholders', {}));
  if (cardholders.length === 0) {
    throw new Error(
      'AgentCard sandbox org has no cardholders. Create one in sandbox mode at ' +
        `${AGENTCARD_DASHBOARD_URL} (auth uses AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET).`
    );
  }

  // Preference order: explicit env ids, then each well-known benchmark email in priority order,
  // then anything else. Deduplicated, preserving first occurrence.
  const emailOrdered = BENCHMARK_CARDHOLDER_EMAILS.flatMap((email) => {
    const match = cardholders.find((cardholder) => cardholder.email?.toLowerCase() === email);
    return match === undefined ? [] : [match.id];
  });
  const ordered = [
    ...preferredIds.filter((id) => cardholders.some((cardholder) => cardholder.id === id)),
    ...emailOrdered,
    ...cardholders.map((cardholder) => cardholder.id),
  ].filter((id, index, all) => all.indexOf(id) === index);

  for (const id of ordered) {
    // A cardholder whose status cannot be read is treated as not-ready rather than failing the
    // whole resolution: another candidate may still be verified. An exhausted org-wide throttle
    // says nothing about this cardholder, and reading the next one would only add load to it.
    const status = await getOrgCardholderVerificationStatus(id, {
      callOrgTool: callWithinBudget,
    }).catch((error: unknown) => {
      if (
        error instanceof AgentCardOrgRuntimeError &&
        error.code === 'agentcard_org_mcp_rate_limited'
      )
        throw error;
      return undefined;
    });
    if (status !== undefined && KYC_READY_STATUSES.has(status.toLowerCase())) return id;
  }
  // Nothing verifiable: fall back to the highest-preference candidate so the caller's more
  // specific KYC error surfaces, and so an org whose status endpoint is unavailable still
  // resolves the same cardholder the preference order would have chosen.
  return ordered[0];
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

/** 7.5–22.5 s: half to one and a half of UNADVERTISED_RATE_LIMIT_WAIT_MS, uniformly jittered. */
export function defaultUnadvertisedRateLimitWaitMs(_attempt: number): number {
  return Math.round(UNADVERTISED_RATE_LIMIT_WAIT_MS * (0.5 + Math.random()));
}

/**
 * The org runtime's own throttle retries span seconds; it then raises its typed 429. Treat that as
 * the same backpressure as an advertised `retryAfter`, bounded by this layer's existing attempt cap.
 */
function isUnadvertisedOrgThrottle(error: unknown): boolean {
  return (
    error instanceof AgentCardOrgRuntimeError &&
    error.code === 'agentcard_org_mcp_rate_limited' &&
    retryAfterMs(error) === undefined
  );
}

export interface SandboxFloatOptions {
  /** Delay before re-reading after a throttle with no advertised reset (tests inject 0). */
  unadvertisedRateLimitWaitMs?: (attempt: number) => number;
}

async function readWalletWithRateLimitRetry(
  callOrgTool: AgentCardOrgToolCaller,
  unadvertisedWaitMs: (attempt: number) => number
): Promise<unknown> {
  return retryWithBackoff(() => callOrgTool('get_company_wallet', {}), {
    maxRetries: MAX_RATE_LIMIT_ATTEMPTS,
    isRetryable: (error) => {
      if (isUnadvertisedOrgThrottle(error)) return true;
      const waitMs = retryAfterMs(error);
      return waitMs !== undefined && waitMs <= MAX_RATE_LIMIT_WAIT_MS;
    },
    getBackoffDelayMs: (error, attempt) =>
      isUnadvertisedOrgThrottle(error)
        ? Math.min(unadvertisedWaitMs(attempt), MAX_RATE_LIMIT_WAIT_MS)
        : (retryAfterMs(error) ?? 0),
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
  callOrgTool: AgentCardOrgToolCaller = defaultCallOrgTool,
  options: SandboxFloatOptions = {}
): Promise<AgentCardSandboxFloat> {
  const unadvertisedWaitMs =
    options.unadvertisedRateLimitWaitMs ?? defaultUnadvertisedRateLimitWaitMs;
  const wallet = await readAgentCardOrgWallet((toolName, args, deadlineAtMs) =>
    toolName === 'get_company_wallet'
      ? readWalletWithRateLimitRetry(callOrgTool, unadvertisedWaitMs)
      : callOrgTool(toolName, args, deadlineAtMs)
  );

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
