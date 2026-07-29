import type { PrismaClient } from '@prisma/client';

import { grep as userDataGrep } from '../../domains/data/service';
import { executeGrepTool } from '../../providers/smsSupervisor/supervisorTools.grep';
import {
  parseSmsSessionMessages,
  recordInboundSms,
} from '../../providers/smsSupervisor/sessionStore';
import { MAX_USER_MESSAGES_PER_RUN } from '../../providers/smsSupervisor/environmentMessages';
import { registerUserDataGrep } from '../../providers/userDataSearch';
import {
  BASE_URL,
  assertStatus,
  captureToken,
  cleanupAgentScopedUser,
  cleanupSessionScopedUser,
  findSurgeCallForReply,
  provisionUserWithPhone,
  request,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';

export async function testConcurrentFirstInboundsCreateOneOrderedSession(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const messages = Array.from({ length: 12 }, (_, index) => `concurrent-inbound-${index}`);

  try {
    const sequences = await Promise.all(
      messages.map((message) => recordInboundSms(userId, message))
    );
    const sortedSequences = [...sequences].sort((left, right) => left - right);
    const expectedSequences = messages.map((_, index) => index + 1);
    if (JSON.stringify(sortedSequences) !== JSON.stringify(expectedSequences)) {
      throw new Error(`Expected unique sequences 1..12, got ${JSON.stringify(sequences)}`);
    }

    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) throw new Error('Expected one SMS session after concurrent first inbounds');
    const stored = parseSmsSessionMessages(session.messages);
    const inboundSequences = stored.map((message) => message.inboundSeq);
    if (JSON.stringify(inboundSequences) !== JSON.stringify(expectedSequences)) {
      throw new Error(
        `Expected stored inbound sequence order 1..12, got ${JSON.stringify(inboundSequences)}`
      );
    }
    if (new Set(stored.map((message) => message.content)).size !== messages.length) {
      throw new Error(`Expected all concurrent inbound bodies once, got ${JSON.stringify(stored)}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testSendUserMessage_continuesUntilSubstantiveResult(prisma: PrismaClient) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  if (probe.status !== 200) return;
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-progress-then-result');
  const progress = "I'll check now.";
  const result = 'I checked the thread. The plan changed after the follow-up message.';

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify([
        {
          reasoning: 'send progress without ending the run',
          tool_calls: [{ tool: 'send_user_message', arguments: { message: progress } }],
        },
        {
          reasoning: 'send the substantive result and then stop',
          tool_calls: [
            { tool: 'send_user_message', arguments: { message: result } },
            { tool: 'attempt_completion', arguments: {} },
          ],
        },
      ])
    );
    const response = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Please check the thread and explain what changed.',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(response.status, 200, response.data);
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, progress));
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, result));
    const assistantMessages = await waitFor(async () => {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      if (session === null) return null;
      const messages = JSON.parse(session.messages) as Array<{ role?: string; content?: string }>;
      const assistants = messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content);
      return assistants.length === 2 ? assistants : null;
    });
    if (assistantMessages[0] !== progress || assistantMessages[1] !== result) {
      throw new Error(
        `Expected progress then substantive result in one run, got ${JSON.stringify(assistantMessages)}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testGrep_fanOutPaginationMetadataAligns(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const person = await prisma.person.create({
    data: { userId, firstName: 'Pager', lastName: 'Fixture' },
  });

  try {
    await prisma.messageRecord.createMany({
      data: [1, 2, 3].map((index) => ({
        personId: person.id,
        channel: 'IMESSAGE',
        from: index % 2 === 0 ? 'me' : phone,
        to: index % 2 === 0 ? phone : 'me',
        timestamp: new Date(Date.now() + index * 1000),
        message: `Metadata page ${index}`,
        externalId: `metadata-page-${userId}-${index}`,
      })),
    });
    registerUserDataGrep(userDataGrep);
    const toolResult = await executeGrepTool(
      {
        pattern: 'Metadata page',
        source: null,
        '-B': null,
        '-A': null,
        '-C': null,
        context: null,
        '-n': null,
        '-i': null,
        head_limit: 1,
        offset: 1,
        multiline: null,
        filters: null,
        person: null,
        since: null,
      },
      userId
    );
    if (!toolResult.success) throw new Error(`Expected grep success: ${toolResult.error}`);
    const payload = JSON.parse(toolResult.result) as {
      applied_offset: number;
      returned: number;
      has_more: boolean;
      next_offset: number | null;
    };
    if (
      payload.applied_offset !== 1 ||
      payload.returned !== 1 ||
      payload.has_more !== true ||
      payload.next_offset !== 2
    ) {
      throw new Error(`Expected aligned fan-out pagination metadata, got ${toolResult.result}`);
    }
  } finally {
    await prisma.person.deleteMany({ where: { userId } });
    await cleanupSessionScopedUser(prisma, userId);
  }
}

/**
 * Regression: one inbound SMS must never fan out into a wall of texts.
 *
 * Prod repro (user +1972…7432, 2026-07-27 20:52 UTC): a run that never called
 * attempt_completion sent EIGHT "Acknowledged. I am monitoring active agents…"
 * texts for one inbound, one per tool round, until MAX_TOOL_ROUNDS. The fixture
 * below is that exact shape — a model that keeps choosing send_user_message and
 * never stops. MAX_USER_MESSAGES_PER_RUN is what bounds the blast radius.
 */
export async function testSendBudget_runawaySendLoopIsCappedPerInbound(prisma: PrismaClient) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  if (probe.status !== 200) return;
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-send-budget');
  const spam = Array.from(
    { length: 6 },
    (_, index) => `Acknowledged. I am monitoring active agents (${String(index)}).`
  );

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify(
        spam.map((message) => ({
          reasoning: 'keep acknowledging without ever completing',
          tool_calls: [{ tool: 'send_user_message', arguments: { message } }],
        }))
      )
    );
    const response = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Let the agent work',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(response.status, 200, response.data);

    // The budget is spent by the second send, so the run stops there. Wait for
    // that steady state, then prove the third message never went out.
    const delivered = await waitFor(async () => {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      if (session === null) return null;
      const stored = parseSmsSessionMessages(session.messages);
      const assistants = stored.filter((message) => message.role === 'assistant');
      return assistants.length >= MAX_USER_MESSAGES_PER_RUN ? assistants : null;
    });

    if (delivered.length !== MAX_USER_MESSAGES_PER_RUN) {
      throw new Error(
        `One inbound must produce at most ${String(MAX_USER_MESSAGES_PER_RUN)} outbound SMS, ` +
          `got ${String(delivered.length)}: ${JSON.stringify(delivered.map((m) => m.content))}`
      );
    }
    const overflow = await findSurgeCallForReply(token, cursor, phone, spam[2]);
    if (overflow !== null) {
      throw new Error('Third send_user_message escaped the per-run budget and reached Surge');
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

/**
 * Regression: a lifecycle SMS a spawned agent sent must show up on the
 * supervisor's own transcript, otherwise the supervisor re-narrates progress the
 * user was already told about by the agent itself.
 */
export async function testLifecycleSms_landsOnSupervisorTranscript(prisma: PrismaClient) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  if (probe.status !== 200) return;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);

  try {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Order Lok Lak to-go from the Ferry Building', status: 'ACTIVE' },
    });
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { 'X-API-Key': process.env.BACKEND_API_KEY ?? '' },
      body: JSON.stringify({
        user_id: userId,
        event_type: 'agent_started',
        agent_id: agent.id,
      }),
    });
    assertStatus(response.status, 200, response.data);

    const lifecycleTurn = await waitFor(async () => {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      if (session === null) return null;
      const stored = parseSmsSessionMessages(session.messages);
      return stored.find((message) => message.origin === 'agent-lifecycle') ?? null;
    });

    if (lifecycleTurn.role !== 'assistant' || !lifecycleTurn.content.includes(agent.goal)) {
      throw new Error(
        `Expected the agent_started SMS on the supervisor transcript, got ${JSON.stringify(lifecycleTurn)}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export function smsDeliveryBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'session -- concurrent first inbounds create one ordered transcript',
      fn: () => testConcurrentFirstInboundsCreateOneOrderedSession(prisma),
    },
    {
      name: 'grep -- mixed-source pagination metadata stays aligned',
      fn: () => testGrep_fanOutPaginationMetadataAligns(prisma),
    },
    {
      name: 'send -- progress SMS continues to a later substantive result',
      fn: () => testSendUserMessage_continuesUntilSubstantiveResult(prisma),
    },
    {
      name: 'send -- runaway send loop is capped at the per-inbound budget',
      fn: () => testSendBudget_runawaySendLoopIsCappedPerInbound(prisma),
    },
    {
      name: 'lifecycle -- agent-sent SMS lands on the supervisor transcript',
      fn: () => testLifecycleSms_landsOnSupervisorTranscript(prisma),
    },
  ];
}
