import { randomUUID } from 'node:crypto';
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import {
  BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID,
  BENCHMARK_PAYMENT_LIFECYCLE_USER_ID,
} from '../src/domains/purchases/config';
// providers/benchmarkPaymentIdentity owns the production identity. Importing it
// from purchases/config resolved to `undefined`, so `--live` would have resolved
// its seed identity to undefined and the sandbox/live guard never fired.
import { BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID } from '../src/providers/benchmarkPaymentIdentity';
import { applyResolvedBenchmarkAgentCardIds } from '../src/domains/test-payment/config';
import { loadDotenvWithCallerOverrides } from '../src/providers/loadDotenvWithCallerOverrides';
import { isAdminUser } from '../src/utils/adminAccess';
import { verifyBenchmarkOrgFixture } from '../src/providers/agentcard/benchmark-float';
import { getOrgCardholderVerificationStatus } from '../src/providers/agentcard/org-onboarding';
import {
  callOrgTool as defaultCallOrgTool,
  type AgentCardOrgToolCaller,
} from '../src/providers/agentcard/org-runtime';
import {
  extractAgentCardOrgWallet,
  type AgentCardOrgWallet,
} from '../src/providers/agentcard/org-wallet-monitor';
import {
  configureLiveFixtureEnvironment,
  assertLiveCardholderReady,
  assertSandboxDatabaseIsLocal,
  assertUserMatchesMode,
  isStripeResourceMissing,
  requireLiveCardholderId,
  requireStripeLiveKey,
  requireOwnedLiveFixtureCustomer,
  type FixtureMode,
} from './setup-benchmark-payment-guards';

// Cursor Cloud injects per-key secrets into the process env. A truncated
// BENCHMARK_AGENTCARD_ORG_ID (seen as 7 chars) would otherwise beat the full
// value in back-end/.env because dotenv defaults to non-override mode.
// Isolated stacks also inject PORT / DATABASE_URL / TEMPORAL_TASK_QUEUE —
// preserve those so payment seed and health probes hit the stack DB/port.
loadDotenvWithCallerOverrides();
applyResolvedBenchmarkAgentCardIds();

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
// Isolated sandbox lifecycle benches run as the default admin account and force
// the customer mint path (`BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH`). Seed that
// same user on the local isolated DB. The disposable `…106` identity remains
// valid for older fixtures.
const DEFAULT_BENCHMARK_USER_ID = BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID;
/** Where Stripe returns the operator after the one-time live card-on-file setup. */
const LIVE_CARD_SETUP_RETURN_URL = 'https://roselabs.ai/?benchmark-payment-card-saved=1';
/**
 * Non-admin benchmark users are subject to the normal credit gate (`unlimited` is admin-only), so
 * a depleted fixture user would stall every agent at OUT_OF_CREDITS. Top the balance up to this
 * much headroom above recorded usage instead of deleting ledger rows.
 */
const BENCHMARK_CREDIT_HEADROOM_CENTS = 100_000;

/**
 * The org-managed AgentCard integration the mint path reads (`getOrgManagedCardholderId`). Without
 * it a `company_flow` mint throws 409 `agentcard_setup_required` instead of issuing a card. The
 * cardholder is passed in because sandbox and production must never share one.
 */
