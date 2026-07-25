import { callOrgTool, type AgentCardOrgToolCaller } from './org-runtime';
import { extractAgentCardOrgWallet } from './org-wallet-monitor';

// Sandbox float floor. Concurrent benchmark runs (local Step 6a alongside a
// cloud/daily run, or two workspaces deploying at once) share the one org
// sandbox wallet, but each run reclaims ONLY its own card by transfer id — the
// lifecycle asserts its card's balance, never the absolute pool — so runs never
// corrupt each other's accounting. The only shared hazard is pool STARVATION,
// which the v2 sandbox wallet makes a non-issue: it is pre-provisioned with a
// large standing balance (~$1M), so this floor is a read-only precondition
// (verify the wallet is a funded sandbox), never a top-up. Override with
// BENCHMARK_AGENTCARD_FLOAT_CENTS when running very high fan-out.
const DEFAULT_SANDBOX_FLOAT_CENTS = 200_000;

export function sandboxFloatTargetCents(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.BENCHMARK_AGENTCARD_FLOAT_CENTS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SANDBOX_FLOAT_CENTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_SANDBOX_FLOAT_CENTS;
  return Math.max(parsed, DEFAULT_SANDBOX_FLOAT_CENTS);
}

export interface AgentCardSandboxFloat {
  balanceCents: number;
  availableCents: number;
}

/**
 * Verify the AgentCard *sandbox* company wallet is reachable and holds at least
 * `targetCents` of available headroom for benchmark payments.
 *
 * Authenticates via the org client-credentials OAuth flow (the same
 * `AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET` the runtime purchase path uses) and
 * reads the wallet through the v2 `get_company_wallet` MCP tool. The retired v1
 * `/orgs/<id>/wallet` REST endpoints and API keys are no longer used.
 *
 * v1 test-funding is gone: the v2 sandbox company wallet is pre-provisioned with
 * a large standing balance, so there is nothing to top up. This is a read-only
 * precondition that fails closed on a LIVE wallet — a misconfigured benchmark
 * can never draw real funds.
 */
export async function ensureAgentCardSandboxFloat(
  targetCents = sandboxFloatTargetCents(),
  toolCaller: AgentCardOrgToolCaller = callOrgTool
): Promise<AgentCardSandboxFloat> {
  const wallet = extractAgentCardOrgWallet(await toolCaller('get_company_wallet', {}));
  if (wallet.livemode) {
    throw new Error(
      'Refusing to run benchmark payments against a LIVE AgentCard org wallet (expected sandbox)'
    );
  }
  if (wallet.availableCents < targetCents) {
    throw new Error(
      `AgentCard sandbox wallet available $${(wallet.availableCents / 100).toFixed(2)} ` +
        `is below the required floor $${(targetCents / 100).toFixed(2)}`
    );
  }
  return { balanceCents: wallet.balanceCents, availableCents: wallet.availableCents };
}
