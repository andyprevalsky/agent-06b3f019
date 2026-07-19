#!/usr/bin/env tsx
/** Black-box coverage for retry-safe waitlist delivery and Gmail boundaries. */

import { config } from 'dotenv';
import jwt from 'jsonwebtoken';

import {
  WAITLIST_INVITE_COPY,
  WAITLIST_INVITE_EMAIL_FROM,
  WAITLIST_INVITE_EMAIL_SENDER_USER_ID,
  WAITLIST_INVITE_EMAIL_SUBJECT,
} from '../../domains/admin-health/config';
import {
  inviteWaitlistPerson,
  WaitlistInviteEmailError,
  WaitlistInviteInProgressError,
  WaitlistInviteSmsError,
  waitlistInviteFinalOperationKey,
  type WaitlistInviteDependencies,
} from '../../domains/admin-health/service.waitlist';
import { prisma } from '../../providers/database';
import {
  buildTransactionalRawEmail,
  sendTransactionalEmail,
  TransactionalEmailDefinitiveError,
  TransactionalEmailError,
} from '../../providers/transactionalEmail';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

function uniquePhone(): string {
  return `+1999${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 1000)}`;
}

async function seedPerson(prefix: string) {
  const marker = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = uniquePhone();
  const email = `${marker}@example.com`;
  await prisma.user.create({ data: { userId: marker, phone, email, usedInviteCode: null } });
  const waitlist = await prisma.waitlist.create({ data: { name: marker, phone } });
  return { marker, phone, email, waitlist };
}

async function cleanupPerson(marker: string, idempotencyKey: string) {
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: { contains: idempotencyKey } },
  });
  await prisma.waitlist.deleteMany({ where: { name: marker } });
  await prisma.user.deleteMany({ where: { userId: marker } });
}

async function testDispatchesCanonicalCopy() {
  const seeded = await seedPerson('blackbox-dual-invite');
  const idempotencyKey = `${seeded.marker}-dispatch`;
  const invitedAt = new Date('2026-07-18T20:00:00.000Z');
  const smsCalls: Array<{ to: string; body: string }> = [];
  const emailCalls: Array<{
    ownerUserId: string;
    from: string;
    to: string;
    subject: string;
    body: string;
  }> = [];
  const dependencies: WaitlistInviteDependencies = {
    isProduction: true,
    now: () => invitedAt,
    sendSms: async (to, body) => {
      smsCalls.push({ to, body });
      return { success: true, messageSid: 'sms-test-id' };
    },
    sendEmail: async (input) => {
      emailCalls.push(input);
      return { id: 'email-test-id' };
    },
  };

  try {
    const result = await inviteWaitlistPerson(seeded.waitlist.id, dependencies, idempotencyKey);
    if (!result.smsSent || !result.emailSent || result.invitedAt !== invitedAt.toISOString()) {
      throw new Error(`Expected both channels and deterministic time: ${JSON.stringify(result)}`);
    }
    if (smsCalls.length !== 1 || emailCalls.length !== 1) {
      throw new Error(
        `Expected one send per channel: SMS=${smsCalls.length}, email=${emailCalls.length}`
      );
    }
    if (smsCalls[0].to !== seeded.phone || smsCalls[0].body !== WAITLIST_INVITE_COPY) {
      throw new Error(`Unexpected SMS payload: ${JSON.stringify(smsCalls[0])}`);
    }
    const email = emailCalls[0];
    if (
      email.ownerUserId !== WAITLIST_INVITE_EMAIL_SENDER_USER_ID ||
      email.from !== WAITLIST_INVITE_EMAIL_FROM ||
      email.to !== seeded.email ||
      email.subject !== WAITLIST_INVITE_EMAIL_SUBJECT ||
      email.body !== WAITLIST_INVITE_COPY
    ) {
      throw new Error(`Unexpected email payload: ${JSON.stringify(email)}`);
    }
  } finally {
    await cleanupPerson(seeded.marker, idempotencyKey);
  }
}

