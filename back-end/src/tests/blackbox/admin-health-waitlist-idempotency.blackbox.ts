#!/usr/bin/env tsx
/** Black-box regressions for waitlist finalization and pre-send email failures. */

import { config } from 'dotenv';
import assert from 'node:assert/strict';

import {
  inviteWaitlistPerson,
  waitlistInviteFinalOperationKey,
  type WaitlistInviteDependencies,
} from '../../domains/admin-health/service.waitlist';
import { prisma } from '../../providers/database';
import {
  sendTransactionalEmail,
  TransactionalEmailDefinitiveError,
} from '../../providers/transactionalEmail';
import { sendSms } from '../../providers/smsQueue';

config();

async function testStartedFinalOutcomeResumesSafely() {
  const marker = `blackbox-started-final-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const idempotencyKey = `${marker}-attempt`;
  const waitlist = await prisma.waitlist.create({
    data: { name: marker, phone: `+1999${String(Date.now()).slice(-7)}001` },
  });
  const invitedAt = '2026-07-18T20:04:00.000Z';
  const storedResult = {
    id: waitlist.id,
    invitedAt,
    smsSent: true,
    emailSent: true,
    flagged: true,
    alreadyOffWaitlist: false,
    hasAccount: true,
  };
  const operationKey = waitlistInviteFinalOperationKey(waitlist.id, idempotencyKey);
  await prisma.toolSideEffect.create({
    data: {
      operationKey,
      operationType: 'admin-health.waitlist-invite',
      status: 'STARTED',
      request: storedResult,
    },
  });
  const dependencies: WaitlistInviteDependencies = {
    isProduction: false,
    now: () => new Date('2030-01-01T00:00:00.000Z'),
    sendSms: async () => {
      throw new Error('Final replay must not repeat SMS');
    },
    sendEmail: async () => {
      throw new Error('Final replay must not repeat email');
    },
  };

  try {
    const result = await inviteWaitlistPerson(waitlist.id, dependencies, idempotencyKey);
    const row = await prisma.waitlist.findUniqueOrThrow({ where: { id: waitlist.id } });
    const sideEffect = await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } });
    assert.deepStrictEqual(result, storedResult, 'Started final replay changed its result');
    if (row.invitedAt?.toISOString() !== invitedAt || sideEffect.status !== 'SUCCEEDED') {
      throw new Error('Started final replay did not persist its timestamp and success record');
    }
  } finally {
    await prisma.toolSideEffect.deleteMany({ where: { operationKey } });
    await prisma.waitlist.deleteMany({ where: { id: waitlist.id } });
  }
}

async function testFailedGateRecordIsReclaimedNotStuck409() {
  // A gate whose outcome-write failed leaves a FAILED side-effect record. The
  // old code returned WaitlistInviteInProgressError (409) forever for any
  // non-SUCCEEDED record; the fix reclaims FAILED and re-runs the idempotent
  // mutation so the operation stays retryable.
  const { resolveInviteGate, waitlistInviteGateOperationKey } =
    await import('../../domains/admin-health/service.waitlist-gate');
  const marker = `blackbox-gate-reclaim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = `+1999${String(Date.now()).slice(-7)}002`;
  const idempotencyKey = `${marker}-attempt`;
  const waitlistId = marker;
  const user = await prisma.user.create({
    data: { userId: marker, phone, offWaitlistAt: null },
  });
  const operationKey = waitlistInviteGateOperationKey(waitlistId, idempotencyKey);
  await prisma.toolSideEffect.create({
    data: {
      operationKey,
      operationType: 'admin-health.waitlist-invite',
      status: 'FAILED',
      request: { waitlistId, phone },
      error: 'prior outcome-write failure',
    },
  });
  try {
    const result = await resolveInviteGate({ id: waitlistId, idempotencyKey, phone });
    const sideEffect = await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } });
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { userId: marker } });
    assert.equal(result.flagged, true, 'Reclaimed gate did not re-run the mutation');
    assert.equal(result.userId, marker, 'Reclaimed gate returned the wrong account');
    assert.equal(sideEffect.status, 'SUCCEEDED', 'Reclaimed gate did not persist success');
    assert.notEqual(
      refreshed.offWaitlistAt,
      null,
      'Reclaimed gate did not flag the user off waitlist'
    );
  } finally {
    await prisma.toolSideEffect.deleteMany({ where: { operationKey } });
    await prisma.user.deleteMany({ where: { userId: user.userId } });
  }
}