async function seedAgentCardConnection(
  prisma: PrismaClient,
  userId: string,
  cardholderId: string
): Promise<void> {
  const configured = process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID?.trim();
  if (configured !== undefined && configured !== '' && configured !== cardholderId) {
    console.warn(
      `BENCHMARK_AGENTCARD_CARDHOLDER_ID=${configured} is not present in the sandbox org; ` +
        `seeding live cardholder ${cardholderId} instead`
    );
  }

  // A cardholder owns ONE funding wallet. Seeding a benchmark fixture onto a cardholder that
  // already belongs to a real user makes benchmark mints spend that user's live float — which is
  // exactly what happened in prod when BENCHMARK_AGENTCARD_CARDHOLDER_ID was pointed at a live
  // cardholder. Fail loudly instead of silently commingling funds.
  const existing = await prisma.integration.findMany({
    where: { name: 'agentcard', config: { path: ['cardholderId'], equals: cardholderId } },
    select: { userId: true },
  });
  const foreignOwner = existing.map((row) => row.userId).find((owner) => owner !== userId);
  if (foreignOwner !== undefined) {
    throw new Error(
      `Refusing to seed benchmark user ${userId} onto cardholder ${cardholderId}: it is already ` +
        `bound to user ${foreignOwner}. Point BENCHMARK_AGENTCARD_CARDHOLDER_ID at a dedicated ` +
        `sandbox cardholder.`
    );
  }

  const config = { orgManaged: true, cardholderId };
  await prisma.integration.upsert({
    where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
    create: {
      userId,
      name: 'agentcard',
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config,
    },
    update: {
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config,
      lastUsedAt: new Date(),
    },
  });
  console.log(
    `Seeded AgentCard org cardholder fixture ${cardholderId} for benchmark user ${userId}`
  );
}

/**
 * Keep the fixture user solvent without destroying its ledger. `getUserUsage` computes
 * `remaining = credits - toolUsage`, so a synthetic user accumulates usage across runs and would
 * eventually be gated at OUT_OF_CREDITS. Add only the deficit, so repeated seeding is idempotent;
 * the advisory lock serializes the read-then-top-up against concurrent setup processes (parallel
 * benchmark lanes seed the same identity), which would otherwise both observe the same deficit.
 */
async function ensureBenchmarkCredits(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // Prisma cannot deserialize PostgreSQL's `void` return type, so materialize the lock call
      // and project a supported scalar instead of selecting pg_advisory_xact_lock directly.
      await tx.$queryRaw`
        WITH acquired AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(
            hashtext(${`benchmark-payment-credit:${userId}`})::bigint
          )
        )
        SELECT 1 AS locked FROM acquired
      `;
      const now = new Date();
      const [creditTotal, usageTotal] = await Promise.all([
        tx.credit.aggregate({
          where: { userId, OR: [{ expirationDate: null }, { expirationDate: { gt: now } }] },
          _sum: { amountCents: true },
        }),
        tx.toolUsage.aggregate({ where: { userId }, _sum: { totalCostCents: true } }),
      ]);
      const availableCents = creditTotal._sum.amountCents ?? 0;
      const usedCents = usageTotal._sum.totalCostCents ?? 0;
      const deficitCents = usedCents + BENCHMARK_CREDIT_HEADROOM_CENTS - availableCents;
      if (deficitCents <= 0) {
        console.log(
          `Benchmark credit balance already sufficient for ${userId} ` +
            `($${((availableCents - usedCents) / 100).toFixed(2)} remaining)`
        );
        return;
      }
      await tx.credit.create({ data: { userId, amountCents: deficitCents, expirationDate: null } });
      console.log(
        `Topped up benchmark credits for ${userId} by $${(deficitCents / 100).toFixed(2)} ` +
          `(used $${(usedCents / 100).toFixed(2)})`
      );
    },
    { maxWait: 10_000, timeout: 10_000 }
  );
}

/**
 * Restrict destructive fixture replacement to the two dedicated, disposable lifecycle identities.
 * Everything below rewrites one-per-user rows (Subscription, agentcard Integration) and clears the
 * benchmark's PurchaseSpend history, so aiming it at a real account would clobber that account.
 * `assertUserMatchesMode` then pins WHICH of the two a given invocation may touch.
 */
function assertDedicatedBenchmarkUser(userId: string, mode: FixtureMode): void {
  if (
    userId === BENCHMARK_PAYMENT_LIFECYCLE_USER_ID ||
    userId === BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID
  ) {
    return;
  }
  // Isolated sandbox benches may seed the default admin account (local DB only)
  // when the customer mint path is forced. Never allow that identity on --live.
  if (mode === 'sandbox' && userId === BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID) {
    return;
  }
  throw new Error(
    `Refusing to seed payment fixtures for ${userId}; this command is restricted to the ` +
      `dedicated benchmark users ${BENCHMARK_PAYMENT_LIFECYCLE_USER_ID} (sandbox), ` +
      `${BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID} (sandbox admin run-user), and ` +
      `${BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID} (production)`
  );
}

