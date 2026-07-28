import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import {
  BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID,
  BENCHMARK_PAYMENT_LIFECYCLE_USER_ID,
} from '../src/domains/purchases/config';
import { isAdminUser } from '../src/utils/adminAccess';
import { ensureAgentCardSandboxFloat } from '../src/providers/agentcard/benchmark-float';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
/**
 * `sandbox` seeds the local isolated stack (test-mode Stripe + the AgentCard sandbox cardholder)
 * for the four `agent-payment-*` lifecycle benchmarks. `live` (--live) provisions the PRODUCTION
 * identity used by the two `agent-payment-production-*` probes: live-mode Stripe + the live
 * org cardholder. The two must never share a user id — see BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID.
 */
type FixtureMode = 'sandbox' | 'live';
/**
 * A NON-ADMIN synthetic user. Admins are routed to `issueAdminCompanyCard` (company-funded, no
 * Stripe hold), which makes the lifecycle benchmarks' `stripeHold` assertions unreachable.
 */
const DEFAULT_BENCHMARK_USER_ID = BENCHMARK_PAYMENT_LIFECYCLE_USER_ID;
const DEFAULT_SANDBOX_CARDHOLDER_ID = 'cmrfpz6d1000bl804w1gggfto';
/** Where Stripe returns the operator after the one-time live card-on-file setup. */
const LIVE_CARD_SETUP_RETURN_URL = 'https://roselabs.ai/?benchmark-payment-card-saved=1';
/**
 * Non-admin benchmark users are subject to the normal credit gate (`unlimited` is admin-only), so
 * a depleted fixture user would stall every agent at OUT_OF_CREDITS. Top the balance up to this
 * much headroom above recorded usage instead of deleting ledger rows.
 */
const BENCHMARK_CREDIT_HEADROOM_CENTS = 100_000;

function resolveSandboxCardholderId(): string {
  return process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID?.trim() || DEFAULT_SANDBOX_CARDHOLDER_ID;
}

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
  const config = { orgManaged: true, cardholderId };
  await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'agentcard' } },
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
 * eventually be gated at OUT_OF_CREDITS. Add only the deficit, so repeated seeding is idempotent.
 */
