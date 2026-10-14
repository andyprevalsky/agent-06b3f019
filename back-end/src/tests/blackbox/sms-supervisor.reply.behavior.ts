import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  appendOutboundSms,
  parseSmsSessionMessages,
  recordInboundSms,
} from '../../providers/smsSupervisor/sessionStore';
import {
  BASE_URL,
  assertStatus,
  captureToken,
  cleanupAgentScopedUser,
  capturedSmsBody,
  findSurgeCallForReply,
  provisionUserWithPhone,
  readCapturesAfter,
  request,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';

export async function testSendUserMessage_rejectsEmojiOnlySms(prisma: PrismaClient) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(probe.status, 200, probe.data);
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-reject-emoji-only');
  const emoji = '👩🏽‍💻';
  const inbound = 'Please say hello in a sentence.';
  const reply = 'Hello! Happy to help 👋🏽';
  try {
    await setFixtureOverride(
      userId,
      JSON.stringify(
        [emoji, reply].map((message) => ({
          reasoning: 'Reject the standalone emoji, then send a substantive greeting with emoji.',
          tool_calls: [
            { tool: 'send_user_message', arguments: { message } },
            { tool: 'attempt_completion', arguments: {} },
          ],
        }))
      )
    );
    const response = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: { body: inbound, conversation: { contact: { phone_number: phone } } },
      }),
    });
    assertStatus(response.status, 200, response.data);
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, reply));
    const stored = await waitFor(async () => {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      const assistants = parseSmsSessionMessages(session?.messages)
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content);
      return assistants.includes(reply) ? assistants : null;
    });
    const sent = (await readCapturesAfter(cursor))
      .filter((call) => call.url.includes('surge.app') && call.url.endsWith('/messages'))
      .map(capturedSmsBody)
      .filter((body) => body?.to === phone)
      .map((body) => body?.body);
    assert.deepEqual(sent, [reply], 'Only the substantive SMS reaches the provider');
    assert.deepEqual(stored, [reply], 'Only the substantive SMS is persisted');
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testSmsQuotedReplies(prisma: PrismaClient) {
  for (const kind of ['current', 'earlier-user', 'earlier-assistant', 'legacy'] as const) {
    const phone = uniqueSmsPhone();
    const userId = await provisionUserWithPhone(prisma, phone);
    const incomingId = `msg_incoming_${userId}`;
    const earlierId = `msg_earlier_${userId}`;
    const earlierText = 'Earlier message\nSecond line 🧑🏽‍🚀';
    const inbound = 'Please reply to this message';
    const answer = 'Here is the answer.';
    const confirmation = 'Finished quote test.';
    const target =
      kind === 'current' ? incomingId : kind === 'legacy' ? 'session-message:1' : earlierId;
    const expected = `Replying to ${kind === 'earlier-assistant' ? 'my' : 'your'} message:\n“${kind === 'current' ? inbound : earlierText}”\n\nHere is the answer.`;
    try {
      if (kind === 'earlier-user') await recordInboundSms(userId, earlierText, earlierId);
      if (kind === 'earlier-assistant') await appendOutboundSms(userId, earlierText, earlierId);
      if (kind === 'legacy')
        await appendOutboundSms(userId, 'An older answer', earlierId, earlierText);
      const quote = {
        tool: 'send_user_message',
        arguments: { message: answer, reply_to_message_id: target },
      };
      await setFixtureOverride(
        userId,
        JSON.stringify([
          {
            reasoning: 'Reply to the selected message.',
            tool_calls: [quote, quote, { tool: 'attempt_completion', arguments: {} }],
          },
          {
            reasoning: 'Finish after the duplicate was rejected.',
            tool_calls: [
              { tool: 'send_user_message', arguments: { message: confirmation } },
              { tool: 'attempt_completion', arguments: {} },
            ],
          },
        ])
      );
      const probe = await request(`${BASE_URL}/api/test/captures`);
      assertStatus(probe.status, 200, probe.data);
      const cursor = (probe.data as { nextId: number }).nextId - 1;
      const response = await request(`${BASE_URL}/api/sms/inbound`, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            id: incomingId,
            body: inbound,
            conversation: { contact: { phone_number: phone } },
          },
        }),
      });
      assertStatus(response.status, 200, response.data);
      await waitFor(() => findSurgeCallForReply('', cursor, phone, confirmation));
      const sent = (await readCapturesAfter(cursor))
        .filter((call) => call.url.includes('surge.app'))
        .map(capturedSmsBody)
        .filter((body) => body?.to === phone)
        .map((body) => body?.body);
      if (JSON.stringify(sent) !== JSON.stringify([expected, confirmation])) {
        throw new Error(
          `Expected one full quote then confirmation for ${kind}; got ${JSON.stringify(sent)}`
        );
      }
      await waitFor(async () => {
        const session = await prisma.smsSession.findUnique({ where: { userId } });
        const stored = parseSmsSessionMessages(session?.messages);
        if (!stored.some((message) => message.content === confirmation)) return null;
        if (
          !stored.some(
            (message) => message.content === inbound && message.providerMessageId === incomingId
          )
        )
          throw new Error('SMS inbound ID was not persisted');
        if (!stored.some((message) => message.role === 'assistant' && message.content === expected))
          throw new Error('Stored SMS must match the actual quoted body');
        return true;
      });
    } finally {
      await cleanupAgentScopedUser(prisma, userId);
    }
  }
}
