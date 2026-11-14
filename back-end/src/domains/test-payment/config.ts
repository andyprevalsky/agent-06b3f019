export const TEST_PAYMENT_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_PAYMENT !== 'false';

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

export const TEST_PAYMENT_PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');

export const TEST_PAYMENT_LIVE_LIFECYCLE_QUERY = 'agentcard-live-lifecycle';

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

/** True when org OAuth client credentials are present for cardholder verification. */
export function isAgentCardOrgOAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.AGENTCARD_ORG_OAUTH_CLIENT_ID ?? '').trim() !== '' &&
    (env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET ?? '').trim() !== ''
  );
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

/**
 * Where Stripe returns the shopper after a hosted Checkout. Prefers the tunnel/base URL a benchmark
 * stack advertises so a cloud browser agent lands somewhere it can actually reach; falls back to
 * production. Stripe requires an absolute URL, so this can never be a relative path.
 */
export const TEST_PAYMENT_CHECKOUT_RETURN_URL = (
  TEST_PAYMENT_PUBLIC_BASE_URL !== '' ? TEST_PAYMENT_PUBLIC_BASE_URL : 'https://roselabs.ai'
).replace(/\/+$/, '');

/** Provider identity is configured server-side; browser user_id/cardholderId is never accepted. */
export function getBenchmarkV2FixtureUserId(): string | undefined {
  const value = process.env.BENCHMARK_AGENTCARD_V2_USER_ID?.trim();
  return value === '' ? undefined : value;
}

export function getSandboxFixtureDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}