async function testRetrySkipsSuccessfulChannel() {
  const seeded = await seedPerson('blackbox-retry-invite');
  const idempotencyKey = `${seeded.marker}-attempt`;
  let smsCalls = 0;
  let emailCalls = 0;
  const dependencies: WaitlistInviteDependencies = {
    isProduction: true,
    now: () => new Date('2026-07-18T20:01:00.000Z'),
    sendSms: async () => {
      smsCalls += 1;
      return { success: true, messageSid: `sms-${smsCalls}` };
    },
    sendEmail: async () => {
      emailCalls += 1;
      if (emailCalls === 1) {
        throw new TransactionalEmailDefinitiveError('definitive provider rejection');
      }
      return { id: `email-${emailCalls}` };
    },
  };

  try {
    try {
      await inviteWaitlistPerson(seeded.waitlist.id, dependencies, idempotencyKey);
      throw new Error('Expected the first email attempt to fail');
    } catch (error) {
      if (!(error instanceof WaitlistInviteEmailError)) throw error;
    }
    const result = await inviteWaitlistPerson(seeded.waitlist.id, dependencies, idempotencyKey);
    if (
      !result.smsSent ||
      !result.emailSent ||
      !result.flagged ||
      result.alreadyOffWaitlist ||
      smsCalls !== 1 ||
      emailCalls !== 2
    ) {
      throw new Error(`Retry duplicated delivery: SMS=${smsCalls}, email=${emailCalls}`);
    }
  } finally {
    await cleanupPerson(seeded.marker, idempotencyKey);
  }
}

async function testAmbiguousFailuresRemainClaimed() {
  const emailSeeded = await seedPerson('blackbox-ambiguous-email');
  const emailKey = `${emailSeeded.marker}-attempt`;
  let emailCalls = 0;
  const emailDependencies: WaitlistInviteDependencies = {
    isProduction: true,
    now: () => new Date('2026-07-18T20:01:30.000Z'),
    sendSms: async () => ({ success: true, messageSid: 'sms-before-email-timeout' }),
    sendEmail: async () => {
      emailCalls += 1;
      throw new TransactionalEmailError('Gmail request timed out');
    },
  };

  try {
    await inviteWaitlistPerson(emailSeeded.waitlist.id, emailDependencies, emailKey).catch(
      (error: unknown) => {
        if (!(error instanceof WaitlistInviteEmailError)) throw error;
      }
    );
    try {
      await inviteWaitlistPerson(emailSeeded.waitlist.id, emailDependencies, emailKey);
      throw new Error('Expected ambiguous email replay to fail closed');
    } catch (error) {
      if (!(error instanceof WaitlistInviteInProgressError)) throw error;
    }
    if (emailCalls !== 1) throw new Error(`Ambiguous email was repeated ${emailCalls} times`);
  } finally {
    await cleanupPerson(emailSeeded.marker, emailKey);
  }

  const smsSeeded = await seedPerson('blackbox-ambiguous-sms');
  const smsKey = `${smsSeeded.marker}-attempt`;
  let smsCalls = 0;
  const smsDependencies: WaitlistInviteDependencies = {
    isProduction: true,
    now: () => new Date('2026-07-18T20:01:31.000Z'),
    sendSms: async () => {
      smsCalls += 1;
      throw new Error('connection reset after request write');
    },
    sendEmail: async () => ({ id: 'must-not-send' }),
  };
  try {
    await inviteWaitlistPerson(smsSeeded.waitlist.id, smsDependencies, smsKey).catch(
      (error: unknown) => {
        if (!(error instanceof WaitlistInviteSmsError)) throw error;
      }
    );
    try {
      await inviteWaitlistPerson(smsSeeded.waitlist.id, smsDependencies, smsKey);
      throw new Error('Expected ambiguous SMS replay to fail closed');
    } catch (error) {
      if (!(error instanceof WaitlistInviteInProgressError)) throw error;
    }
    if (smsCalls !== 1) throw new Error(`Ambiguous SMS was repeated ${smsCalls} times`);
  } finally {
    await cleanupPerson(smsSeeded.marker, smsKey);
  }
}