/**
 * The lifecycle benchmarks assert a [REDACTED] Stripe hold, which only the non-admin funding path
 * produces. Seeding an admin here would silently re-route every benchmark purchase to
 * `issueAdminCompanyCard` and make those assertions unsatisfiable, so fail loudly instead.
 */
function assertNonAdminBenchmarkUser(userId: string, mode: FixtureMode): void {
  if (mode === 'sandbox' && userId === BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID) {
    return;
  }
  if (isAdminUser(userId)) {
    throw new Error(
      `Refusing to seed the payment-lifecycle fixture for admin user ${userId}: admins mint ` +
        'company-funded cards with no Stripe hold unless BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH ' +
        'is set. Use the dedicated non-admin benchmark user ' +
        `(${BENCHMARK_PAYMENT_LIFECYCLE_USER_ID}) or the sandbox admin run-user ` +
        `(${BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID}).`
    );
  }
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

/**
 * Resolve the fixture identity from `--user-id`, `BENCHMARK_USER_ID`, then the mode default.
 *
 * `argValue` returns the raw text after `=`, so `--user-id=` (and an exported-but-blank
 * `BENCHMARK_USER_ID`) resolves to `''` — which `??` KEEPS, because an empty string is not nullish.
 * An empty id then clears both downstream guards (it is neither a reserved sandbox/production
 * identity nor an admin), and `upsertBenchmarkUser` / `upsertBenchmarkSubscription` go on to create
 * a User and Subscription row keyed on `''`. Under `--live` that garbage row lands in the
 * PRODUCTION database. Treat every blank candidate as absent, and refuse a blank final answer.
 */
export function resolveBenchmarkUserId(candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? '';
    if (trimmed !== '') return trimmed;
  }
  throw new Error(
    'Refusing to seed the payment fixture with an empty user id: it would create User and ' +
      'Subscription rows keyed on "". Pass a non-blank --user-id, set BENCHMARK_USER_ID, or omit ' +
      'both to use the default fixture identity for this mode.'
  );
}

/**
 * A terminal KYC state proves the cardholder RESOLVES; it does not prove the ambient AgentCard org
 * credentials are the production ones. Sandbox credentials resolve their own sandbox cardholder to
 * `verified` just as happily, so `getOrgCardholderVerificationStatus` alone cannot stop a sandbox
 * cardholder id from being persisted into the PRODUCTION fixture — after which every "live"
 * benchmark transfer would run against the sandbox wallet and report `livemode: false`.
 *
 * `get_company_wallet` is the one org call that reports the credential's actual mode, so require it
 * before any `--live` write.
 */
export function assertLiveOrgWallet(wallet: AgentCardOrgWallet): void {
  if (wallet.livemode) return;
  throw new Error(
    '--live refuses to provision the production payment fixture with SANDBOX AgentCard org ' +
      'credentials: get_company_wallet reported livemode=false. A sandbox credential resolves a ' +
      'sandbox cardholder to a verified KYC state, so persisting its id would point the production ' +
      "fixture at the sandbox wallet. Export production's AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET."
  );
}

export async function requireLiveOrgWallet(
  callOrgTool: AgentCardOrgToolCaller = defaultCallOrgTool
): Promise<AgentCardOrgWallet> {
  const wallet = extractAgentCardOrgWallet(await callOrgTool('get_company_wallet', {}));
  assertLiveOrgWallet(wallet);
  return wallet;
}

/**
 * The benchmark organization and its cardholder are two halves of one wallet
 * fixture. Overriding only one (e.g. funding a custom org while the integration
 * keeps the default cardholder) prepares the wrong wallet and silently breaks
 * the lifecycle fixture. Require the pair to move together.
 */
