import {
  testSendUserMessage_rejectsEmojiOnlySms,
  testSmsQuotedReplies,
} from './sms-supervisor.reply.behavior';
import type { PrismaClient } from '@prisma/client';
import { SMS_SURFACE_OVERLAY } from '../../providers/smsSupervisor/contextBuilder';
import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';

import {
  testGrep_fanOutPaginationMetadataAligns,
  testGrep_priorAgentTrajectoryFromSms,
  testGrep_smsRunsTheSharedGrepTool,
} from './sms-supervisor.grep.behavior';
import {
  appendLifecycleSms,
  appendOutboundSms,
  fetchSessionMessagesSince,
  parseSmsSessionMessages,
  recordInboundSms,
} from '../../providers/smsSupervisor/sessionStore';
import {
  BASE_URL,
  assertStatus,
  captureToken,
  cleanupAgentScopedUser,
  cleanupSessionScopedUser,
  capturedSmsBody,
  findSurgeCallForReply,
  provisionUserWithPhone,
  readCapturesAfter,
  request,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';

/**
 * A catch-up watermark guaranteed to be strictly older than any later write.
 *
 * Session timestamps are stored at millisecond precision and compared with a
 * strict `>` so an already-delivered message is never replayed. A test that
 * takes `new Date().toISOString()` and then writes within the SAME millisecond
 * races itself: the write ties the watermark and is filtered out as "already
 * seen", which fails intermittently on a fast machine.
 *
 * Read the watermark from Postgres rather than the Node host clock. Coverage
 * runs use a Dockerized database whose clock can trail the host by a few
 * milliseconds; sleeping on the host does not establish an ordering between
 * those two clocks. Subtracting one stored-precision tick on the same database
 * clock makes the next database write strictly newer without weakening the
 * ISO-format comparison this test exists to pin.
 */
async function watermarkStrictlyBeforeNextWrite(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ watermark: string }>>`
    SELECT to_char(
      (clock_timestamp() - INTERVAL '1 millisecond') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS watermark
  `;
  const watermark = rows[0]?.watermark;
  if (watermark === undefined) throw new Error('Failed to read the database catch-up watermark');
  return watermark;
}

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
        `Expected only progress then substantive result in one run, got ${JSON.stringify(assistantMessages)}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testSendUserMessage_identicalBodyNotResent(prisma: PrismaClient) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  if (probe.status !== 200) return;
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-identical-body-dedup');
  const reply = 'I could not find that file. Send the exact Drive folder name.';

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify({
        reasoning: 'Repeat the same SMS four times in one response.',
        tool_calls: [
          { tool: 'send_user_message', arguments: { message: reply } },
          { tool: 'send_user_message', arguments: { message: reply } },
          { tool: 'send_user_message', arguments: { message: reply } },
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
          body: 'In gdrive',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(response.status, 200, response.data);
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, reply));
    const delivered = (await readCapturesAfter(cursor)).filter((call) => {
      if (!call.url.includes('surge.app') || !call.url.endsWith('/messages')) {
        return false;
      }
      const body = capturedSmsBody(call);
      return body?.to === phone && body?.body === reply;
    });
    if (delivered.length !== 1) {
      throw new Error(
        `Identical send_user_message bodies must deliver once, got ${String(delivered.length)}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export function testSmsMessageLimit_isTaughtOnEverySupervisorPromptSurface() {
  const sendTool = TOOL_SCHEMAS.find((tool) => tool.name === 'send_user_message');
  const contracts = [
    SMS_SURFACE_OVERLAY,
    JSON.stringify(sendTool),
    JSON.stringify(SUPERVISOR_RESPONSE_SCHEMA),
  ];
  for (const contract of contracts) {
    if (
      !contract.includes('at most 1600 characters') ||
      !contract.includes('spaces, line breaks, and URLs') ||
      !contract.includes('actual delivery error') ||
      !contract.includes('do not claim delivery until the send succeeds')
    ) {
      throw new Error(
        'SMS supervisor prompt and send schemas must teach the full-body 1600-character limit and delivery-error correction'
      );
    }
  }
}

export async function testSendUserMessage_rejectedBodyFeedsErrorToNextModelRound(
  prisma: PrismaClient
) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(probe.status, 200, probe.data);
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-oversize-correction');
  const url = 'https://www.roselabs.ai/';
  const rejected = `The report is ready. ${'Detailed report. '.repeat(110)}\n${url}`;
  const corrected = `The report is ready. Read the details: ${url}`;

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify([
        {
          reasoning: 'send the report and request completion',
          tool_calls: [
            { tool: 'send_user_message', arguments: { message: rejected } },
            { tool: 'attempt_completion', arguments: {} },
          ],
        },
        {
          expected_tool_result_substrings: [
            '[send_user_message] ERROR:',
            'should be at most 1600 character(s)',
            'Rejected: this run has not successfully called send_user_message',
          ],
          reasoning: 'the provider rejected the oversized report; shorten it and preserve the link',
          tool_calls: [
            { tool: 'send_user_message', arguments: { message: corrected } },
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
          body: 'Please send me the report.',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(response.status, 200, response.data);
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, corrected));
    const session = await waitFor(async () => {
      const stored = await prisma.smsSession.findUnique({ where: { userId } });
      if (stored === null) return null;
      const messages = parseSmsSessionMessages(stored.messages);
      return messages.some(
        (message) => message.role === 'assistant' && message.content === corrected
      )
        ? messages
        : null;
    });
    const sent = session
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content);
    if (sent.length !== 1 || sent[0] !== corrected) {
      throw new Error(
        `Only the corrected successfully delivered SMS belongs in the transcript: ${JSON.stringify(sent)}`
      );
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
    // Only messaging-touched agents send a kickoff; this one was started over SMS.
    const agent = await prisma.agent.create({
      data: {
        userId,
        goal: 'Order Lok Lak to-go from the Ferry Building',
        status: 'ACTIVE',
        source: 'SMS',
      },
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
  const watermark = await watermarkStrictlyBeforeNextWrite(prisma);

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
  const watermark = await watermarkStrictlyBeforeNextWrite(prisma);

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
      name: 'send -- SMS quotes current, earlier, sent, and legacy messages once',
      fn: () => testSmsQuotedReplies(prisma),
    },
    {
      name: 'send -- prompt and schemas teach complete-body SMS limit and correction',
      fn: async () => testSmsMessageLimit_isTaughtOnEverySupervisorPromptSurface(),
    },
    {
      name: 'send -- rejected oversized SMS feeds the provider error into the next model round',
      fn: () => testSendUserMessage_rejectedBodyFeedsErrorToNextModelRound(prisma),
    },
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
      name: 'grep -- SMS supervisor runs the shared grep tool',
      fn: () => testGrep_smsRunsTheSharedGrepTool(prisma),
    },
    {
      name: 'grep -- SMS supervisor can retrieve a prior agent trajectory',
      fn: () => testGrep_priorAgentTrajectoryFromSms(prisma),
    },
    {
      name: 'send -- progress SMS continues to a later substantive result',
      fn: () => testSendUserMessage_continuesUntilSubstantiveResult(prisma),
    },
    {
      name: 'send -- emoji-only SMS is rejected, substantive text with emoji is allowed',
      fn: () => testSendUserMessage_rejectsEmojiOnlySms(prisma),
    },
    {
      name: 'send -- identical send_user_message body is delivered once',
      fn: () => testSendUserMessage_identicalBodyNotResent(prisma),
    },
    {
      name: 'lifecycle -- agent-sent SMS lands on the supervisor transcript',
      fn: () => testLifecycleSms_landsOnSupervisorTranscript(prisma),
    },
  ];
}