async function ensureBenchmarkCredits(prisma: PrismaClient, userId: string): Promise<void> {
  const now = new Date();
  const [creditTotal, usageTotal] = await Promise.all([
    prisma.credit.aggregate({
      where: { userId, OR: [{ expirationDate: null }, { expirationDate: { gt: now } }] },
      _sum: { amountCents: true },
    }),
    prisma.toolUsage.aggregate({ where: { userId }, _sum: { totalCostCents: true } }),
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
  await prisma.credit.create({ data: { userId, amountCents: deficitCents, expirationDate: null } });
  console.log(
    `Topped up benchmark credits for ${userId} by $${(deficitCents / 100).toFixed(2)} ` +
      `(used $${(usedCents / 100).toFixed(2)})`
  );
}

/**
 * The lifecycle benchmarks assert a personal Stripe hold, which only the non-admin funding path
 * produces. Seeding an admin here would silently re-route every benchmark purchase to
 * `issueAdminCompanyCard` and make those assertions unsatisfiable, so fail loudly instead.
 */
function assertNonAdminBenchmarkUser(userId: string): void {
  if (!isAdminUser(userId)) return;
  throw new Error(
    `Refusing to seed the payment-lifecycle fixture for admin user ${userId}: admins mint ` +
      'company-funded cards with no Stripe hold, so the lifecycle benchmarks can never pass. ' +
      `Use the dedicated non-admin benchmark user (${BENCHMARK_PAYMENT_LIFECYCLE_USER_ID}).`
  );
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
 * The production probes charge and refund REAL money, so their fixture must be provisioned with
 * the live key. A test-mode key would silently create a test customer whose id production's live
 * Stripe account cannot resolve, and every mint would fail with an opaque `No such customer`.
 */
function requireStripeLiveKey(): string {
  const key = (process.env.STRIPE_SECRET_KEY ?? '').trim();
  if (key === '') {
    throw new Error('STRIPE_SECRET_KEY is required to provision the production payment fixture');
  }
  if (!key.startsWith('sk_live_')) {
    throw new Error(
      '--live provisions the PRODUCTION payment-lifecycle identity and needs the live Stripe key ' +
        `(sk_live_*), got "${key.slice(0, 8)}…". Run it with production's STRIPE_SECRET_KEY.`
    );
  }
  return key;
}

function databaseHost(): string {
  const raw = (process.env.DATABASE_URL ?? '').trim();
  if (raw === '') throw new Error('DATABASE_URL is required to seed benchmark payment fixtures');
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error('DATABASE_URL is not a parseable connection URL');
  }
}

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

/**
 * The sandbox fixture writes a TEST-mode Stripe customer and the AgentCard SANDBOX cardholder.
 * `back-end/.env` points `DATABASE_URL` at the production database, so a bare invocation from
 * `back-end/` would seed those sandbox pointers into production and break the live probes. Every
 * sanctioned caller (benchmarks/local.py, scripts/run-agentcard-lifecycle-task.sh) passes an
 * explicit localhost URL for the isolated stack, so requiring one here costs nothing.
 */
function assertSandboxDatabaseIsLocal(): void {
  const host = databaseHost();
  if (LOCAL_DATABASE_HOSTS.has(host)) return;
  if (process.env.BENCHMARK_PAYMENT_ALLOW_REMOTE_DB === 'true') return;
  throw new Error(
    `Refusing to seed the sandbox payment fixture into non-local database host "${host}": it ` +
      'writes a test-mode Stripe customer and the AgentCard sandbox cardholder, which would ' +
      'clobber the live production fixture. Point DATABASE_URL at the isolated benchmark ' +
      'database, use --live for the production identity, or set ' +
      'BENCHMARK_PAYMENT_ALLOW_REMOTE_DB=true if this really is intended.'
  );
}

/**
 * The live probes must mint against the org's real KYC-verified cardholder — the same one
 * production already configures. There is deliberately no default: silently falling back to the
 * sandbox cardholder would make every production transfer report `livemode=false`.
 */
function requireLiveCardholderId(): string {
  const cardholderId = (
    process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID ??
    process.env.AGENTCARD_CARDHOLDER_ID ??
    ''
  ).trim();
  if (cardholderId === '') {
    throw new Error(
      '--live needs the live AgentCard cardholder id. Set BENCHMARK_AGENTCARD_CARDHOLDER_ID ' +
        "(or AGENTCARD_CARDHOLDER_ID) to production's value."
    );
  }
  return cardholderId;
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
  stripeCustomerId: string
): Promise<void> {
  const period = { currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) };
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
    const existing = await stripe.customers.retrieve(existingId);
    if (existing.deleted !== true) return existing.id;
    console.log(`Live Stripe customer ${existingId} was deleted; provisioning a replacement`);
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
  await seedAgentCardConnection(prisma, userId, resolveSandboxCardholderId());

  // The org identity now travels in the client-credential token itself
  // (AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET), so no explicit orgId is needed.
  const sandboxFloat = await ensureAgentCardSandboxFloat();
  console.log(
    `AgentCard sandbox pool ready at $${(sandboxFloat.availableCents / 100).toFixed(2)} available ` +
      `($${(sandboxFloat.balanceCents / 100).toFixed(2)} balance)`
  );
  console.log(`Seeded Stripe and AgentCard payment fixtures for benchmark user ${userId}`);
}

/**
 * One-time (idempotent) provisioning of the PRODUCTION payment-lifecycle identity. It creates no
 * money movement of its own: the live probes charge and refund $1 against the card saved here.
 * Existing production purchase rows are deliberately left alone — unlike the disposable sandbox
 * fixture, they are real ledger history.
 */
async function provisionLiveFixture(prisma: PrismaClient, userId: string): Promise<void> {
  const stripe = new Stripe(requireStripeLiveKey(), { apiVersion: STRIPE_API_VERSION });
  const cardholderId = requireLiveCardholderId();
  await upsertBenchmarkUser(prisma, userId);
  await ensureBenchmarkCredits(prisma, userId);
  const customerId = await ensureLiveBillingCustomer(stripe, prisma, userId);
  const paymentMethodId = await ensureLiveDefaultPaymentMethod(stripe, customerId);
  await upsertBenchmarkSubscription(prisma, userId, customerId);
  await seedAgentCardConnection(prisma, userId, cardholderId);
  console.log(
    `Provisioned the production payment-lifecycle identity ${userId}: live customer ${customerId} ` +
      `(default payment method ${paymentMethodId}), AgentCard cardholder ${cardholderId}`
  );
}

async function main(): Promise<void> {
  const mode: FixtureMode = process.argv.includes('--live') ? 'live' : 'sandbox';
  if (mode === 'sandbox') assertBenchmarkOrgCardholderPair();
  const defaultUserId =
    mode === 'live' ? BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID : DEFAULT_BENCHMARK_USER_ID;
  const userId = argValue('--user-id') ?? process.env.BENCHMARK_USER_ID ?? defaultUserId;
  assertNonAdminBenchmarkUser(userId);
  const prisma = new PrismaClient();
  try {
    if (mode === 'live') {
      await provisionLiveFixture(prisma, userId);
      return;
    }
    await seedSandboxFixture(prisma, userId);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
