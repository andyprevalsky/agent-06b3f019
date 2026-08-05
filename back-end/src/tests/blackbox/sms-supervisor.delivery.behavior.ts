import type { PrismaClient } from '@prisma/client';

import { grep as userDataGrep } from '../../domains/data/service';
import { executeGrepTool } from '../../providers/smsSupervisor/supervisorTools.grep';
import {
  appendLifecycleSms,
  appendOutboundSms,
  fetchSessionMessagesSince,
  parseSmsSessionMessages,
  recordInboundSms,
} from '../../providers/smsSupervisor/sessionStore';
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

/**
 * The catch-up poll must actually SEE a lifecycle SMS written by the database.
 *
 * This has to round-trip real Postgres. The defect it pins was a disagreement
 * between the writer's format and the reader's comparison — `NOW()::text` gives
 * `2026-08-05 03:09:02.185+00`, whose space at index 10 sorts BEFORE the `T` of
 * a `Date.toISOString()` watermark, so every stored message compared as older
 * than the watermark and the poll returned nothing on every round. A test that
 * fabricates its own timestamps agrees with itself and passes while production
 * returns zero — which is exactly how this shipped through every gate.
 */
export async function testCatchUp_lifecycleSmsIsVisibleToAnIsoWatermark(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const watermark = new Date().toISOString();

  try {
    await appendLifecycleSms(userId, 'Started: Order Lok Lak to-go', 'provider-catchup-1');

    const since = await fetchSessionMessagesSince(userId, watermark);
    if (since.length !== 1) {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      const stored = session === null ? [] : parseSmsSessionMessages(session.messages);
      throw new Error(
        `Expected the lifecycle SMS to be visible to an ISO watermark, got ${since.length}. ` +
          `watermark=${watermark} stored=${JSON.stringify(stored.map((m) => m.timestamp))}`
      );
    }
    if (since[0].content !== 'Started: Order Lok Lak to-go') {
      throw new Error(`Unexpected catch-up content: ${JSON.stringify(since[0])}`);
    }
    // The stored format must be directly comparable to a JS ISO watermark.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(since[0].timestamp)) {
      throw new Error(
        `Session timestamps must be canonical UTC ISO, got ${JSON.stringify(since[0].timestamp)}`
      );
    }
  } finally {
    await cleanupSessionScopedUser(prisma, userId);
  }
}

/**
 * Catch-up must never replay the user's own inbound, or the supervisor's send.
 *
 * `appendOutboundSms` re-stores the triggering inbound under a fresh timestamp.
 * An unscoped poll therefore hands the run a second copy of the message it is
 * already answering — a duplicate `user` turn that invites a second reply to an
 * already-answered text. That is the precise production symptom this feature
 * exists to prevent, so it gets pinned rather than assumed.
 */
export async function testCatchUp_neverReplaysTheInboundEchoOrOwnSend(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const watermark = new Date().toISOString();

  try {
    // The supervisor answers the inbound: this re-stores the user turn AND the
    // assistant reply, both after the watermark.
    await appendOutboundSms(userId, 'On it - ordering now.', 'provider-echo-1', 'order me dinner');
    // An agent then reports its own progress straight to the phone.
    await appendLifecycleSms(userId, 'Started: Order Lok Lak to-go', 'provider-echo-2');

    const since = await fetchSessionMessagesSince(userId, watermark);
    const roles = since.map((message) => message.role);
    const contents = since.map((message) => message.content);

    if (roles.includes('user')) {
      throw new Error(
        `Catch-up replayed a user turn — the run would answer the same text twice: ${JSON.stringify(contents)}`
      );
    }
    if (contents.includes('On it - ordering now.')) {
      throw new Error(
        `Catch-up replayed the supervisor's own send, already in its context: ${JSON.stringify(contents)}`
      );
    }
    if (since.length !== 1 || contents[0] !== 'Started: Order Lok Lak to-go') {
      throw new Error(`Expected only the agent lifecycle turn, got ${JSON.stringify(contents)}`);
    }
  } finally {
    await cleanupSessionScopedUser(prisma, userId);
  }
}

export function smsDeliveryBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'catch-up -- a lifecycle SMS is visible to an ISO watermark',
      fn: () => testCatchUp_lifecycleSmsIsVisibleToAnIsoWatermark(prisma),
    },
    {
      name: 'catch-up -- never replays the inbound echo or the supervisor own send',
      fn: () => testCatchUp_neverReplaysTheInboundEchoOrOwnSend(prisma),
    },
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
      name: 'lifecycle -- agent-sent SMS lands on the supervisor transcript',
      fn: () => testLifecycleSms_landsOnSupervisorTranscript(prisma),
    },
  ];
}