async function testConcurrentSameKeyHasOneOwner() {
  const seeded = await seedPerson('blackbox-concurrent-invite');
  const idempotencyKey = `${seeded.marker}-attempt`;
  let smsCalls = 0;
  let releaseFirstSms!: () => void;
  let firstSmsStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstSmsStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseFirstSms = resolve;
  });
  const dependencies: WaitlistInviteDependencies = {
    isProduction: true,
    now: () => new Date('2026-07-18T20:02:00.000Z'),
    sendSms: async () => {
      smsCalls += 1;
      if (smsCalls === 1) {
        firstSmsStarted();
        await release;
      }
      return { success: true, messageSid: `sms-${smsCalls}` };
    },
    sendEmail: async () => ({ id: 'email-test-id' }),
  };

  try {
    const first = inviteWaitlistPerson(seeded.waitlist.id, dependencies, idempotencyKey);
    await started;
    const second = inviteWaitlistPerson(seeded.waitlist.id, dependencies, idempotencyKey);
    const secondOutcome = second.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    const outcome = await Promise.race([
      secondOutcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    if (outcome === null)
      throw new Error('Concurrent request did not resolve while owner was held');
    releaseFirstSms();
    await first;
    if (smsCalls !== 1 || outcome.status !== 'rejected') {
      throw new Error(`Expected one delivery owner: ${JSON.stringify(outcome)}`);
    }
    if (!(outcome.reason instanceof WaitlistInviteInProgressError)) {
      throw new Error(`Expected WaitlistInviteInProgressError, got ${String(outcome.reason)}`);
    }
  } finally {
    releaseFirstSms?.();
    await cleanupPerson(seeded.marker, idempotencyKey);
  }
}

async function testMarkRetryReplaysFinalOutcome() {
  const seeded = await seedPerson('blackbox-mark-retry');
  const idempotencyKey = `${seeded.marker}-attempt`;
  let smsCalls = 0;
  let emailCalls = 0;
  let markCalls = 0;
  const invitedAt = new Date('2026-07-18T20:03:00.000Z');
  const dependencies: WaitlistInviteDependencies = {
    isProduction: true,
    now: () => invitedAt,
    sendSms: async () => {
      smsCalls += 1;
      return { success: true, messageSid: 'sms-mark-retry' };
    },
    sendEmail: async () => {
      emailCalls += 1;
      return { id: 'email-mark-retry' };
    },
    markInvited: async (id, value) => {
      markCalls += 1;
      if (markCalls === 1) throw new Error('temporary invitedAt write failure');
      await prisma.waitlist.update({ where: { id }, data: { invitedAt: value } });
    },
  };

  try {
    try {
      await inviteWaitlistPerson(seeded.waitlist.id, dependencies, idempotencyKey);
      throw new Error('Expected invitedAt persistence to fail');
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'temporary invitedAt write failure') {
        throw error;
      }
    }
    const result = await inviteWaitlistPerson(seeded.waitlist.id, dependencies, idempotencyKey);
    const replay = await inviteWaitlistPerson(
      seeded.waitlist.id,
      { ...dependencies, now: () => new Date('2030-01-01T00:00:00.000Z') },
      idempotencyKey
    );
    if (smsCalls !== 1 || emailCalls !== 1 || markCalls !== 2) {
      throw new Error(
        `Mark retry repeated work: SMS=${smsCalls}, email=${emailCalls}, mark=${markCalls}`
      );
    }
    if (result.invitedAt !== invitedAt.toISOString() || replay.invitedAt !== result.invitedAt) {
      throw new Error(
        `Same-key replay changed final outcome: ${JSON.stringify({ result, replay })}`
      );
    }
  } finally {
    await cleanupPerson(seeded.marker, idempotencyKey);
  }
}