function assertBenchmarkOrgCardholderPair(): void {
  const orgId = process.env.BENCHMARK_AGENTCARD_ORG_ID?.trim();
  const cardholderId = process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID?.trim();
  const orgSet = orgId !== undefined && orgId !== '';
  const cardholderSet = cardholderId !== undefined && cardholderId !== '';
  if (orgSet !== cardholderSet) {
    throw new Error(
      'BENCHMARK_AGENTCARD_ORG_ID and BENCHMARK_AGENTCARD_CARDHOLDER_ID must be set together ' +
        '(a custom organization with the default cardholder funds the wrong wallet).'
    );
  }
}

function requireStripeTestKey(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key.trim()) {
    throw new Error('STRIPE_SECRET_KEY is required to seed benchmark payment billing');
  }
  if (!key.startsWith('sk_test_') && process.env.BENCHMARK_ALLOW_LIVE_STRIPE !== 'true') {
    throw new Error(
      'Refusing to seed benchmark payment billing with a non-test Stripe key. ' +
        'Use sk_test_* or set BENCHMARK_ALLOW_LIVE_STRIPE=true intentionally.'
    );
  }
  return key;
}

/**
 * `offWaitlistAt` keeps the fixture user past the invite gate. Without it the benchmark's FE link
 * (`?agent-id=…`) renders the "You're On The Waitlist!" overlay on top of the run, which makes
 * every human verification of a benchmark agent look broken.
 */
async function upsertBenchmarkUser(prisma: PrismaClient, userId: string): Promise<void> {
  const onboarded = {
    isAnonymous: false,
    name: 'Rose Labs Benchmark Payer',
    offWaitlistAt: new Date(),
    onboardingCompletedAt: new Date(),
  };
  await prisma.user.upsert({
    where: { userId },
    update: onboarded,
    create: { userId, ...onboarded },
  });
}

/** Point the fixture user's billing at `stripeCustomerId`; `issueCard.ts` 402s without one. */
async function upsertBenchmarkSubscription(
  prisma: PrismaClient,
  userId: string,
  stripeCustomerId: string,
  stripeLivemode = false
): Promise<void> {
  const period = {
    stripeLivemode,
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
  await prisma.subscription.upsert({
    where: { userId },
    update: { subscriptionTier: 1, stripeCustomerId, ...period },
    create: {
      userId,
      subscriptionTier: 1,
      stripeCustomerId,
      stripeSubscriptionId: `benchmark_${randomUUID()}`,
      ...period,
    },
  });
}

/** Test-mode customer + attached `tok_visa`, recreated per seed so the fixture is disposable. */
async function createSandboxBillingCustomer(stripe: Stripe, userId: string): Promise<string> {
  const email = `benchmark-payment-${Date.now()}@example.test`;
  const customer = await stripe.customers.create({
    name: 'Rose Labs Benchmark User',
    email,
    metadata: { userId, fixture: 'agent-payment-test-shop' },
  });
  const paymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
    billing_details: { name: 'Rose Labs Benchmark User', email },
  });
  await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });
  return customer.id;
}

/**
 * Reuse the fixture user's existing live customer, creating one only the first time. Never create
 * a fresh customer on re-seed: the live card on file is attached by hand (below), so churning the
 * customer would silently drop the card and 402 the next production probe.
 */
async function ensureLiveBillingCustomer(
  stripe: Stripe,
  prisma: PrismaClient,
  userId: string
): Promise<string> {
  const existingId = (await prisma.subscription.findUnique({ where: { userId } }))
    ?.stripeCustomerId;
  if (existingId !== undefined && existingId !== null && existingId.trim() !== '') {
    try {
      const existing = await stripe.customers.retrieve(existingId);
      if (existing.deleted !== true) return existing.id;
      console.log('Stored live Stripe customer was deleted; provisioning a replacement');
    } catch (error) {
      if (!isStripeResourceMissing(error)) throw error;
      console.log('Stored Stripe customer does not exist in live mode; provisioning a replacement');
    }
  }
  const customer = await stripe.customers.create({
    name: 'Rose Labs Production Benchmark Payer',
    metadata: { userId, fixture: 'agent-payment-production-lifecycle' },
  });
  console.log(`Created live Stripe customer ${customer.id} for ${userId}`);
  return customer.id;
}

