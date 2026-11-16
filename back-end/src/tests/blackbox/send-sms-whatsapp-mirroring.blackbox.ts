#!/usr/bin/env tsx
/**
 * Lifecycle notifications remain successful when SMS delivers and the mirrored
 * WhatsApp request fails. The blackbox fetch fixture returns a deterministic 503
 * for the marker below, while the Surge fixture still returns 200.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { assertLocalDatabase } from './assertLocalDatabase';
import { notificationFixtureKey } from '../../providers/smsSupervisor/notificationLlm';

config();
assertLocalDatabase();

const BASE_URL = process.env.TEST_BASE_URL || '[REDACTED]';
const API_KEY = process.env.BACKEND_API_KEY || '';
const WHATSAPP_FAILURE_MARKER = '__BLACKBOX_WHATSAPP_503__';
const prisma = new PrismaClient();

interface CapturedCall {
  url: string;
  requestBody: string | null;
  responseStatus: number | null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = (await response.json()) as unknown;
  return { status: response.status, data };
}

async function readCaptures(token: string): Promise<CapturedCall[]> {
  const response = await request(
    `${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`
  );
  assert(response.status === 200, `capture read returned ${response.status}`);
  return (response.data as { captures: CapturedCall[] }).captures;
}

async function cleanup(userId: string, agentId: string, attentionId?: string): Promise<void> {
  await prisma.toolSideEffect.deleteMany({
    where: {
      operationKey: {
        in: [
          `lifecycle-sms.completion:${agentId}`,
          `lifecycle-sms.write_lock:${attentionId}:initial`,
        ],
      },
    },
  });
  await prisma.smsSession.deleteMany({ where: { userId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function testSmsSuccessSurvivesWhatsAppFailure(): Promise<void> {
  assert(
    process.env.BLACKBOX_TEST_FAKE_WHATSAPP === '1',
    'blackbox WhatsApp transport fixture is not enabled'
  );
  const userId = randomUUID();
  const captureToken = `sms-whatsapp-mirror-${userId}`;
  const phone = `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
  const user = await prisma.user.create({
    data: { userId, phone, isAnonymous: true, whatsappReachable: true },
  });
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'blackbox mirrored notification',
      source: 'SMS',
      status: 'ACTIVE',
      progress: 0.5,
    },
  });

  try {
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'X-Capture-Token': captureToken },
      body: JSON.stringify({
        user_id: user.userId,
        agent_id: agent.id,
        event_type: 'completion',
        payload: { summary: `delivery completed ${WHATSAPP_FAILURE_MARKER}` },
      }),
    });
    assert(
      response.status === 200,
      `SMS success must survive mirrored WhatsApp failure; got ${response.status}: ` +
        JSON.stringify(response.data)
    );
    assert(
      (response.data as { success?: boolean }).success === true,
      `notification did not report success: ${JSON.stringify(response.data)}`
    );

    const captures = (await readCaptures(captureToken)).filter((call) =>
      call.requestBody?.includes(WHATSAPP_FAILURE_MARKER)
    );
    const sms = captures.find((call) => new URL(call.url).hostname === 'api.surge.app');
    const whatsapp = captures.find((call) => new URL(call.url).hostname === 'graph.facebook.com');
    assert(sms?.responseStatus === 200, `expected successful SMS capture: ${JSON.stringify(sms)}`);
    assert(
      whatsapp?.responseStatus === 503,
      `expected failed WhatsApp capture: ${JSON.stringify(whatsapp)}`
    );

    const sideEffect = await prisma.toolSideEffect.findUnique({
      where: { operationKey: `lifecycle-sms.completion:${agent.id}` },
    });
    assert(
      sideEffect?.status === 'SUCCEEDED',
      `completion side effect must persist SMS success, got ${sideEffect?.status ?? 'missing'}`
    );
  } finally {
    await cleanup(userId, agent.id);
  }
}

async function testKickoffUsesNotificationAndLink(): Promise<void> {
  for (const source of ['SMS', 'WHATSAPP'] as const) {
    const userId = randomUUID();
    const captureToken = `kickoff-${userId}`;
    const phone = `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
    const goal = 'INTERNAL_TASK_SENTINEL: use the saved account and compare pickup locations.';
    const notification = "I'll order your usual Blue Bottle coffee.";
    await prisma.user.create({
      data: { userId, phone, isAnonymous: true, whatsappReachable: true },
    });
    const agent = await prisma.agent.create({
      data: {
        userId,
        goal,
        source,
        messages: {
          create: {
            text: goal,
            role: 'USER',
            metadata: { startNotification: { message: notification } },
          },
        },
      },
    });
    try {
      for (const override of [undefined, "I'll check pickup availability first."]) {
        const expected = `${override ?? notification}\nhttps://roselabs.ai/a/${agent.id}`;
        const response = await request(`${BASE_URL}/api/send-sms/notify`, {
          method: 'POST',
          headers: { 'X-API-Key': API_KEY, 'X-Capture-Token': captureToken },
          body: JSON.stringify({
            user_id: userId,
            agent_id: agent.id,
            event_type: 'agent_started',
            payload: { goal, notification_message: override },
          }),
        });
        assert(response.status === 200, `kickoff returned ${response.status}`);
        const calls = await readCaptures(captureToken);
        const sms = calls.filter((call) => new URL(call.url).hostname === 'api.surge.app');
        const whatsapp = calls.filter(
          (call) => new URL(call.url).hostname === 'graph.facebook.com'
        );
        assert(sms.length === (override ? 2 : 1), 'expected one SMS per kickoff event');
        assert(whatsapp.length === sms.length, 'kickoff must reach both messaging channels');
        const smsBody = JSON.parse(sms.at(-1)!.requestBody!) as { body: string };
        const whatsappBody = JSON.parse(whatsapp.at(-1)!.requestBody!) as {
          text: { body: string };
        };
        assert(smsBody.body === expected, `Unexpected kickoff SMS: ${smsBody.body}`);
        assert(whatsappBody.text.body === expected, 'WhatsApp kickoff differs from SMS');
        const session = await prisma.smsSession.findUnique({ where: { userId } });
        assert(
          session?.messages.includes(expected.replaceAll('\n', '\\n')),
          'kickoff missing from transcript'
        );
      }
      const stored = await prisma.agent.findUnique({ where: { id: agent.id } });
      assert(stored?.goal === goal, 'kickoff formatting changed the internal agent goal');
    } finally {
      await cleanup(userId, agent.id);
    }
  }
}

async function testWriteLockRetriesOnlyRejectedDelivery(): Promise<void> {
  for (const failure of ['ambiguous', 'rejected', 'mixed']) {
    const rejected = failure !== 'ambiguous';
    const mirrored = failure === 'mixed';
    const userId = randomUUID();
    const attentionId = randomUUID();
    const captureToken = `write-lock-retry-${userId}`;
    const operationKey = `lifecycle-sms.write_lock:${attentionId}:initial`;
    const marker =
      (rejected ? '__BLACKBOX_SURGE_422__' : '__BLACKBOX_SURGE_502__') +
      (mirrored ? `\n${WHATSAPP_FAILURE_MARKER}` : '');
    await prisma.user.create({
      data: {
        userId,
        phone: `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
        isAnonymous: true,
        whatsappReachable: mirrored,
      },
    });
    const agent = await prisma.agent.create({
      data: { userId, goal: 'blackbox approval retry', source: 'SMS', status: 'ACTIVE' },
    });
    const notify = (question: string) =>
      request(`${BASE_URL}/api/send-sms/notify`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'X-Capture-Token': captureToken },
        body: JSON.stringify({
          user_id: userId,
          agent_id: agent.id,
          event_type: 'write_lock',
          payload: { question, attention_request_id: attentionId },
        }),
      });
    try {
      if (rejected) {
        const fixture = await request(`${BASE_URL}/api/test/sms-supervisor-fixture`, {
          method: 'POST',
          body: JSON.stringify({
            userId: notificationFixtureKey(agent.id),
            fixture: JSON.stringify({
              expected_tool_result_substrings: ['Surge API error: 422'],
              message: `Please approve the email. ${marker}\nReview in Rose: https://roselabs.ai/?agent-id=${agent.id}`,
            }),
          }),
        });
        assert(fixture.status === 200, 'could not configure rejected notification corrections');
      }
      const first = await notify(`Can I send this email? ${marker}`);
      assert(first.status === 500, `failed first delivery must return 500, got ${first.status}`);
      const initial = await prisma.toolSideEffect.findUnique({ where: { operationKey } });
      const firstCalls = (await readCaptures(captureToken)).filter(
        (call) => new URL(call.url).hostname === 'api.surge.app'
      );
      const second = await notify(
        failure === 'rejected' ? 'Can I send this email?' : `Can I send this email? ${marker}`
      );
      const calls = (await readCaptures(captureToken)).filter(
        (call) => new URL(call.url).hostname === 'api.surge.app'
      );
      const claim = await prisma.toolSideEffect.findUnique({ where: { operationKey } });
      if (failure === 'rejected') {
        assert(initial?.status === 'FAILED', 'explicit provider rejection must remain retryable');
        assert(firstCalls.length === 3, 'expected initial rejection plus two failed corrections');
        assert(calls.length === 4, 'corrected repeated request must retry a rejected approval');
        assert(
          claim?.status === 'SUCCEEDED',
          'corrected approval must complete the reclaimed claim'
        );
      } else {
        assert(
          calls.length === (mirrored ? 3 : 1),
          `ambiguous approval delivery must not be resent by a repeated request; got ${calls.length} Surge sends`
        );
        assert(
          initial?.status === 'STARTED',
          'ambiguous delivery must keep the original claim pending'
        );
        assert(
          claim?.status === 'STARTED',
          'repeated request must not fail or reclaim an ambiguous claim'
        );
        if (mirrored) {
          const whatsapp = (await readCaptures(captureToken)).filter(
            (call) => new URL(call.url).hostname === 'graph.facebook.com'
          );
          assert(whatsapp.length === 1, 'ambiguous WhatsApp mirror must not be resent');
          assert(whatsapp[0].responseStatus === 503, 'expected ambiguous WhatsApp mirror fixture');
        }
      }
      assert(second.status === 200, `repeated notification returned ${second.status}`);
    } finally {
      await request(
        `${BASE_URL}/api/test/sms-supervisor-fixture?userId=${encodeURIComponent(notificationFixtureKey(agent.id))}`,
        { method: 'DELETE' }
      );
      await cleanup(userId, agent.id, attentionId);
    }
  }
}

async function main(): Promise<void> {
  try {
    await testKickoffUsesNotificationAndLink();
    process.stdout.write('PASS SMS and WhatsApp kickoff use the notification plus agent link\n');
    await testSmsSuccessSurvivesWhatsAppFailure();
    process.stdout.write('PASS SMS success survives mirrored WhatsApp 503\n');
    await testWriteLockRetriesOnlyRejectedDelivery();
    process.stdout.write(
      'PASS write-lock retries explicit rejection and preserves ambiguous claims\n'
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
