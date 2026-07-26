import { callOrgTool as defaultCallOrgTool, type AgentCardOrgToolCaller } from './org-runtime';
import { extractAgentCardOrgWallet } from './org-wallet-monitor';

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

const AGENTCARD_DASHBOARD_URL = 'https://dashboard.agentcard.sh';

export interface AgentCardSandboxFloat {
  balanceCents: number;
  availableCents: number;
  committedCents: number;
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
  const wallet = extractAgentCardOrgWallet(await callOrgTool('get_company_wallet', {}));

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