/**
 * A live card cannot be attached from a script — Stripe only accepts raw card data from
 * Stripe.js/Elements — so hand the operator a hosted setup Checkout and stop. Re-running after the
 * card is saved finds it here and completes provisioning.
 */
async function ensureLiveDefaultPaymentMethod(stripe: Stripe, customerId: string): Promise<string> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted === true) throw new Error(`Live Stripe customer ${customerId} was deleted`);
  const configured = customer.invoice_settings?.default_payment_method;
  const configuredId = typeof configured === 'string' ? configured : (configured?.id ?? '');
  if (configuredId !== '') return configuredId;

  const attached = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  const candidate = attached.data[0];
  if (candidate !== undefined) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: candidate.id },
    });
    console.log(`Set ${candidate.id} as the default payment method for ${customerId}`);
    return candidate.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    payment_method_types: ['card'],
    success_url: LIVE_CARD_SETUP_RETURN_URL,
    cancel_url: LIVE_CARD_SETUP_RETURN_URL,
  });
  throw new Error(
    `Live Stripe customer ${customerId} has no card on file. Open this one-time hosted setup ` +
      `Checkout and save a Rose Labs company card, then re-run this command:\n  ${session.url}`
  );
}

async function seedSandboxFixture(prisma: PrismaClient, userId: string): Promise<void> {
  assertSandboxDatabaseIsLocal();
  const stripe = new Stripe(requireStripeTestKey(), { apiVersion: STRIPE_API_VERSION });
  await upsertBenchmarkUser(prisma, userId);
  await ensureBenchmarkCredits(prisma, userId);
  await upsertBenchmarkSubscription(
    prisma,
    userId,
    await createSandboxBillingCustomer(stripe, userId)
  );
  await prisma.purchaseSpend.deleteMany({
    where: { userId, merchant: 'Rose Labs Test Payment' },
  });

  // Verify cardholder against list_cardholders so a stale BENCHMARK_* override cannot seed
  // Integration with an id the org MCP will reject as "Cardholder not found". A funded pool still
  // cannot mint if the cardholder itself is not KYC-ready, and that failure only surfaces
  // mid-benchmark as a mint error, so assert both here. The org identity now travels in the
  // client-credential token itself (AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET).
  const { cardholderId, sandboxFloat, cardholderVerificationStatus } =
    await verifyBenchmarkOrgFixture();
  await seedAgentCardConnection(prisma, userId, cardholderId);
  console.log(
    `AgentCard sandbox pool ready at $${(sandboxFloat.availableCents / 100).toFixed(2)} available ` +
      `($${(sandboxFloat.balanceCents / 100).toFixed(2)} balance)`
  );
  console.log(
    `AgentCard benchmark cardholder ${cardholderId} is KYC-ready (${cardholderVerificationStatus})`
  );

  console.log(
    `Seeded Stripe, Rose credit, and AgentCard payment fixtures for benchmark user ${userId}`
  );
}

/**
 * One-time (idempotent) provisioning of the PRODUCTION payment-lifecycle identity. It creates no
 * money movement of its own: the live probes charge and refund $1 against the card saved here.
 * Existing production purchase rows are deliberately left alone — unlike the disposable sandbox
 * fixture, they are real ledger history.
 */
