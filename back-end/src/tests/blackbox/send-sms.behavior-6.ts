/**
 * Kickoff and completion notices reach SMS/WhatsApp/Linq only for agents the
 * user touched from the phone. Andy, 2026-11-12: "Only show completed agents
 * notif if the sms / whatsapp agent has interacted w that agent". Prod agents
 * 001fbe70 and d6592fb1 were started on the web, never touched over SMS, and
 * still texted "I finished the task: …". Andy, 2026-11-14: "only trigger
 * messaging notifs when an agent has been touched by the messaging client".
 * Kickoffs for web and Mac agents made up 18 of his 19 lifecycle texts over 48h.
 * Same day: a relay is not a touch; "a touch should be if I respond and we reply".
 *
 *   touch (the messaging agent acting on the user's message)   kickoff / completion
 *   created   start_new_agent (source SMS | WHATSAPP)  ─┐
 *   replied   reply_to_agent (answer, approve, reject)   ├─▶ delivered on SMS
 *   budget    increase_budget                          ─┘    (+ WhatsApp mirror)
 *   relayed question / approval / cost limit / card setup  ─▶ skipped:
 *   none                                                  ─▶ no_messaging_agent_interaction
 *
 * Questions, approvals and setup handoffs that block an agent still reach the
 * phone for every agent; delivering one is not a touch.
 *
 * Replied cases run the real inbound webhook → supervisor (scripted tool
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
  parentAgentId?: string,
  busId: string | null | undefined = parentAgentId
): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      userId: fixture.userId,
      goal: `completion scope ${source} ${status}`,
      source,
      status,
      progress: status === 'COMPLETED' ? 1 : 0.4,
      ...(parentAgentId !== undefined ? { parentAgentId, busId, depth: 1 } : {}),
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
  await prisma.toolSideEffect.deleteMany({
    where: {
      operationKey: { startsWith: `lifecycle-sms.write_lock:attn-scope-${fixture.userId}` },
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

/**
 * Inbound message → supervisor reply_to_agent commit on `agentId`, over `channel`.
 * Returns once the touch marker on `rootId` is written: the commit posts the
 * message first and the marker a few round trips later.
 */
