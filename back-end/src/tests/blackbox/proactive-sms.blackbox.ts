#!/usr/bin/env tsx
/** Black-box coverage for scheduled, agent-generated subscriber re-engagement SMS. */

import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

import {
  PROACTIVE_SMS_CRON_EXPRESSION,
  PROACTIVE_SMS_JOB_LEASE_KEY,
  PROACTIVE_SMS_OUTREACH_PROMPT,
  PROACTIVE_SMS_TIME_ZONE,
} from '../../providers/smsSupervisor/proactiveOutreach';
import {
  BASE_URL,
  type CapturedCall,
  assertStatus,
  captureToken,
  capturedSmsBody,
  cleanupAgentScopedUser,
  findSurgeCallForReply,
  provisionUserWithPhone,
  readCapturesForToken,
  request,
  runTest,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';

config();

const prisma = new PrismaClient();
const RUN_AT = new Date('2026-07-12T17:00:00.000Z'); // Sunday, 10am Pacific
const DAY_MS = 24 * 60 * 60 * 1000;

interface JobSummary {
  considered: number;
  eligible: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface LeasedJobResult {
  acquired: boolean;
  summary: JobSummary | null;
}

function completionFixture(message: string, delayMs = 0): string {
  return JSON.stringify({
    reasoning: 'reviewed the person and selected a useful check-in',
    tool_calls: [
      { tool: 'send_user_message', arguments: { message } },
      { tool: 'attempt_completion', arguments: {} },
    ],
    ...(delayMs > 0 ? { delay_ms: delayMs } : {}),
  });
}

async function subscribe(userId: string, currentPeriodEnd: Date): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 20,
      stripeSubscriptionId: `sub-proactive-${suffix}`,
      stripeCustomerId: `cus-proactive-${suffix}`,
      currentPeriodEnd,
    },
  });
}

