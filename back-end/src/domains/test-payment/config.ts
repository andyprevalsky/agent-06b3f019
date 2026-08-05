export const TEST_PAYMENT_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_PAYMENT !== 'false';

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

export const TEST_PAYMENT_PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');

/**
 * The single JWT-authenticated end user permitted to reach the production
 * benchmark lifecycle routes. Fails closed: when BENCHMARK_USER_ID is unset or
 * blank there is NO configured benchmark user, so only the internal API key can
 * authorize production lifecycle access. Never fall back to a hardcoded account.
 */
export const PRODUCTION_BENCHMARK_USER_ID = (process.env.BENCHMARK_USER_ID ?? '').trim();

export function getPhoneBenchmarkPaymentAuditPathOverride(): string {
  return (process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH ?? '').trim();
}

export function getBenchmarkAgentCardCardholderIdOverride(): string {
  return resolveBenchmarkAgentCardIds().cardholderId;
}

/**
 * Cursor Cloud can inject a truncated BENCHMARK_AGENTCARD_ORG_ID into the
 * process env (observed as 7 chars). Prefer a full AGENTCARD_* id when the
 * benchmark override is missing or too short to be a real org/cardholder id.
 *
 * Org and cardholder are one fixture pair: when the org id falls back to
 * AGENTCARD_ORG_ID, the benchmark cardholder override is treated as stale too
 * (Cursor often truncates org while leaving a full foreign cardholder id).
 */
export function resolveBenchmarkAgentCardIds(env: NodeJS.ProcessEnv = process.env): {
  orgId: string;
  cardholderId: string;
} {
  const agentOrg = (env.AGENTCARD_ORG_ID ?? '').trim();
  const agentCardholder = (env.AGENTCARD_CARDHOLDER_ID ?? '').trim();
  const benchmarkOrg = (env.BENCHMARK_AGENTCARD_ORG_ID ?? '').trim();
  const benchmarkCardholder = (env.BENCHMARK_AGENTCARD_CARDHOLDER_ID ?? '').trim();
  const orgUsesAgentFallback = benchmarkOrg.length < 20 && agentOrg.length >= 20;
  const orgId = orgUsesAgentFallback
    ? agentOrg
    : benchmarkOrg.length >= 20
      ? benchmarkOrg
      : agentOrg.length >= 20
        ? agentOrg
        : benchmarkOrg;
  const cardholderId = orgUsesAgentFallback
    ? agentCardholder.length >= 20
      ? agentCardholder
      : benchmarkCardholder
    : benchmarkCardholder.length >= 20
      ? benchmarkCardholder
      : agentCardholder.length >= 20
        ? agentCardholder
        : benchmarkCardholder;
  return { orgId, cardholderId };
}

/** Apply resolved benchmark AgentCard ids onto process.env (mutates env). */
export function applyResolvedBenchmarkAgentCardIds(env: NodeJS.ProcessEnv = process.env): {
  orgId: string;
  cardholderId: string;
} {
  const resolved = resolveBenchmarkAgentCardIds(env);
  if (resolved.orgId !== '') {
    env.BENCHMARK_AGENTCARD_ORG_ID = resolved.orgId;
  }
  if (resolved.cardholderId !== '') {
    env.BENCHMARK_AGENTCARD_CARDHOLDER_ID = resolved.cardholderId;
  }
  return resolved;
}
