/**
 * Completion notices reach SMS/WhatsApp only for agents the messaging agent
 * interacted with (Andy, 2026-11-12: "Only show completed agents notif if the
 * sms / whatsapp agent has interacted w that agent"). Prod agents 001fbe70 and
 * d6592fb1 were started on the web, never touched over SMS, and still texted
 * "I finished the task: …".
 *
 *   interaction (per channel)              completion notify
 *   created   source SMS | WHATSAPP   ─┐
 *   messaged  supervisor reply_to_agent ├─▶ delivered on SMS (+ WhatsApp mirror)
 *   relayed   question / budget update ─┘
 *   none      (kickoff receipt only)  ───▶ skipped: no_messaging_agent_interaction
 *
 * Messaged cases run the real inbound webhook → supervisor (scripted tool
 * calls) → reply_to_agent commit, then the worker's completion notify.
 */

import type { AgentSource, AgentStatus } from '@prisma/client';
import { commitPendingWrites } from '../../providers/smsSupervisor/supervisorTools';
import { messagingAgentInteractionKey } from '../../providers/messagingAgentInteraction';
import {
  BASE_URL,
  apiKeyHeaders,
  assert,
  assertStatus,
  captureToken,
  prisma,
  readCapturesForToken,
  request,
  type CapturedCall,
} from './send-sms.support';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';

type Channel = 'SMS' | 'WHATSAPP';

interface ScopedFixture {
  userId: string;
  phone: string;
  agentIds: string[];
}

async function createScopedUser(channel: Channel): Promise<ScopedFixture> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  // WhatsApp lifecycle mirroring follows the stored reachability flag.
  await prisma.user.update({
    where: { userId },
    data: { whatsappReachable: channel === 'WHATSAPP' },
  });
  return { userId, phone, agentIds: [] };
}

async function createAgent(
  fixture: ScopedFixture,
  source: AgentSource,
  status: AgentStatus,
  parentAgentId?: string
): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      userId: fixture.userId,
      goal: `completion scope ${source} ${status}`,
      source,
      status,
      progress: status === 'COMPLETED' ? 1 : 0.4,
      ...(parentAgentId !== undefined ? { parentAgentId, busId: parentAgentId, depth: 1 } : {}),
    },
  });
  fixture.agentIds.push(agent.id);
  return agent.id;
}

async function cleanup(fixture: ScopedFixture): Promise<void> {
  await prisma.toolSideEffect.deleteMany({
    where: {
      operationKey: {
        in: fixture.agentIds.flatMap((id) => [
          `lifecycle-sms.completion:${id}`,
          messagingAgentInteractionKey(id),
        ]),
      },
    },
  });
  await prisma.agent.deleteMany({
    where: { id: { in: fixture.agentIds }, parentAgentId: { not: null } },
  });
  await cleanupAgentScopedUser(prisma, fixture.userId);
}

async function notify(
  fixture: ScopedFixture,
  agentId: string,
  eventType: string,
  payload: Record<string, unknown>,
  token: string
): Promise<Record<string, unknown>> {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      user_id: fixture.userId,
      agent_id: agentId,
      event_type: eventType,
      payload,
    }),
  });
  assertStatus(res.status, 200, res.data);
  return res.data as Record<string, unknown>;
}

function deliveredBodies(calls: CapturedCall[], marker: string): Record<Channel, string[]> {
  const bodies: Record<Channel, string[]> = { SMS: [], WHATSAPP: [] };
  for (const call of calls) {
    if (call.requestBody === null || !call.requestBody.includes(marker)) continue;
    if (call.responseStatus !== 200) continue;
    const host = new URL(call.url).hostname;
    const parsed = JSON.parse(call.requestBody) as { body?: string; text?: { body?: string } };
    if (host === 'api.surge.app' && typeof parsed.body === 'string') bodies.SMS.push(parsed.body);
    if (host === 'graph.facebook.com' && typeof parsed.text?.body === 'string')
      bodies.WHATSAPP.push(parsed.text.body);
  }
  return bodies;
}