async function setAgentCreatedAt(agentId: string, createdAt: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Agent"
    SET "createdAt" = ${createdAt}, "updatedAt" = ${createdAt}
    WHERE id = ${agentId}
  `;
}

async function runJob(userIds: string[], token: string): Promise<JobSummary> {
  const response = await request(`${BASE_URL}/api/test/proactive-sms/run`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({ now: RUN_AT.toISOString(), userIds }),
  });
  assertStatus(response.status, 200, response.data);
  return response.data as JobSummary;
}

async function runLeasedJob(userIds: string[], token: string): Promise<LeasedJobResult> {
  const response = await request(`${BASE_URL}/api/test/proactive-sms/run-leased`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({ now: RUN_AT.toISOString(), userIds }),
  });
  assertStatus(response.status, 200, response.data);
  return response.data as LeasedJobResult;
}

function surgeCallsTo(calls: CapturedCall[], phones: Set<string>): CapturedCall[] {
  return calls.filter((call) => {
    if (!call.url.includes('surge.app') || !call.url.endsWith('/messages')) return false;
    const body = capturedSmsBody(call);
    return typeof body?.to === 'string' && phones.has(body.to);
  });
}

function assertPromptSnapshot(): void {
  const expected = `This is a scheduled proactive check-in. Review the person you support using the context and tools available to you, then respond with a concise SMS suggesting something you believe would be genuinely helpful for them right now. Do not mention this scheduled trigger, their subscription, or their inactivity.`;
  if (PROACTIVE_SMS_OUTREACH_PROMPT !== expected) {
    throw new Error(`Proactive prompt snapshot changed:\n${PROACTIVE_SMS_OUTREACH_PROMPT}`);
  }
}

function assertWednesdaySundaySchedule(): void {
  if (PROACTIVE_SMS_CRON_EXPRESSION !== '0 10 * * 0,3') {
    throw new Error(`Unexpected proactive SMS cron: ${PROACTIVE_SMS_CRON_EXPRESSION}`);
  }
  if (PROACTIVE_SMS_TIME_ZONE !== 'America/Los_Angeles') {
    throw new Error(`Unexpected proactive SMS timezone: ${PROACTIVE_SMS_TIME_ZONE}`);
  }
}

async function testEligibilityAgentOutputAndDailyDedupe(): Promise<void> {
  const eligiblePhone = uniqueSmsPhone();
  const childOnlyPhone = uniqueSmsPhone();
  const recentRootPhone = uniqueSmsPhone();
  const unsubscribedPhone = uniqueSmsPhone();
  const expiredPhone = uniqueSmsPhone();
  const eligibleUserId = await provisionUserWithPhone(prisma, eligiblePhone);
  const childOnlyUserId = await provisionUserWithPhone(prisma, childOnlyPhone);
  const recentRootUserId = await provisionUserWithPhone(prisma, recentRootPhone);
  const unsubscribedUserId = await provisionUserWithPhone(prisma, unsubscribedPhone);
  const expiredUserId = await provisionUserWithPhone(prisma, expiredPhone);
  const userIds = [
    eligibleUserId,
    childOnlyUserId,
    recentRootUserId,
    unsubscribedUserId,
    expiredUserId,
  ];
  const eligibleReply = 'Want me to turn your saved travel ideas into a weekend plan?';
  const childOnlyReply = 'I can help organize the follow-ups from your recent conversations.';

  try {
    await Promise.all([
      subscribe(eligibleUserId, new Date(RUN_AT.getTime() + 30 * DAY_MS)),
      subscribe(childOnlyUserId, new Date(RUN_AT.getTime() + 30 * DAY_MS)),
      subscribe(recentRootUserId, new Date(RUN_AT.getTime() + 30 * DAY_MS)),
      subscribe(expiredUserId, new Date(RUN_AT.getTime() - DAY_MS)),
    ]);

    const oldRoot = await prisma.agent.create({
      data: { userId: childOnlyUserId, goal: 'Old user-issued task', status: 'COMPLETED' },
    });
    await setAgentCreatedAt(oldRoot.id, new Date(RUN_AT.getTime() - 8 * DAY_MS));
    await prisma.agent.create({
      data: {
        userId: childOnlyUserId,
        goal: 'Recent child spawned by old task',
        parentAgentId: oldRoot.id,
        depth: 1,
        status: 'COMPLETED',
      },
    });
    await prisma.agent.create({
      data: { userId: recentRootUserId, goal: 'Recent user-issued task', status: 'COMPLETED' },
    });

    await Promise.all([
      setFixtureOverride(eligibleUserId, completionFixture(eligibleReply)),
      setFixtureOverride(childOnlyUserId, completionFixture(childOnlyReply)),
    ]);

    const token = captureToken('proactive-sms-eligibility');
    const summary = await runJob(userIds, token);
    if (
      summary.considered !== 5 ||
      summary.eligible !== 2 ||
      summary.sent !== 2 ||
      summary.skipped !== 0 ||
      summary.failed !== 0
    ) {
      throw new Error(`Unexpected proactive job summary: ${JSON.stringify(summary)}`);
    }

    await Promise.all([
      waitFor(() => findSurgeCallForReply(token, 0, eligiblePhone, eligibleReply)),
      waitFor(() => findSurgeCallForReply(token, 0, childOnlyPhone, childOnlyReply)),
    ]);

    const firstCalls = surgeCallsTo(
      await readCapturesForToken(token),
      new Set([eligiblePhone, childOnlyPhone, recentRootPhone, unsubscribedPhone, expiredPhone])
    );
    if (firstCalls.length !== 2) {
      throw new Error(`Expected exactly two eligible outbound SMS calls, got ${firstCalls.length}`);
    }

    for (const [userId, expectedReply] of [
      [eligibleUserId, eligibleReply],
      [childOnlyUserId, childOnlyReply],
    ] as const) {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      const messages = JSON.parse(String(session?.messages ?? '[]')) as {
        role?: string;
        content?: string;
      }[];
      if (
        !messages.some(
          (message) =>
            message.role === 'user' &&
            message.content?.includes(PROACTIVE_SMS_OUTREACH_PROMPT) &&
            message.content.includes('proactive-sms:2026-07-12')
        )
      ) {
        throw new Error('Expected the scheduler to inject a turn into the existing SMS flow');
      }
      if (
        !messages.some(
          (message) => message.role === 'assistant' && message.content === expectedReply
        )
      ) {
        throw new Error('Expected the existing SMS flow to persist its agent response');
      }
    }

    const secondToken = captureToken('proactive-sms-dedupe');
    const secondSummary = await runJob(userIds, secondToken);
    if (secondSummary.eligible !== 2 || secondSummary.sent !== 0 || secondSummary.skipped !== 2) {
      throw new Error(`Expected same-day outreach dedupe: ${JSON.stringify(secondSummary)}`);
    }
    const secondCalls = surgeCallsTo(
      await readCapturesForToken(secondToken),
      new Set([eligiblePhone, childOnlyPhone])
    );
    if (secondCalls.length !== 0) {
      throw new Error(`Expected zero duplicate SMS calls, got ${secondCalls.length}`);
    }
  } finally {
    await Promise.all(userIds.map((userId) => cleanupAgentScopedUser(prisma, userId)));
  }
}

async function testTaskCreatedDuringGenerationPreventsSend(): Promise<void> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('proactive-sms-race');

  try {
    await subscribe(userId, new Date(RUN_AT.getTime() + 30 * DAY_MS));
    await setFixtureOverride(userId, completionFixture('This should never be sent.', 500));

    const runPromise = runJob([userId], token);
    await waitFor(() => prisma.smsSession.findUnique({ where: { userId } }));
    await prisma.agent.create({
      data: { userId, goal: 'Task issued while proactive SMS was being drafted' },
    });

    const summary = await runPromise;
    if (summary.eligible !== 1 || summary.sent !== 0 || summary.skipped !== 1) {
      throw new Error(
        `Expected last-moment eligibility recheck to skip: ${JSON.stringify(summary)}`
      );
    }
    const calls = surgeCallsTo(await readCapturesForToken(token), new Set([phone]));
    if (calls.length !== 0) {
      throw new Error(`Expected no SMS after a new task was issued, got ${calls.length}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

async function testConcurrentRunsCommitOnlyOneOutreach(): Promise<void> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('proactive-sms-concurrent-dedupe');
  const reply = 'I can help turn one of your saved ideas into a concrete next step.';

  try {
    await subscribe(userId, new Date(RUN_AT.getTime() + 30 * DAY_MS));
    await setFixtureOverride(userId, completionFixture(reply, 500));

    const summaries = await Promise.all([runJob([userId], token), runJob([userId], token)]);
    const sent = summaries.reduce((total, summary) => total + summary.sent, 0);
    const skipped = summaries.reduce((total, summary) => total + summary.skipped, 0);
    if (sent !== 1 || skipped !== 1) {
      throw new Error(`Expected one concurrent send and one skip: ${JSON.stringify(summaries)}`);
    }

    const calls = surgeCallsTo(await readCapturesForToken(token), new Set([phone]));
    if (calls.length !== 1) {
      throw new Error(`Expected one concurrent outbound SMS call, got ${calls.length}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

async function testSharedLeaseSerializesJobsAndRecoversStaleOwner(): Promise<void> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('proactive-sms-shared-lease');
  const reply = 'Want me to help choose the most useful thing to tackle next?';

  try {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
    });
    await subscribe(userId, new Date(RUN_AT.getTime() + 30 * DAY_MS));
    await setFixtureOverride(userId, completionFixture(reply, 500));

    const concurrent = await Promise.all([
      runLeasedJob([userId], token),
      runLeasedJob([userId], token),
    ]);
    if (concurrent.filter((result) => result.acquired).length !== 1) {
      throw new Error(`Expected exactly one lease owner: ${JSON.stringify(concurrent)}`);
    }
    if (concurrent.reduce((total, result) => total + (result.summary?.sent ?? 0), 0) !== 1) {
      throw new Error(`Expected the lease owner to send once: ${JSON.stringify(concurrent)}`);
    }

    await prisma.toolSideEffect.upsert({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
      create: {
        operationKey: PROACTIVE_SMS_JOB_LEASE_KEY,
        operationType: 'PROACTIVE_SMS_JOB_LEASE',
        status: 'STARTED',
        externalId: 'abandoned-owner',
      },
      update: { status: 'STARTED', externalId: 'abandoned-owner' },
    });
    await prisma.$executeRaw`
      UPDATE "ToolSideEffect"
      SET "updatedAt" = NOW() - INTERVAL '31 minutes'
      WHERE "operationKey" = ${PROACTIVE_SMS_JOB_LEASE_KEY}
    `;

    const recovered = await runLeasedJob([], captureToken('proactive-sms-stale-lease'));
    if (!recovered.acquired) {
      throw new Error('Expected an expired proactive SMS lease to be recoverable');
    }
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
    });
    await cleanupAgentScopedUser(prisma, userId);
  }
}

async function testLeasedEndpointRejectsMalformedInput(): Promise<void> {
  const invalidBodies = [
    null,
    [],
    'invalid',
    { now: 123, userIds: [] },
    { now: RUN_AT.toISOString(), userIds: ['valid-user-id', 42] },
  ];

  for (const body of invalidBodies) {
    const response = await request(`${BASE_URL}/api/test/proactive-sms/run-leased`, {
      method: 'POST',
      headers: { 'X-Capture-Token': captureToken('proactive-sms-invalid-lease-request') },
      body: JSON.stringify(body),
    });
    assertStatus(response.status, 400, response.data);
  }
}

async function testDisplacedLeaseOwnerAbortsBeforeSend(): Promise<void> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('proactive-sms-displaced-lease');

  try {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
    });
    await subscribe(userId, new Date(RUN_AT.getTime() + 30 * DAY_MS));
    await setFixtureOverride(userId, completionFixture('This should never be sent.', 500));

    const runPromise = runLeasedJob([userId], token);
    await waitFor(() => prisma.smsSession.findUnique({ where: { userId } }));
    await prisma.toolSideEffect.update({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
      data: { externalId: 'replacement-owner' },
    });

    const result = await runPromise;
    if (
      !result.acquired ||
      result.summary?.sent !== 0 ||
      result.summary.skipped !== 1 ||
      result.summary.failed !== 0
    ) {
      throw new Error(`Expected displaced lease owner to abort: ${JSON.stringify(result)}`);
    }
    const calls = surgeCallsTo(await readCapturesForToken(token), new Set([phone]));
    if (calls.length !== 0) {
      throw new Error(`Expected no SMS from a displaced lease owner, got ${calls.length}`);
    }
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
    });
    await cleanupAgentScopedUser(prisma, userId);
  }
}

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ['Wednesday/Sunday schedule', async () => assertWednesdaySundaySchedule()],
    ['proactive SMS prompt snapshot', async () => assertPromptSnapshot()],
    [
      'subscriber eligibility, agent output, and same-day dedupe',
      testEligibilityAgentOutputAndDailyDedupe,
    ],
    [
      'task issued during generation suppresses outreach',
      testTaskCreatedDuringGenerationPreventsSend,
    ],
    ['concurrent runs commit only one outreach', testConcurrentRunsCommitOnlyOneOutreach],
    [
      'shared job lease serializes runs and recovers an abandoned owner',
      testSharedLeaseSerializesJobsAndRecoversStaleOwner,
    ],
    ['leased endpoint rejects malformed input', testLeasedEndpointRejectsMalformedInput],
    ['displaced lease owner aborts before send', testDisplacedLeaseOwnerAbortsBeforeSend],
  ];
  const results = [];
  for (const [name, test] of tests) results.push(await runTest(name, test));

  console.log('\nProactive SMS black-box results:');
  for (const result of results) {
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)`);
    if (result.error) console.log(`    ${result.error}`);
  }
  await prisma.$disconnect();
  if (results.some((result) => !result.passed)) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
