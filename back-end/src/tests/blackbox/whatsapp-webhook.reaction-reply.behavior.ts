/** Existing native reaction/reply cases, with the owning suite's unchanged HTTP harness. */
import type { PrismaClient } from '@prisma/client';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  readCapturesAfter,
  setFixtureOverride,
  waitFor,
} from './sms-supervisor.helpers';
import {
  appendOutboundSms,
  recordInboundSms,
  parseSmsSessionMessages,
} from '../../providers/smsSupervisor/sessionStore';
import { buildSmsContext } from '../../providers/smsSupervisor/contextBuilder';

interface WhatsAppReactionReplyHarness {
  BASE_URL: string;
  request: (
    url: string,
    options?: RequestInit
  ) => Promise<{ status: number; data: unknown; headers: Headers }>;
  assertStatus: (actual: number, expected: number, data: unknown) => void;
  assertEqual: (actual: unknown, expected: unknown, label: string) => void;
  uniqueWaNumber: () => string;
  inboundPayload: (from: string, text: string, messageId?: string) => Record<string, unknown>;
}

export function createWhatsAppReactionReplyTests(
  prisma: PrismaClient,
  {
    BASE_URL,
    request,
    assertStatus,
    assertEqual,
    uniqueWaNumber,
    inboundPayload,
  }: WhatsAppReactionReplyHarness
) {
  async function testInbound_reactionPrecedesReply() {
    const wa = uniqueWaNumber();
    const phone = `+${wa}`;
    const messageId = `wamid.reaction.${wa}`;
    const userId = await provisionUserWithPhone(prisma, phone);
    const reply = 'Here is your answer.';
    try {
      await setFixtureOverride(
        userId,
        JSON.stringify({
          reaction_emoji: '👩🏽‍💻',
          reasoning: 'Answer the user.',
          tool_calls: [
            {
              tool: 'send_user_message',
              arguments: { message: reply, reply_to_message_id: messageId },
            },
            { tool: 'attempt_completion', arguments: {} },
          ],
        })
      );
      const probe = await request(`${BASE_URL}/api/test/captures`);
      assertStatus(probe.status, 200, probe.data);
      const cursor = (probe.data as { nextId: number }).nextId - 1;
      const response = await request(`${BASE_URL}/api/whatsapp/webhook`, {
        method: 'POST',
        body: JSON.stringify(inboundPayload(wa, 'hello rose', messageId)),
      });
      assertStatus(response.status, 200, response.data);
      const sent = await waitFor(async () => {
        const bodies = (await readCapturesAfter(cursor))
          .filter((call) => call.url.includes('graph.facebook.com') && call.requestBody !== null)
          .map(
            (call) =>
              JSON.parse(call.requestBody!) as {
                to?: string;
                type?: string;
                reaction?: { message_id?: string; emoji?: string };
                text?: { body?: string };
                context?: { message_id?: string };
              }
          )
          .filter((body) => body.to === wa);
        return bodies.some((body) => body.text?.body === reply) ? bodies : null;
      });
      assertEqual(sent.length, 2, 'one reaction and one reply');
      assertEqual(sent[0].type, 'reaction', 'first outbound is a native reaction');
      assertEqual(sent[0].reaction?.message_id, messageId, 'reaction targets this inbound');
      assertEqual(sent[0].reaction?.emoji, '👩🏽‍💻', 'model-selected compound emoji is preserved');
      assertEqual(sent[1].text?.body, reply, 'answer follows reaction');
      assertEqual(
        sent[1].context?.message_id,
        messageId,
        'answer quotes the selected user message'
      );
    } finally {
      await cleanupAgentScopedUser(prisma, userId);
    }
  }

  async function testInbound_quotesEarlierIncomingAndSentMessages() {
    for (const role of ['user', 'assistant'] as const) {
      const wa = uniqueWaNumber();
      const userId = await provisionUserWithPhone(prisma, `+${wa}`);
      const earlierId = `wamid.earlier.${role}.${wa}`;
      const currentId = `wamid.current.${wa}`;
      const reply = `Reply quoting earlier ${role} message`;
      try {
        if (role === 'user') await recordInboundSms(userId, 'Earlier question', earlierId);
        else await appendOutboundSms(userId, 'Earlier answer', earlierId);
        const context = await buildSmsContext(userId);
        if (!context.contextUserMessage.includes(earlierId))
          throw new Error('Reply target ID missing from agent context');
        await setFixtureOverride(
          userId,
          JSON.stringify({
            reaction_emoji: '🤔',
            reasoning: 'Quote the earlier message.',
            tool_calls: [
              {
                tool: 'send_user_message',
                arguments: { message: reply, reply_to_message_id: earlierId },
              },
              { tool: 'attempt_completion', arguments: {} },
            ],
          })
        );
        const probe = await request(`${BASE_URL}/api/test/captures`);
        assertStatus(probe.status, 200, probe.data);
        const cursor = (probe.data as { nextId: number }).nextId - 1;
        const response = await request(`${BASE_URL}/api/whatsapp/webhook`, {
          method: 'POST',
          body: JSON.stringify(inboundPayload(wa, 'reply to that earlier message', currentId)),
        });
        assertStatus(response.status, 200, response.data);
        const quoted = await waitFor(async () => {
          const bodies = (await readCapturesAfter(cursor))
            .filter((call) => call.url.includes('graph.facebook.com') && call.requestBody !== null)
            .map(
              (call) =>
                JSON.parse(call.requestBody!) as {
                  to?: string;
                  text?: { body?: string };
                  context?: { message_id?: string };
                }
            );
          return bodies.find((body) => body.to === wa && body.text?.body === reply);
        });
        assertEqual(quoted.context?.message_id, earlierId, 'quotes the selected earlier message');
        await waitFor(async () => {
          const session = await prisma.smsSession.findUnique({ where: { userId } });
          const messages = parseSmsSessionMessages(session?.messages);
          return messages.some((message) => message.providerMessageId === currentId) &&
            messages.some((message) => message.content === reply)
            ? true
            : null;
        });
      } finally {
        await cleanupAgentScopedUser(prisma, userId);
      }
    }
  }

  return { testInbound_reactionPrecedesReply, testInbound_quotesEarlierIncomingAndSentMessages };
}