async function provisionLiveFixture(
  prisma: PrismaClient,
  userId: string,
  selectedCustomerId?: string
): Promise<void> {
  const stripe = new Stripe(requireStripeLiveKey(), { apiVersion: STRIPE_API_VERSION });
  const selectedCustomer =
    selectedCustomerId === undefined
      ? undefined
      : await requireOwnedLiveFixtureCustomer(stripe, selectedCustomerId, userId);
  const cardholderId = requireLiveCardholderId();
  // This call uses the production org credential flow. A sandbox-only or foreign id cannot
  // resolve to a terminal KYC state here, so validate it before touching any shared DB row.
  const cardholderStatus = await getOrgCardholderVerificationStatus(cardholderId);
  assertLiveCardholderReady(cardholderStatus);
  // KYC proves the cardholder resolves; the company wallet proves WHICH mode resolved it. Checked
  // before the first production write so sandbox credentials can never seed the live fixture.
  const orgWallet = await requireLiveOrgWallet();
  console.log(
    `AgentCard org wallet confirmed LIVE at $${(orgWallet.availableCents / 100).toFixed(2)} ` +
      `available ($${(orgWallet.balanceCents / 100).toFixed(2)} balance)`
  );
  await upsertBenchmarkUser(prisma, userId);
  await ensureBenchmarkCredits(prisma, userId);
  const customerId = selectedCustomer ?? (await ensureLiveBillingCustomer(stripe, prisma, userId));
  // Persist the customer before asking for a card. The first cardless run intentionally throws a
  // hosted setup URL; saving first makes the next run reuse the customer that URL attached to.
  await upsertBenchmarkSubscription(prisma, userId, customerId, true);
  const paymentMethodId = await ensureLiveDefaultPaymentMethod(stripe, customerId);
  await seedAgentCardConnection(prisma, userId, cardholderId);
  console.log(
    `Provisioned the production payment-lifecycle identity ${userId}: live customer ${customerId} ` +
      `(default payment method ${paymentMethodId}), AgentCard cardholder ${cardholderId}`
  );
}

export { configureLiveFixtureEnvironment } from './setup-benchmark-payment-guards';

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`Usage: setup-benchmark-payment.ts [--live] [--user-id ID]
  [--stripe-customer-id OWNED_LIVE_CUSTOMER] [--agentcard-cardholder-id DEDICATED_ID]
--live uses the complete AGENTCARD_ORG_OAUTH_*_LIVE pair when supplied,
otherwise the generic production pair. Incomplete LIVE pairs are rejected.
The cardholder must already exist, be dedicated to this fixture, and pass KYC;
no cardholder is created or selected automatically. Ownership and live-wallet
checks remain mandatory. Existing purchase history is preserved.
--help performs no database or provider calls.\n`);
    return;
  }
  const mode: FixtureMode = process.argv.includes('--live') ? 'live' : 'sandbox';
  const selectedCustomerId = argValue('--stripe-customer-id');
  if (process.argv.includes('--stripe-customer-id') && selectedCustomerId === undefined) {
    throw new Error('--stripe-customer-id requires a customer ID');
  }
  if (mode === 'sandbox' && selectedCustomerId !== undefined) {
    throw new Error('--stripe-customer-id requires --live');
  }
  const selectedCardholderId = argValue('--agentcard-cardholder-id');
  if (process.argv.includes('--agentcard-cardholder-id') && selectedCardholderId === undefined) {
    throw new Error('--agentcard-cardholder-id requires a dedicated cardholder ID');
  }
  if (mode === 'sandbox' && selectedCardholderId !== undefined) {
    throw new Error('--agentcard-cardholder-id requires --live');
  }
  if (mode === 'live') configureLiveFixtureEnvironment(selectedCardholderId);
  if (mode === 'sandbox') assertBenchmarkOrgCardholderPair();
  const defaultUserId =
    mode === 'live' ? BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID : DEFAULT_BENCHMARK_USER_ID;
  const userId = resolveBenchmarkUserId([
    argValue('--user-id'),
    process.env.BENCHMARK_USER_ID,
    defaultUserId,
  ]);
  assertDedicatedBenchmarkUser(userId, mode);
  assertUserMatchesMode(userId, mode);
  assertNonAdminBenchmarkUser(userId, mode);
  const prisma = new PrismaClient();
  try {
    if (mode === 'live') {
      await provisionLiveFixture(prisma, userId, selectedCustomerId);
      return;
    }
    await seedSandboxFixture(prisma, userId);
  } finally {
    await prisma.$disconnect();
  }
}

// Guarded so the exported guards above can be unit-tested by importing this module without the
// import itself connecting to Postgres and seeding a fixture (same pattern as
// scripts/cleanup-stale-workspaces.ts).
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
