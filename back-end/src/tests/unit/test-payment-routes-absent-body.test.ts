#!/usr/bin/env tsx
/**
 * Regression: every /api/test-payment POST must answer with its OWN validation error when
 * `req.body` was never populated, instead of crashing into Express' default error page or an
 * opaque 500.
 *
 * WHY THIS IS A REAL INVARIANT AND NOT JUST DEFENSIVE PADDING
 *   Today `server.ts` mounts a global `express.json()` in front of this router, and body-parser
 *   1.x (Express 4) runs `req.body = req.body || {}` BEFORE its Content-Type check — so an absent
 *   or `text/plain` body still arrives as `{}` and the handlers survive. body-parser 2.x (Express
 *   5) DELETED that default: `req.body` stays `undefined` for any request the parser skips. Two
 *   handlers relied on the Express-4 default — `req.body.agentId` on /lifecycle/abandon (read
 *   OUTSIDE the try, so its TypeError escaped `respondTestPaymentError` entirely) and
 *   `confirmTestPayment(req.body)` on /confirm (inside the try, so it collapsed into a generic
 *   500) — and would begin 500ing on an Express upgrade or on any future mount that skips the
 *   parser.
 *
 *   So the router is mounted here with NO body parser: that reproduces exactly the `req.body ===
 *   undefined` state, and pins the handlers' independence from parser wiring.
 *
 * Runs in-process on an ephemeral port; both assertions short-circuit inside the domain's own
 * validation, before Prisma, Stripe or AgentCard are reached.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

const ABSENT_BODY_CASES = [
  { path: '/api/test-payment/lifecycle/abandon', error: 'agentId is required' },
  { path: '/api/test-payment/confirm', error: 'items are required' },
] as const;

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  // Set before the domain's config module loads: TEST_PAYMENT_ENABLED and isProductionEnv() are
  // both read off NODE_ENV at import time, and a production reading would gate these routes behind
  // JWT auth instead of exercising the body handling under test.
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_TEST_PAYMENT = 'true';
  const { default: testPaymentRouter } = await import('../../domains/test-payment/routes');

  const app = express();
  // Deliberately NO express.json(): `req.body` is undefined, the state body-parser 2.x leaves for
  // every request it does not parse.
  app.use('/api/test-payment', testPaymentRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    for (const testCase of ABSENT_BODY_CASES) {
      const response = await fetch(`http://127.0.0.1:${port}${testCase.path}`, { method: 'POST' });
      const raw = await response.text();
      assert.equal(
        response.status,
        400,
        `${testCase.path} must answer 400 for an absent body, got ${response.status}: ${raw}`
      );
      assert.deepEqual(JSON.parse(raw), { error: testCase.error });
    }
  } finally {
    await closeServer(server);
  }

  process.stdout.write('PASS test-payment routes reject an absent request body with a 400\n');
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
