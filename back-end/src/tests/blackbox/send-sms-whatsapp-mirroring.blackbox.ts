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

async function cleanup(userId: string, agentId: string): Promise<void> {
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: `lifecycle-sms.completion:${agentId}` },
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

async function main(): Promise<void> {
  try {
    await testSmsSuccessSurvivesWhatsAppFailure();
    process.stdout.write('PASS SMS success survives mirrored WhatsApp 503\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