async function testRawEmailAndRefreshDeadline() {
  const encoded = buildTransactionalRawEmail({
    from: WAITLIST_INVITE_EMAIL_FROM,
    fromName: 'Rose',
    to: 'invitee@example.com',
    subject: WAITLIST_INVITE_EMAIL_SUBJECT,
    body: WAITLIST_INVITE_COPY,
  });
  const raw = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (
    !raw.includes(`Subject: ${WAITLIST_INVITE_EMAIL_SUBJECT}`) ||
    !raw.endsWith(WAITLIST_INVITE_COPY)
  ) {
    throw new Error(`Raw email omitted canonical invite fields: ${raw}`);
  }

  const marker = `blackbox-transactional-email-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sender = `${marker}@example.com`;
  const integration = await prisma.integration.create({
    data: {
      userId: marker,
      name: `gmail-${marker}`,
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  try {
    await prisma.emailIntegrationCredential.create({
      data: {
        userId: marker,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: sender,
        refreshToken: 'refresh-only-token',
      },
    });
    const input = {
      ownerUserId: marker,
      from: sender,
      fromName: 'Rose',
      to: 'recipient@example.com',
      subject: 'Refresh-only credential',
      body: 'Test body',
    };
    const sent = await sendTransactionalEmail(input, {
      getAccessToken: async () => 'refreshed-access-token',
      fetch: async (_url, init) => {
        if (
          (init?.headers as Record<string, string>).Authorization !==
          'Bearer refreshed-access-token'
        ) {
          throw new Error('Refreshed access token was not used');
        }
        return new Response(JSON.stringify({ id: 'refresh-only-message' }), { status: 200 });
      },
      requestTimeoutMs: 100,
    });
    if (sent.id !== 'refresh-only-message') throw new Error('Refresh-only delivery failed');

    const deadlineFetch = async (_url: string | URL | Request, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
            setTimeout(() => reject(new Error('Response body escaped its deadline')), 50);
          }),
      }) as Response;
    try {
      await sendTransactionalEmail(input, {
        getAccessToken: async () => 'current-access-token',
        fetch: deadlineFetch,
        requestTimeoutMs: 5,
      });
      throw new Error('Expected Gmail response-body timeout');
    } catch (error) {
      if (!(error instanceof TransactionalEmailError) || !error.message.includes('timed out'))
        throw error;
    }
  } finally {
    await prisma.integration.deleteMany({ where: { id: integration.id } });
  }
}

async function testHttpConflictForStartedAttempt() {
  const marker = `blackbox-http-conflict-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const idempotencyKey = `${marker}-attempt`;
  const waitlist = await prisma.waitlist.create({
    data: { name: marker, phone: uniquePhone() },
  });
  const operationKey = waitlistInviteFinalOperationKey(waitlist.id, idempotencyKey);
  await prisma.toolSideEffect.create({
    data: {
      operationKey,
      operationType: 'admin-health.waitlist-invite',
      status: 'STARTED',
    },
  });
  try {
    const secret = process.env.SUPABASE_JWT_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!secret || !supabaseUrl) throw new Error('Supabase auth config is required');
    const token = jwt.sign({ sub: ANDY_USER_ID, phone: '+19729777432' }, secret, {
      algorithm: 'HS256',
      issuer: `${supabaseUrl}/auth/v1`,
      expiresIn: '1h',
    });
    const response = await fetch(`${BASE_URL}/api/admin-health/waitlist/${waitlist.id}/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
    });
    const body = (await response.json()) as { error?: unknown };
    if (response.status !== 409 || typeof body.error !== 'string') {
      throw new Error(
        `Expected HTTP 409 for STARTED attempt, got ${response.status}: ${JSON.stringify(body)}`
      );
    }
  } finally {
    await prisma.toolSideEffect.deleteMany({ where: { operationKey } });
    await prisma.waitlist.deleteMany({ where: { id: waitlist.id } });
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<boolean> {
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
  const results = [];
  results.push(
    await run('invite dispatches canonical SMS and email copy', testDispatchesCanonicalCopy)
  );
  results.push(
    await run('retry skips a channel that already succeeded', testRetrySkipsSuccessfulChannel)
  );
  results.push(
    await run('ambiguous provider failures retain their claims', testAmbiguousFailuresRemainClaimed)
  );
  results.push(
    await run('concurrent same-key requests have one owner', testConcurrentSameKeyHasOneOwner)
  );
  results.push(
    await run(
      'mark retry and same-key replay preserve one final outcome',
      testMarkRetryReplaysFinalOutcome
    )
  );
  results.push(
    await run('transactional email refresh and body deadline', testRawEmailAndRefreshDeadline)
  );
  if (process.env.WAITLIST_DELIVERY_DIRECT_ONLY !== 'true') {
    results.push(
      await run('HTTP maps a STARTED invite attempt to 409', testHttpConflictForStartedAttempt)
    );
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} admin-health waitlist delivery tests passed`);
  if (passed !== results.length) process.exitCode = 1;
}

void main();
