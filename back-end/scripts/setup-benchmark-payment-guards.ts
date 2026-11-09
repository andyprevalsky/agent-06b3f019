import Stripe from 'stripe';
// The production identity lives in providers/benchmarkPaymentIdentity; importing
// it from purchases/config resolved to `undefined`, which silently disabled the
// sandbox half of assertUserMatchesMode (undefined never equals a real user id),
// so sandbox provisioning could overwrite the live Stripe customer + cardholder.
import { BENCHMARK_PAYMENT_LIFECYCLE_USER_ID } from '../src/domains/purchases/config';
import { BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID } from '../src/providers/benchmarkPaymentIdentity';
import { getV2ConnectedUserId } from '../src/providers/agentcard/store';
import { agentCardV2Request } from '../src/providers/agentcard/api-v2';

/** Read-only admission before any live fixture/Stripe write. Never connects or advances KYC. */
export async function requireLiveV2FixtureReady(
  userId: string,
  dependencies: Partial<{
    getConnectedUserId: typeof getV2ConnectedUserId;
    request: typeof agentCardV2Request;
  }> = {}
): Promise<void> {
  const v2UserId = await (dependencies.getConnectedUserId ?? getV2ConnectedUserId)(userId);
  if (v2UserId === undefined || v2UserId.trim() === '') {
    throw new Error(
      '--live requires the normal signed live AgentCard connection and consent for this Rose user under the current organization client; a legacy cardholderId cannot establish v2 readiness. Complete connection first, then re-run.'
    );
  }
  const request = dependencies.request ?? agentCardV2Request;
  const wallet = await request('GET', '/api/v2/company_wallet');
  if (wallet.livemode !== true || wallet.default_funds_source !== 'company_flow') {
    throw new Error(
      '--live requires provider-verified live credentials and company_flow funding; no fixture changes were made'
    );
  }
  const kyc = await request('GET', `/api/v2/kyc?user_id=${encodeURIComponent(v2UserId)}`);
  if (kyc.status !== 'approved') {
    throw new Error(
      '--live requires approved KYC for the connected v2 user; finish the normal signed live connection/KYC flow before provisioning'
    );
  }
}

/** Sandbox and live fixtures must never share their Stripe, user, or AgentCard identities. */
export type FixtureMode = 'sandbox' | 'live';

export const DEFAULT_SANDBOX_CARDHOLDER_ID = 'cmrfpz6d1000bl804w1gggfto';

/** Require the production Stripe key without echoing malformed secret material. */
export function requireStripeLiveKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (key === '') {
    throw new Error('STRIPE_SECRET_KEY is required to provision the production payment fixture');
  }
  if (!key.startsWith('sk_live_')) {
    throw new Error(
      '--live provisions the PRODUCTION payment-lifecycle identity and needs the live Stripe key ' +
        `(sk_live_*). Run it with production's STRIPE_SECRET_KEY.`
    );
  }
  return key;
}

function databaseHost(env: NodeJS.ProcessEnv): string {
  const raw = (env.DATABASE_URL ?? '').trim();
  if (raw === '') throw new Error('DATABASE_URL is required to seed benchmark payment fixtures');
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error('DATABASE_URL is not a parseable connection URL');
  }
}

const LOCAL_DATABASE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'host.docker.internal',
]);

/**
 * The sandbox fixture writes test-mode payment pointers, so accept only local databases unless
 * an operator explicitly acknowledges a remote target.
 */
export function assertSandboxDatabaseIsLocal(env: NodeJS.ProcessEnv = process.env): void {
  const host = databaseHost(env);
  if (LOCAL_DATABASE_HOSTS.has(host)) return;
  if (env.BENCHMARK_PAYMENT_ALLOW_REMOTE_DB === 'true') return;
  throw new Error(
    `Refusing to seed the sandbox payment fixture into non-local database host "${host}": it ` +
      'writes a test-mode Stripe customer and the AgentCard sandbox cardholder, which would ' +
      'clobber the live production fixture. Point DATABASE_URL at the isolated benchmark ' +
      'database, use --live for the production identity, or set ' +
      'BENCHMARK_PAYMENT_ALLOW_REMOTE_DB=true if this really is intended.'
  );
}

