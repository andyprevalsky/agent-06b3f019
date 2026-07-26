#!/usr/bin/env tsx
/**
 * Black-box tests for the admin purchase bypass (part 7).
 *
 * Admins (ADMIN_USER_IDS) bypass the subscription / card-on-file requirement: the card is minted
 * from the AgentCard company transfer with NO personal Stripe hold (Rose fronts the cost). A
 * non-admin without a Stripe billing customer still fails with a 402.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import * as purchasesService from '../../domains/purchases/service';
import {
  assert,
  FakeCardProvider,
  FakeWalletFundingProvider,
  withFakeStripe,
} from './purchases.testkit';

config();

const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

const ADMIN_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30'; // Andy Prevalsky — ADMIN_USER_IDS

function validMintBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: `fp-${randomUUID()}`,
    merchant: 'Test Merchant',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [{ label: 'Tax', amountCents: 80 }],
    subtotalCents: 1000,
    totalCents: 1080,
    ...overrides,
  };
}

async function adminMintIssuesCompanyCardWithoutCharge(): Promise<void> {
  await prisma.user.upsert({
    where: { userId: ADMIN_USER_ID },
    update: {},
    create: { userId: ADMIN_USER_ID, isAnonymous: true },
  });
  const fingerprint = `admin-nocharge-${RUN_ID}-${randomUUID()}`;
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  try {
    await withFakeStripe(async (calls) => {
      const result = await purchasesService.mintPurchaseCard(
        validMintBody({ userId: ADMIN_USER_ID, fingerprint, totalCents: 1000 }) as never,
        provider,
        walletFundingProvider
      );
      assert(result.cardId === provider.cardId, 'admin mint should issue the company card');
      assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);
      assert(provider.mintCalls === 1, `expected one company-flow mint, got ${provider.mintCalls}`);
      assert(
        provider.mintRequests[0]?.fundsSource === 'company_flow',
        'admin card should still request AgentCard company_flow funding'
      );
      assert(
        calls.charges.length === 0,
        `admin mint must not authorize a Stripe hold, got ${calls.charges.length}`
      );
      assert(
        calls.captures.length === 0,
        `admin mint must not capture a Stripe charge, got ${calls.captures.length}`
      );
      const row = await prisma.purchaseSpend.findFirst({
        where: { userId: ADMIN_USER_ID, fingerprint },
        orderBy: { createdAt: 'desc' },
      });
      assert(row?.status === PurchaseSpendStatus.HELD, `expected HELD row, got ${row?.status}`);
      assert(row?.cardId === provider.cardId, 'admin purchase should store the card id');
      assert(
        row?.stripePaymentIntentId === null,
        'admin (Rose-funded) purchase should carry no Stripe payment intent'
      );
    });
  } finally {
    // Andy is a real synced user — never delete him; drop only this test's purchase rows
    // (PurchaseWalletFunding cascades on the PurchaseSpend FK).
    await prisma.purchaseSpend.deleteMany({ where: { userId: ADMIN_USER_ID, fingerprint } });
  }
  console.log('PASS admin mint issues a company-funded card with no Stripe charge');
}

async function nonAdminWithoutCustomerFails402(): Promise<void> {
  const userId = `purchase7-${RUN_ID}-non-admin-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const fingerprint = `non-admin-402-${randomUUID()}`;
  const provider = new FakeCardProvider();
  try {
    await withFakeStripe(async (calls) => {
      let caught: unknown;
      try {
        await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider
        );
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof purchasesService.PurchaseError, 'expected PurchaseError');
      const purchaseError = caught as purchasesService.PurchaseError;
      assert(purchaseError.statusCode === 402, `expected 402, got ${purchaseError.statusCode}`);
      assert(provider.mintCalls === 0, 'non-admin without a customer must never mint a card');
      assert(calls.charges.length === 0, 'non-admin 402 must not touch Stripe');
      const row = await prisma.purchaseSpend.findFirst({
        where: { userId, fingerprint },
        orderBy: { createdAt: 'desc' },
      });
      assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
    });
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
  console.log('PASS non-admin without a Stripe customer still fails 402');
}

async function main(): Promise<void> {
  try {
    await adminMintIssuesCompanyCardWithoutCharge();
    await nonAdminWithoutCustomerFails402();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