async function testTokenAcquisitionFailureIsDefinitive() {
  const marker = `blackbox-email-token-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sender = `${marker}@example.com`;
  const integration = await prisma.integration.create({
    data: {
      userId: marker,
      name: marker,
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  await prisma.emailIntegrationCredential.create({
    data: {
      userId: marker,
      integrationId: integration.id,
      provider: 'GMAIL',
      email: sender,
      refreshToken: 'refresh-token',
    },
  });
  let fetchCalls = 0;
  try {
    await sendTransactionalEmail(
      {
        ownerUserId: marker,
        from: sender,
        fromName: 'Rose',
        to: 'recipient@example.com',
        subject: 'Pre-send failure',
        body: 'Test body',
      },
      {
        getAccessToken: async () => {
          throw new Error('refresh rejected');
        },
        fetch: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ id: 'must-not-send' }), { status: 200 });
        },
        requestTimeoutMs: 100,
      }
    );
    throw new Error('Expected token acquisition to fail');
  } catch (error) {
    if (!(error instanceof TransactionalEmailDefinitiveError)) throw error;
    if (!error.message.includes('refresh rejected')) throw error;
    if (fetchCalls !== 0) throw new Error('Gmail fetch ran after token acquisition failed');
  } finally {
    await prisma.integration.deleteMany({ where: { id: integration.id } });
  }
}

async function testCredentialLookupFailureIsDefinitive() {
  let fetchCalls = 0;
  try {
    await sendTransactionalEmail(
      {
        ownerUserId: 'lookup-failure-owner',
        from: 'sender@example.com',
        fromName: 'Rose',
        to: 'recipient@example.com',
        subject: 'Lookup failure',
        body: 'Test body',
      },
      {
        findCredential: async () => {
          throw new Error('credential lookup timeout');
        },
        getAccessToken: async () => {
          throw new Error('Token lookup must not run');
        },
        fetch: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ id: 'must-not-send' }), { status: 200 });
        },
        requestTimeoutMs: 100,
      }
    );
    throw new Error('Expected credential lookup to fail');
  } catch (error) {
    if (!(error instanceof TransactionalEmailDefinitiveError)) throw error;
    if (!error.message.includes('credential lookup timeout')) throw error;
    if (fetchCalls !== 0) throw new Error('Gmail fetch ran after credential lookup failed');
  }
}

async function testRejectedSmsBodyFailureRemainsDefinitive() {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SURGE_API_KEY;
  const originalAccountId = process.env.SURGE_ACCOUNT_ID;
  process.env.SURGE_API_KEY = 'test-key';
  process.env.SURGE_ACCOUNT_ID = 'test-account';
  globalThis.fetch = async () =>
    ({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error('body read failed');
      },
    }) as Response;
  try {
    const result = await sendSms('+15555550100', 'test');
    if (result.success || result.definitiveFailure !== true || !result.error?.includes('503')) {
      throw new Error(`Rejected SMS lost definitive status: ${JSON.stringify(result)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SURGE_API_KEY;
    else process.env.SURGE_API_KEY = originalApiKey;
    if (originalAccountId === undefined) delete process.env.SURGE_ACCOUNT_ID;
    else process.env.SURGE_ACCOUNT_ID = originalAccountId;
  }
}

async function run(name: string, fn: () => Promise<void>) {
  const startedAt = Date.now();
  try {
    await fn();
    console.log(`✅ ${name} (${Date.now() - startedAt}ms)`);
    return true;
  } catch (error) {
    console.log(`❌ ${name} (${Date.now() - startedAt}ms)`);
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  const results = [
    await run(
      'STARTED final outcomes resume without repeating delivery',
      testStartedFinalOutcomeResumesSafely
    ),
    await run(
      'FAILED gate records reclaim and re-run instead of 409 forever',
      testFailedGateRecordIsReclaimedNotStuck409
    ),
    await run(
      'token acquisition failures are definitive and pre-send',
      testTokenAcquisitionFailureIsDefinitive
    ),
    await run(
      'credential lookup failures are definitive and pre-send',
      testCredentialLookupFailureIsDefinitive
    ),
    await run(
      'rejected SMS remains definitive when its body cannot be read',
      testRejectedSmsBodyFailureRemainsDefinitive
    ),
  ];
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} waitlist idempotency regressions passed`);
  if (passed !== results.length) process.exitCode = 1;
}

void main();