/** Resolve the live cardholder without ever falling back to the known sandbox fixture. */
export function requireLiveCardholderId(env: NodeJS.ProcessEnv = process.env): string {
  const cardholderId = (
    env.BENCHMARK_AGENTCARD_CARDHOLDER_ID ??
    env.AGENTCARD_CARDHOLDER_ID ??
    ''
  ).trim();
  if (cardholderId === '') {
    throw new Error(
      '--live needs the live AgentCard cardholder id. Set BENCHMARK_AGENTCARD_CARDHOLDER_ID ' +
        "(or AGENTCARD_CARDHOLDER_ID) to production's value."
    );
  }
  if (cardholderId === DEFAULT_SANDBOX_CARDHOLDER_ID) {
    throw new Error(
      '--live refuses the known AgentCard sandbox cardholder: production transfers would ' +
        "report livemode=false. Use production's cardholder id."
    );
  }
  return cardholderId;
}

/** Require the production organization MCP to resolve the cardholder to a terminal KYC state. */
export function assertLiveCardholderReady(status: string): void {
  if (status === 'verified' || status === 'approved') return;
  throw new Error(
    `The AgentCard cardholder did not resolve as a ready live cardholder (${status}). ` +
      'Check the production organization credentials and cardholder id before provisioning.'
  );
}

/** Prevent the one-row Subscription/Integration identities from crossing Stripe modes. */
export function assertUserMatchesMode(userId: string, mode: FixtureMode): void {
  const forbiddenUserId =
    mode === 'live'
      ? BENCHMARK_PAYMENT_LIFECYCLE_USER_ID
      : BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID;
  if (userId !== forbiddenUserId) return;
  throw new Error(
    `Refusing to run ${mode} provisioning for ${userId}: that id is the ` +
      `${mode === 'live' ? 'sandbox' : 'production'} identity. One user owns a single ` +
      'Subscription and a single agentcard Integration, so this would overwrite its Stripe ' +
      'customer and cardholder with the wrong mode. Unset BENCHMARK_USER_ID or pass the correct ' +
      '--user-id.'
  );
}

/** Match only Stripe's missing-resource response; authentication and provider errors must escape. */
export function isStripeResourceMissing(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing'
  );
}

/** Exact operator-selected fixture ownership; validate before any provisioning DB write. */
export async function requireOwnedLiveFixtureCustomer(
  stripe: Stripe,
  customerId: string,
  userId: string
): Promise<string> {
  if (customerId.trim() === '') throw new Error('--stripe-customer-id must not be blank');
  const customer = await stripe.customers.retrieve(customerId);
  if (
    customer.deleted === true ||
    customer.id !== customerId ||
    customer.livemode !== true ||
    customer.metadata?.userId !== userId ||
    customer.metadata?.fixture !== 'agent-payment-production-lifecycle'
  ) {
    throw new Error('Selected Stripe customer is not an owned live production lifecycle fixture');
  }
  return customer.id;
}

/** Select local LIVE aliases without changing deployed/global credentials or choosing an identity. */
export function configureLiveFixtureEnvironment(
  cardholderId: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  const liveId = env.AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE?.trim() ?? '';
  const liveSecret = env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET_LIVE?.trim() ?? '';
  if (Boolean(liveId) !== Boolean(liveSecret)) {
    throw new Error(
      'A complete AgentCard LIVE credential pair is required when either alias is set'
    );
  }
  const selected = cardholderId?.trim();
  if (cardholderId !== undefined && !selected) {
    throw new Error('--agentcard-cardholder-id requires a nonempty dedicated cardholder ID');
  }
  if (liveId && liveSecret) {
    env.AGENTCARD_ORG_OAUTH_CLIENT_ID = liveId;
    env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = liveSecret;
  }
  if (selected) env.BENCHMARK_AGENTCARD_CARDHOLDER_ID = selected;
}
