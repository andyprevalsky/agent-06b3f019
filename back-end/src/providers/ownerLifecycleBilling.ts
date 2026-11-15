import { isBenchmarkAgent } from './benchmarkAgent';
import { BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID } from './benchmarkPaymentIdentity';

export const BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ENV =
  'BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ID';

/** The dedicated live customer id, or '' when the owner probe billing is not configured. */
export function ownerLifecycleStripeCustomerId(): string {
  return (process.env[BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ENV] ?? '').trim();
}

/**
 * Live production AgentCard lifecycle probes run as the owner admin account. Only for that
 * owner's benchmark agents (`Agent.isBenchmark`, settable only with the internal API key), the
 * purchase takes the charged customer path against a dedicated live Stripe customer named by
 * BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ID — never the owner's own Subscription — so ordinary
 * agent runs keep the admin company-card path and the owner's billing is untouched.
 */
export interface OwnerLifecycleBilling {
  stripeCustomerId: string;
}

export async function ownerLifecycleBenchmarkBilling(
  userId: string,
  agentId: string | null | undefined,
  isBenchmark: (agentId: string | null | undefined) => Promise<boolean> = isBenchmarkAgent
): Promise<OwnerLifecycleBilling | null> {
  const stripeCustomerId = ownerLifecycleStripeCustomerId();
  if (stripeCustomerId === '' || userId !== BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID) {
    return null;
  }
  return (await isBenchmark(agentId)) ? { stripeCustomerId } : null;
}
