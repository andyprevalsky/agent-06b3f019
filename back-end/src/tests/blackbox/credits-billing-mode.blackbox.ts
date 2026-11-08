/** Real credits HTTP contract backed by isolated Prisma fixtures; no payment providers. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { prisma } from '../../providers/database';
import creditsRoutes from '../../domains/credits/routes';

async function main(): Promise<void> {
  const apiKey = process.env.BACKEND_API_KEY;
  assert.ok(apiKey, 'BACKEND_API_KEY is required by the native credits route');
  const userId = `billing-mode-blackbox-${randomUUID()}`;
  const app = express();
  app.use('/api/credits', creditsRoutes);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await prisma.user.create({ data: { userId, isAnonymous: true } });
    for (const mode of [null, false, true, false]) {
      if (mode !== null) {
        const data = {
          subscriptionTier: 30,
          stripeLivemode: mode,
          stripeCustomerId: `cus_fixture_${userId}`,
          stripeSubscriptionId: `sub_fixture_${userId}`,
          currentPeriodEnd: new Date(Date.now() + 86_400_000),
        };
        await prisma.subscription.upsert({
          where: { userId },
          create: { userId, ...data },
          update: data,
        });
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/credits/usage?userId=${userId}`,
        {
          headers: { 'X-API-Key': apiKey },
        }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(
        body.stripeLivemode,
        mode,
        'usage must preserve persisted billing mode, including unknown'
      );
      assert.equal(body.tier, mode === null ? null : 30);
      assert.equal(typeof body.remaining, 'number');
      console.log(`PASS credits usage persisted Stripe mode ${mode}`);
    }
  } finally {
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