async function supervisorRepliesToAgent(
  fixture: ScopedFixture,
  agentId: string,
  channel: Channel,
  rootId: string = agentId
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
  await waitFor(
    async () => ((await interactionMarkerKind(rootId)) === 'reply_to_agent' ? true : null),
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

/** One delivered relay of `eventType` on the messaging thread, isolated by its capture token. */
async function relayUpdate(
  fixture: ScopedFixture,
  agentId: string,
  eventType: 'write_lock' | 'cost_limit' | 'agentcard_setup'
) {
  const payloads = {
    write_lock: {
      question: 'May I place the $42 order?',
      attention_request_id: `attn-scope-${fixture.userId}-${agentId}`,
      workflow_id: `wf-scope-${agentId}`,
    },
    cost_limit: { tree_cost_cents: 120, price_limit_cents: 100 },
    agentcard_setup: { setup_url: 'https://rose.test/api/agentcard/connect?user=scope' },
  };
  const token = captureToken(`completion-scope-${eventType}`);
  await notify(fixture, agentId, eventType, payloads[eventType], token);
  const bodies = deliveredBodies(await readCapturesForToken(token), '');
  assert(bodies.SMS.length === 1, `${eventType} relay not delivered: ${JSON.stringify(bodies)}`);
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

// ==================== 1. SMS touches ====================

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

export async function testCompletionScope_smsReplyToChildNotifiesRoot() {
  await withFixture('SMS', async (fixture) => {
    const rootId = await createAgent(fixture, 'WEB', 'ACTIVE');
    const childId = await createAgent(fixture, 'WEB', 'ACTIVE', rootId);
    await supervisorRepliesToAgent(fixture, childId, 'SMS', rootId);
    // Only the tree marker connects this root to the SMS agent: its own
    // conversation never saw an sms_supervisor message.
    const rootReplies = await prisma.message.count({
      where: { agentId: rootId, metadata: { path: ['source'], equals: 'sms_supervisor' } },
    });
    assert(rootReplies === 0, `Root unexpectedly holds ${rootReplies} supervisor messages`);
    const marker = await prisma.toolSideEffect.findUnique({
      where: { operationKey: messagingAgentInteractionKey(rootId) },
    });
    assert(marker !== null, 'Child reply did not mark the root as interacted');
    await assertCompletionDelivered(fixture, rootId, 'SMS');
  });
}

export async function testCompletionScope_replyToChildWithoutBusIdNotifiesRoot() {
  await withFixture('SMS', async (fixture) => {
    const rootId = await createAgent(fixture, 'WEB', 'ACTIVE');
    // A restored row can lack busId; the marker must still reach the root.
    const childId = await createAgent(fixture, 'WEB', 'ACTIVE', rootId, null);
    await supervisorRepliesToAgent(fixture, childId, 'SMS', rootId);
    await assertCompletionDelivered(fixture, rootId, 'SMS');
  });
}

// ==================== 2. WhatsApp touches ====================

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

// ==================== 3. No touch → no completion notice ====================

/** Completion notify for an untouched agent: skipped, nothing sent, nothing claimed. */
async function assertCompletionSkipped(
  fixture: ScopedFixture,
  agentId: string,
  label: string
): Promise<void> {
  const marker = `scope-silent-${agentId.substring(0, 8)}`;
  const token = captureToken('completion-scope-silent');
  const result = await notify(fixture, agentId, 'completion', { summary: marker }, token);
  assert(
    result.skipped === true && result.reason === 'no_messaging_agent_interaction',
    `Expected ${label} completion to be skipped, got ${JSON.stringify(result)}`
  );
  const calls = (await readCapturesForToken(token)).filter((call) =>
    call.requestBody?.includes(marker)
  );
  assert(calls.length === 0, `Expected no ${label} completion send, got ${calls.length}`);
  const claim = await prisma.toolSideEffect.findUnique({
    where: { operationKey: `lifecycle-sms.completion:${agentId}` },
  });
  assert(claim === null, `Expected no ${label} completion claim, got ${claim?.status}`);
}

async function interactionMarkerKind(rootId: string): Promise<unknown> {
  const marker = await prisma.toolSideEffect.findUnique({
    where: { operationKey: messagingAgentInteractionKey(rootId) },
    select: { request: true },
  });
  const request = marker?.request;
  if (request === null || request === undefined || typeof request !== 'object') return undefined;
  return Array.isArray(request) ? undefined : request.kind;
}

export async function testCompletionScope_untouchedWebAgentNotNotified() {
  await withFixture('WHATSAPP', async (fixture) => {
    const agentId = await createAgent(fixture, 'WEB', 'ACTIVE');
    // A kickoff attempt is not a touch (and is itself skipped here).
    const kickoff = captureToken('completion-scope-kickoff');
    await notify(fixture, agentId, 'agent_started', { goal: 'Fix the bug report form' }, kickoff);
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    await assertCompletionSkipped(fixture, agentId, 'an untouched web agent');
    assert(
      (await interactionMarkerKind(agentId)) === undefined,
      'Expected no interaction marker for an untouched agent'
    );
  });
}

export async function testTouchScope_relaysAreNotTouches() {
  await withFixture('WHATSAPP', async (fixture) => {
    const relays: [string, (agentId: string) => Promise<void>][] = [
      ['question', (agentId) => relayQuestion(fixture, agentId, 'WHATSAPP')],
      ['write_lock', (agentId) => relayUpdate(fixture, agentId, 'write_lock')],
      ['cost_limit', (agentId) => relayUpdate(fixture, agentId, 'cost_limit')],
      ['agentcard_setup', (agentId) => relayUpdate(fixture, agentId, 'agentcard_setup')],
    ];
    for (const [kind, relay] of relays) {
      const rootId = await createAgent(fixture, 'WEB', 'ACTIVE');
      const childId = await createAgent(fixture, 'MAC_APP', 'ACTIVE', rootId);
      // Each relay still reaches the phone (asserted inside the relay helper).
      await relay(rootId);
      await relay(childId);
      assert(
        (await interactionMarkerKind(rootId)) === undefined,
        `A delivered ${kind} relay marked the tree as touched`
      );
      await prisma.agent.update({ where: { id: rootId }, data: { status: 'COMPLETED' } });
      await assertCompletionSkipped(fixture, rootId, `a ${kind}-relayed web agent`);
    }
  });
}

export async function testTouchScope_replyOverridesLegacyRelayMarker() {
  await withFixture('SMS', async (fixture) => {
    const rootId = await createAgent(fixture, 'WEB', 'ACTIVE');
    const childId = await createAgent(fixture, 'WEB', 'ACTIVE', rootId);
    // Rows written while relays still counted carry the relay's kind.
    await prisma.toolSideEffect.create({
      data: {
        operationKey: messagingAgentInteractionKey(rootId),
        operationType: 'messaging-agent.interaction',
        status: 'SUCCEEDED',
        request: { agent_id: rootId, kind: 'write_lock' },
      },
    });
    await assertCompletionSkipped(fixture, rootId, 'a legacy relay-marked web agent');
    // Times out unless the reply overwrites the legacy relay marker.
    await supervisorRepliesToAgent(fixture, childId, 'SMS', rootId);
    const kind = await interactionMarkerKind(rootId);
    assert(
      kind === 'reply_to_agent',
      `Expected the reply to replace the relay marker, got ${String(kind)}`
    );
    await assertCompletionDelivered(fixture, rootId, 'SMS');
  });
}

// ==================== 4. Kickoff follows the same scope ====================

export async function testKickoffScope_untouchedAgentSilentQuestionsStillSent() {
  await withFixture('WHATSAPP', async (fixture) => {
    for (const source of ['WEB', 'MAC_APP'] as const) {
      const agentId = await createAgent(fixture, source, 'ACTIVE');
      const marker = `scope-running-${agentId.substring(0, 8)}`;
      const token = captureToken('kickoff-scope-silent');
      const result = await notify(
        fixture,
        agentId,
        'agent_started',
        { goal: `Draft the memo ${marker}` },
        token
      );
      assert(
        result.skipped === true && result.reason === 'no_messaging_agent_interaction',
        `Expected an untouched ${source} agent's kickoff to be skipped, got ${JSON.stringify(result)}`
      );
      const calls = (await readCapturesForToken(token)).filter((call) =>
        call.requestBody?.includes(marker)
      );
      assert(calls.length === 0, `Expected no ${source} kickoff send, got ${calls.length}`);
      // A question that blocks the agent still reaches the phone on every channel.
      await relayQuestion(fixture, agentId, 'WHATSAPP');
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert(stored.status === 'ACTIVE', `Notices must not change agent status: ${stored.status}`);
    }
  });
}

export async function testKickoffScope_messagingCreatedAgentKickoffSent() {
  await withFixture('WHATSAPP', async (fixture) => {
    for (const source of ['SMS', 'WHATSAPP'] as const) {
      const agentId = await createAgent(fixture, source, 'ACTIVE');
      const marker = `scope-kickoff-${agentId.substring(0, 8)}`;
      const token = captureToken('kickoff-scope-sent');
      const result = await notify(
        fixture,
        agentId,
        'agent_started',
        { goal: `Book the table ${marker}` },
        token
      );
      assert(result.skipped !== true, `${source} kickoff was skipped: ${JSON.stringify(result)}`);
      const bodies = deliveredBodies(await readCapturesForToken(token), marker);
      assert(
        bodies.SMS.length === 1 && bodies.WHATSAPP.length === 1,
        `${source}-created kickoff must reach both channels: ${JSON.stringify(bodies)}`
      );
    }
  });
}
