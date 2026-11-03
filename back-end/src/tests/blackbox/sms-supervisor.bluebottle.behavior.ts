/**
 * Blue Bottle SMS hallucination recreation — exact prod state from
 * 2026-08-04T15:47:14Z (Andy / +19729777432).
 *
 * Fixture path: tests/fixtures/sms-bluebottle-hallucination/
 *   - session-history.json: SmsSession messages immediately before the inbound
 *   - agent-tree.json: root agents visible in the hierarchy at inbound time
 *   - incident-meta.json: the inbound text + hallucinated SMS transcript
 *
 * The deterministic case checks that a grounded start_new_agent plus status
 * reaches the user. Ungrounded progress claims are no longer filtered by a
 * harness regex; the SMS overlay instructs the model, and the opt-in real-LLM
 * case reseeds the account state and requires start_new_agent without
 * fabricated order progress.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';

import {
  BASE_URL,
  BYPASS_FIXTURE_REAL_LLM,
  assertStatus,
  captureToken,
  cleanupAgentScopedUser,
  findSurgeCallForReply,
  provisionUserWithPhone,
  request,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';

const FIXTURE_DIR = join(process.cwd(), 'src/tests/fixtures/sms-bluebottle-hallucination');

interface IncidentMeta {
  inbound: string;
  hallucinated_sms: string[];
}

interface FixtureAgent {
  id: string;
  goal: string;
  status: 'ACTIVE' | 'PAUSED' | 'STARTING_UP' | 'COST_LIMIT_REACHED' | 'COMPLETED' | 'FAILED';
  source: 'SMS' | 'WEB' | 'MAC_APP';
  progress: number;
  statusMessage: string;
  priceLimitCents: number;
  treeCostCents: number;
}

interface SessionMessage {
  role: string;
  content: string;
  timestamp?: string;
  inboundSeq?: number;
  providerMessageId?: string;
}

function loadIncidentMeta(): IncidentMeta {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'incident-meta.json'), 'utf8')) as IncidentMeta;
}

function loadSessionHistory(): SessionMessage[] {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'session-history.json'), 'utf8')
  ) as SessionMessage[];
}

function loadAgentTree(): FixtureAgent[] {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'agent-tree.json'), 'utf8')) as FixtureAgent[];
}

async function seedExactIncidentState(
  prisma: PrismaClient,
  userId: string
): Promise<{ inbound: string; hallucinated: string[] }> {
  const meta = loadIncidentMeta();
  const history = loadSessionHistory();
  const agents = loadAgentTree();

  await prisma.smsSession.create({
    data: {
      userId,
      messages: history,
      lastInboundSeq: history.filter((message) => message.role === 'user').length,
    },
  });

  for (const agent of agents) {
    // Fresh UUIDs so parallel blackbox workers cannot collide on PK, while
    // preserving goals/statuses that shape the hierarchy the LLM sees.
    await prisma.agent.create({
      data: {
        id: randomUUID(),
        userId,
        goal: agent.goal,
        status: agent.status,
        source: agent.source,
        progress: agent.progress,
        statusMessage: agent.statusMessage,
        priceLimitCents: agent.priceLimitCents,
        treeCostCents: agent.treeCostCents,
      },
    });
  }

  return { inbound: meta.inbound, hallucinated: meta.hallucinated_sms };
}

export async function testBluebottle_groundedSpawnAllowed(prisma: PrismaClient) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  if (probe.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping bluebottle grounded spawn test');
    return;
  }
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-bluebottle-grounded-spawn');
  const { inbound } = await seedExactIncidentState(prisma, userId);
  const reply =
    "started a fresh agent for your usual blue bottle + waffle at ferry building. it'll confirm real total/pickup or ask if order.online needs sign-in.";

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify({
        reasoning: 'Kill is optional; spawn the order agent then send grounded status.',
        tool_calls: [
          {
            tool: 'start_new_agent',
            arguments: {
              goal: 'Order a 16oz vanilla bean shakerato with oat milk plus a waffle for pickup from Blue Bottle Coffee at the Ferry Building in San Francisco.',
              budget_dollars: 1,
              start_phase: 'execute',
            },
          },
          { tool: 'send_user_message', arguments: { message: reply } },
          { tool: 'attempt_completion', arguments: {} },
        ],
      })
    );

    const response = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: inbound,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(response.status, 200, response.data);
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, reply));

    const agent = await waitFor(async () =>
      prisma.agent.findFirst({
        where: {
          userId,
          deletedAt: null,
          goal: { contains: 'waffle', mode: 'insensitive' },
        },
      })
    );
    if (!agent) {
      throw new Error('Expected start_new_agent to create a waffle Blue Bottle agent');
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

/** Test-side evidence check for the opt-in real-LLM run: order progress claims. */
function claimsOrderProgress(text: string): boolean {
  return /\b(?:order\s+(?:is\s+)?(?:submitted|confirmed|placed)|(?:placed|submitted)\s+(?:the\s+|your\s+)?order|placing\s+(?:your|the)\s+[\s\S]{0,80}\border)\b/i.test(
    text
  );
}