/** Complete the agent and assert the worker's completion notify reaches every channel. */
async function assertCompletionDelivered(
  fixture: ScopedFixture,
  agentId: string,
  channel: Channel
): Promise<void> {
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED', progress: 1 } });
  const marker = `scope-done-${agentId.substring(0, 8)}`;
  const token = captureToken('completion-scope-delivered');
  const result = await notify(fixture, agentId, 'completion', { summary: marker }, token);
  assert(result.skipped !== true, `Completion was skipped: ${JSON.stringify(result)}`);
  const bodies = deliveredBodies(await readCapturesForToken(token), marker);
  const expected = `I finished the task: ${marker}`;
  assert(
    bodies.SMS.length === 1 && bodies.SMS[0]?.startsWith(expected) === true,
    `Expected one completion SMS, got ${JSON.stringify(bodies.SMS)}`
  );
  if (channel === 'WHATSAPP') {
    assert(
      bodies.WHATSAPP.length === 1 && bodies.WHATSAPP[0]?.startsWith(expected) === true,
      `Expected one completion WhatsApp message, got ${JSON.stringify(bodies.WHATSAPP)}`
    );
  }
  const sideEffect = await prisma.toolSideEffect.findUnique({
    where: { operationKey: `lifecycle-sms.completion:${agentId}` },
  });
  assert(sideEffect?.status === 'SUCCEEDED', `Completion side effect: ${sideEffect?.status}`);
}

/** Inbound message → supervisor reply_to_agent commit on `agentId`, over `channel`. */
async function supervisorRepliesToAgent(
  fixture: ScopedFixture,
  agentId: string,
  channel: Channel
): Promise<void> {
  const instruction = `Use the blue shipping box (${agentId.substring(0, 8)}).`;
  await setFixtureOverride(
    fixture.userId,
    JSON.stringify({
      reasoning: 'Forward the instruction to the running agent.',
      tool_calls: [
        {
          tool: 'reply_to_agent',
          arguments: {
            agent_id_or_prefix: agentId,
            message: instruction,
            attention_request_id: null,
            reject: null,
          },
        },
        { tool: 'send_user_message', arguments: { message: 'Passed that along.' } },
        { tool: 'attempt_completion', arguments: {} },
      ],
    })
  );
  const wa = fixture.phone.slice(1);
  const response =
    channel === 'SMS'
      ? await request(`${BASE_URL}/api/sms/inbound`, {
          method: 'POST',
          body: JSON.stringify({
            data: {
              body: 'Tell it to use the blue box',
              conversation: { contact: { phone_number: fixture.phone } },
            },
          }),
        })
      : await request(`${BASE_URL}/api/whatsapp/webhook`, {
          method: 'POST',
          body: JSON.stringify(whatsappInbound(wa, 'Tell it to use the blue box')),
        });
  assertStatus(response.status, 200, response.data);
  await waitFor(
    () =>
      prisma.message.findFirst({
        where: {
          agentId,
          role: 'USER',
          text: instruction,
          metadata: { path: ['source'], equals: 'sms_supervisor' },
        },
      }),
    20_000
  );
}

