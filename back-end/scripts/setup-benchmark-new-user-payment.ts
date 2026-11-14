/** Attach a verified sandbox v2 user; subscription and payment method still come from Checkout. */
import { loadDotenvWithCallerOverrides } from '../src/providers/loadDotenvWithCallerOverrides';
import { nonLocalDatabaseReason } from '../src/utils/localDatabaseUrl';

loadDotenvWithCallerOverrides();

async function main(): Promise<void> {
  const userId = (process.env.BENCHMARK_USER_ID ?? '').trim();
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  if (userId === '' || stripeKey !== stripeKey.trim() || !stripeKey.startsWith('sk_test_')) {
    throw new Error('New-user payment fixture requires BENCHMARK_USER_ID and Stripe test mode');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('New-user payment fixture requires a local non-production isolated database');
  }
  for (const databaseUrl of [
    process.env.DATABASE_URL,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  ]) {
    if (nonLocalDatabaseReason(databaseUrl) !== null) {
      throw new Error('New-user payment fixture requires local DATABASE_URL and DIRECT_URL');
    }
  }
  const providerUserId = (process.env.BENCHMARK_AGENTCARD_V2_USER_ID ?? '').trim();
  if (!/^usr_[A-Za-z0-9_-]+$/.test(providerUserId)) {
    throw new Error(
      'BENCHMARK_AGENTCARD_V2_USER_ID must be an explicitly configured connected sandbox user.id (usr_...), never a legacy cardholderId. Complete the normal signed connection first.'
    );
  }
  const { prisma } = await import('../src/providers/database');
  try {
    const subscription = await prisma.subscription.findUnique({ where: { userId } });
    if (subscription !== null) {
      throw new Error('New-user payment fixture must begin without a subscription');
    }
    const { validateV2SandboxFixtureUser } =
      await import('../src/providers/agentcard/v2-onboarding');
    await validateV2SandboxFixtureUser(providerUserId);
    const { saveV2ConnectedUserId } = await import('../src/providers/agentcard/store');
    // The shared writer preserves prior client-scoped bindings and enforces exclusive ownership.
    await saveV2ConnectedUserId(userId, providerUserId);
    console.log(
      JSON.stringify({ user_id: userId, subscription: null, agentcard_v2_user_id: providerUserId })
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