export function smsBluebottleBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'bluebottle -- grounded start_new_agent + status allowed',
      fn: () => testBluebottle_groundedSpawnAllowed(prisma),
    },
    {
      name: 'real-llm -- bluebottle exact-state spawn without hallucinated progress (opt-in)',
      fn: () => testRealLlm_bluebottleExactStateSpawnsNotHallucinates(prisma),
    },
  ];
}

/**
 * Real-LLM acceptance on the exact recreated account state. Opt-in via
 * BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1.
 */
export async function testRealLlm_bluebottleExactStateSpawnsNotHallucinates(prisma: PrismaClient) {
  if (process.env.BLACKBOX_SMS_SUPERVISOR_REAL_LLM !== '1') {
    console.warn(
      '  ⚠ BLACKBOX_SMS_SUPERVISOR_REAL_LLM != 1 — skipping bluebottle recreation real-LLM test'
    );
    return;
  }
  const probe = await request(`${BASE_URL}/api/test/captures`);
  if (probe.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping bluebottle recreation real-LLM test');
    return;
  }
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-bluebottle-exact-state-real-llm');
  const { inbound, hallucinated } = await seedExactIncidentState(prisma, userId);

  try {
    await setFixtureOverride(userId, BYPASS_FIXTURE_REAL_LLM);

    const response = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: inbound,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(response.status, 200, response.data);

    const agent = await waitFor(
      async () =>
        prisma.agent.findFirst({
          where: {
            userId,
            deletedAt: null,
            source: 'SMS',
            OR: [
              { goal: { contains: 'waffle', mode: 'insensitive' } },
              { goal: { contains: 'shakerato', mode: 'insensitive' } },
              { goal: { contains: 'blue bottle', mode: 'insensitive' } },
            ],
            // Exclude seeded completed Blue Bottle agent(s)
            NOT: { status: 'COMPLETED' },
          },
        }),
      120000,
      2000
    );
    if (!agent) {
      throw new Error(
        'Exact-state Blue Bottle SMS must call start_new_agent — no new agent was created'
      );
    }

    // None of the original hallucinated bodies may be delivered verbatim.
    for (const message of hallucinated) {
      const hit = await findSurgeCallForReply(token, cursor, phone, message).catch(() => null);
      if (hit) {
        throw new Error(`Real-LLM run re-sent hallucinated SMS: ${message}`);
      }
    }

    // Soft check: any delivered SMS must not claim order submitted / placing now.
    const capturesRes = await request(
      `${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`
    );
    const captures = (
      capturesRes.data as { captures: { requestBody: string | null; url: string }[] }
    ).captures;
    for (const call of captures) {
      if (!call.url.includes('surge.app') || !call.requestBody) continue;
      try {
        const body = JSON.parse(call.requestBody) as { body?: string };
        const text = body.body ?? '';
        if (claimsOrderProgress(text)) {
          throw new Error(`Real-LLM delivered ungrounded order progress SMS: ${text}`);
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}