function whatsappInbound(from: string, text: string): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551976475', phone_number_id: 'PNID' },
              contacts: [{ profile: { name: 'Tester' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.scope.${from}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** A relayed agent question on the messaging thread (mirrored to WhatsApp when reachable). */
async function relayQuestion(fixture: ScopedFixture, agentId: string, channel: Channel) {
  const marker = `scope-question-${agentId.substring(0, 8)}`;
  const token = captureToken('completion-scope-relay');
  await notify(
    fixture,
    agentId,
    'planner_message',
    { message: `Which size? ${marker}`, is_question: true },
    token
  );
  const bodies = deliveredBodies(await readCapturesForToken(token), marker);
  assert(bodies.SMS.length === 1, `Relay SMS not delivered: ${JSON.stringify(bodies)}`);
  if (channel === 'WHATSAPP')
    assert(bodies.WHATSAPP.length === 1, `Relay WhatsApp not delivered: ${JSON.stringify(bodies)}`);
}

async function withFixture(
  channel: Channel,
  fn: (fixture: ScopedFixture) => Promise<void>
): Promise<void> {
  const fixture = await createScopedUser(channel);
  try {
    await fn(fixture);
  } finally {
    await cleanup(fixture);
  }
}

// ==================== 1. SMS agent interacted ====================

export async function testCompletionScope_smsCreatedAgentNotified() {
  await withFixture('SMS', async (fixture) => {
    const agentId = await createAgent(fixture, 'SMS', 'ACTIVE');
    await assertCompletionDelivered(fixture, agentId, 'SMS');
  });
}

export async function testCompletionScope_smsSupervisorReplyNotified() {
  await withFixture('SMS', async (fixture) => {
    const agentId = await createAgent(fixture, 'WEB', 'ACTIVE');
    await supervisorRepliesToAgent(fixture, agentId, 'SMS');
    await assertCompletionDelivered(fixture, agentId, 'SMS');
  });
}

export async function testCompletionScope_smsRelayedChildQuestionNotifiesRoot() {
  await withFixture('SMS', async (fixture) => {
    const rootId = await createAgent(fixture, 'WEB', 'ACTIVE');
    const childId = await createAgent(fixture, 'WEB', 'ACTIVE', rootId);
    await relayQuestion(fixture, childId, 'SMS');
    await assertCompletionDelivered(fixture, rootId, 'SMS');
  });
}

export async function testCompletionScope_smsBudgetIncreaseNotified() {
  await withFixture('SMS', async (fixture) => {
    const agentId = await createAgent(fixture, 'WEB', 'ACTIVE');
    const [result] = await commitPendingWrites(
      [
        {
          kind: 'increase_budget',
          args: { agent_id_or_prefix: agentId, amount_dollars: 2 },
          agentId,
        },
      ],
      fixture.userId,
      'SMS'
    );
    assert(result.success, `increase_budget failed: ${JSON.stringify(result)}`);
    await assertCompletionDelivered(fixture, agentId, 'SMS');
  });
}

// ==================== 2. WhatsApp agent interacted ====================

export async function testCompletionScope_whatsappCreatedAgentNotified() {
  await withFixture('WHATSAPP', async (fixture) => {
    const agentId = await createAgent(fixture, 'WHATSAPP', 'ACTIVE');
    await assertCompletionDelivered(fixture, agentId, 'WHATSAPP');
  });
}

export async function testCompletionScope_whatsappSupervisorReplyNotified() {
  await withFixture('WHATSAPP', async (fixture) => {
    const agentId = await createAgent(fixture, 'WEB', 'ACTIVE');
    await supervisorRepliesToAgent(fixture, agentId, 'WHATSAPP');
    await assertCompletionDelivered(fixture, agentId, 'WHATSAPP');
  });
}

export async function testCompletionScope_whatsappRelayedQuestionNotified() {
  await withFixture('WHATSAPP', async (fixture) => {
    const agentId = await createAgent(fixture, 'MAC_APP', 'ACTIVE');
    await relayQuestion(fixture, agentId, 'WHATSAPP');
    await assertCompletionDelivered(fixture, agentId, 'WHATSAPP');
  });
}

// ==================== 3. No interaction → no completion notice ====================

export async function testCompletionScope_untouchedWebAgentNotNotified() {
  await withFixture('WHATSAPP', async (fixture) => {
    const agentId = await createAgent(fixture, 'WEB', 'ACTIVE');
    // The kickoff receipt goes out for every root; it is not an interaction.
    const kickoff = captureToken('completion-scope-kickoff');
    await notify(fixture, agentId, 'agent_started', { goal: 'Fix the bug report form' }, kickoff);
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });

    const marker = `scope-silent-${agentId.substring(0, 8)}`;
    const token = captureToken('completion-scope-silent');
    const result = await notify(fixture, agentId, 'completion', { summary: marker }, token);
    assert(
      result.skipped === true && result.reason === 'no_messaging_agent_interaction',
      `Expected an untouched web agent's completion to be skipped, got ${JSON.stringify(result)}`
    );
    const calls = (await readCapturesForToken(token)).filter((call) =>
      call.requestBody?.includes(marker)
    );
    assert(calls.length === 0, `Expected no SMS/WhatsApp send, got ${calls.length}`);
    const rows = await prisma.toolSideEffect.count({
      where: {
        operationKey: {
          in: [`lifecycle-sms.completion:${agentId}`, messagingAgentInteractionKey(agentId)],
        },
      },
    });
    assert(rows === 0, `Expected no completion or interaction record, got ${rows}`);
  });
}

// ==================== 4. Non-completed agents unaffected ====================

export async function testCompletionScope_untouchedAgentOtherNoticesStillSent() {
  await withFixture('WHATSAPP', async (fixture) => {
    const agentId = await createAgent(fixture, 'WEB', 'ACTIVE');
    const marker = `scope-running-${agentId.substring(0, 8)}`;
    const token = captureToken('completion-scope-running');
    await notify(fixture, agentId, 'agent_started', { goal: `Draft the memo ${marker}` }, token);
    const kickoff = deliveredBodies(await readCapturesForToken(token), marker);
    assert(
      kickoff.SMS.length === 1 && kickoff.WHATSAPP.length === 1,
      `Kickoff must still reach both channels: ${JSON.stringify(kickoff)}`
    );
    await relayQuestion(fixture, agentId, 'WHATSAPP');
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert(stored.status === 'ACTIVE', `Notices must not change agent status: ${stored.status}`);
  });
}
