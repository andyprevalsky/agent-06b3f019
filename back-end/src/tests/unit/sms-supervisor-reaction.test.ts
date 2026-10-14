/** First-action reactions: native WhatsApp delivery, silently swallowed SMS; no live sends. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { CompletionMessage } from '../../providers/rose';

async function main(): Promise<void> {
  const events: string[] = [];
  let channel: 'SMS' | 'WHATSAPP' = 'SMS';
  let reactionFails = false;
  let completionOnly = false;
  let selectedEmoji = '🎉';
  let replyTarget: string | undefined;
  const selectionQueue: string[] = [];
  let llmMessages: CompletionMessage[] = [];
  const persisted: string[] = [];

  await mock.module('../../providers/database', {
    namedExports: { prisma: { smsSession: { findUnique: async () => ({ lastInboundSeq: 1 }) } } },
  });
  await mock.module('../../providers/rose', {
    namedExports: { markCacheable: (content: string) => ({ role: 'system', content }) },
  });
  await mock.module('../../providers/smsSupervisor/channelDelivery', {
    namedExports: {
      sendOnChannel: async (
        _channel: string,
        _phone: string,
        body: string,
        options?: { replyToMessageId?: string }
      ) => {
        events.push(`send:${body}`);
        assert.equal(_channel, channel);
        if (body === 'Here is the answer.') assert.equal(options?.replyToMessageId, replyTarget);
        return { success: !reactionFails || body !== selectedEmoji, messageSid: 'sent-id' };
      },
    },
  });
  await mock.module('../../providers/whatsappCloud', {
    namedExports: {
      sendWhatsAppReaction: async (_phone: string, messageId: string, emoji: string) => {
        events.push(`react:${messageId}:${emoji}`);
        return { success: !reactionFails, error: reactionFails ? 'provider rejected' : undefined };
      },
    },
  });
  await mock.module('../../providers/smsSupervisor/sessionStore', {
    namedExports: {
      appendOutboundSms: async (_user: string, body: string) => {
        persisted.push(body);
      },
      fetchSessionMessagesSince: async () => [],
    },
  });
  await mock.module('../../providers/smsSupervisor/inboundMedia', {
    namedExports: {
      processInboundAttachments: async () => {
        events.push('media');
        return { imageBlocks: [], noteLines: [], filePointers: [] };
      },
    },
  });
  await mock.module('../../providers/smsSupervisor/supervisorComputeToken', {
    namedExports: { getComputeToken: async () => null },
  });
  await mock.module('../../providers/smsSupervisor/supervisorTools', {
    namedExports: {
      commitPendingWrites: async () => [],
      dispatchToolCall: async ({ tool }: { tool: string }) => {
        events.push(`tool:${tool}`);
        return { tool, success: true, result: 'done' };
      },
    },
  });
  await mock.module('../../providers/smsSupervisor/contextBuilder', {
    namedExports: {
      buildSmsContext: async () => {
        events.push('context');
        return {
          systemPrompt: 'system',
          contextUserMessage: 'environment',
          sessionHistory: [],
          pendingAttentionRequestIds: [],
        };
      },
    },
  });
  await mock.module('../../providers/smsSupervisor/supervisorLlm', {
    namedExports: {
      finalizeSupervisorResponse: () => undefined,
      callSupervisorLlm: async (
        messages: CompletionMessage[],
        _token: unknown,
        _userId: string,
        reactionOnly = false
      ) => {
        if (reactionOnly) {
          events.push('choose-emoji');
          assert.ok(String(messages.at(-1)?.content).includes('hello'));
          return {
            reasoning: '',
            tool_calls: [
              {
                tool: 'react_to_message',
                arguments: { emoji: selectionQueue.shift() ?? selectedEmoji },
              },
            ],
          };
        }
        events.push('llm');
        llmMessages = [...messages];
        return {
          reasoning: '',
          tool_calls: completionOnly
            ? [{ tool: 'attempt_completion', arguments: {} }]
            : [
                { tool: 'grep', arguments: { pattern: 'hello' } },
                {
                  tool: 'send_user_message',
                  arguments: { message: 'Here is the answer.', reply_to_message_id: replyTarget },
                },
                { tool: 'attempt_completion', arguments: {} },
              ],
        };
      },
    },
  });
  const { handleSmsSupervisorMessage, SUPERVISOR_FALLBACK_MESSAGE } =
    await import('../../providers/smsSupervisor/supervisorHandler');

  for (channel of ['WHATSAPP'] as const) {
    for (selectedEmoji of ['🎉', '😢', '🙏🏽', '👩🏽‍💻', '🇯🇵', '1️⃣', '\u{1FAF9}🏽', '\u{1FAFA}🏿']) {
      for (reactionFails of [false, true]) {
        events.length = 0;
        persisted.length = 0;
        const result = await handleSmsSupervisorMessage({
          userId: 'reaction-test',
          phoneNumber: '+15551234567',
          inboundMessage: 'hello',
          inboundMessageId: 'wamid.INBOUND',
          mySeq: 1,
          inboundAlreadyPersisted: true,
          channel,
          attachments: [{ url: 'https://example.com/image.jpg', type: 'image/jpeg' }],
        });
        assert.equal(events[0], 'choose-emoji');
        assert.equal(events[1], `react:wamid.INBOUND:${selectedEmoji}`);
        assert.equal(result.toolsExecuted[0], 'react_to_message');
        assert.equal(events.filter((event) => event === events[0]).length, 1);
        assert.ok(events.indexOf('llm') > events.indexOf('media'));
        assert.equal(result.responseText, 'Here is the answer.');
        assert.equal(result.committed, true);
        assert.deepEqual(persisted, ['Here is the answer.']);
        assert.equal(
          events.some((event) => event === `send:${selectedEmoji}`),
          false
        );
        const firstTool = llmMessages.flatMap((message) => message.tool_calls ?? [])[0];
        assert.equal(firstTool.function.name, 'react_to_message');
        assert.equal(JSON.parse(firstTool.function.arguments).emoji, selectedEmoji);
        const feedback = llmMessages.find((message) => message.tool_call_id === firstTool.id);
        assert.ok(feedback);
        assert.equal(JSON.parse(String(feedback.content)).success, !reactionFails);
      }
    }
  }

  channel = 'WHATSAPP';
  reactionFails = false;
  replyTarget = 'wamid.INBOUND';
  selectedEmoji = '❤️';
  selectionQueue.push('not an emoji', selectedEmoji);
  events.length = 0;
  const quoted = await handleSmsSupervisorMessage({
    userId: 'reaction-test',
    phoneNumber: '+15551234567',
    inboundMessage: 'hello',
    inboundMessageId: replyTarget,
    mySeq: 1,
    channel,
    inboundAlreadyPersisted: true,
  });
  assert.equal(events.filter((event) => event === 'choose-emoji').length, 2);
  assert.equal(quoted.responseText, 'Here is the answer.');
  assert.equal(events.filter((event) => event.startsWith('react:')).length, 1);
  replyTarget = undefined;
  selectedEmoji = 'not an emoji';
  events.length = 0;
  const noSelection = await handleSmsSupervisorMessage({
    userId: 'reaction-test',
    phoneNumber: '+15551234567',
    inboundMessage: 'hello',
    inboundMessageId: 'wamid.INBOUND',
    mySeq: 1,
    channel,
    inboundAlreadyPersisted: true,
  });
  assert.equal(events.filter((event) => event === 'choose-emoji').length, 3);
  assert.equal(
    events.some((event) => event.startsWith('react:')),
    false,
    'no invented default emoji'
  );
  assert.equal(noSelection.responseText, 'Here is the answer.');
  selectedEmoji = '🎉';
  channel = 'SMS';
  for (const smsChannel of ['SMS', undefined] as const) {
    events.length = 0;
    persisted.length = 0;
    const sms = await handleSmsSupervisorMessage({
      userId: 'reaction-test',
      phoneNumber: '+15551234567',
      inboundMessage: 'hello',
      inboundMessageId: 'sms.INBOUND',
      mySeq: 1,
      inboundAlreadyPersisted: true,
      channel: smsChannel,
      attachments: [{ url: 'https://example.com/image.jpg', type: 'image/jpeg' }],
    });
    assert.equal(events[0], 'choose-emoji', 'SMS selects the reaction before other work');
    assert.equal(events.filter((event) => event === 'choose-emoji').length, 1);
    assert.deepEqual(
      events.slice(0, events.indexOf('media')),
      ['choose-emoji'],
      'SMS reaction performs no send before media processing'
    );
    assert.ok(events.indexOf('media') < events.indexOf('context'));
    assert.ok(events.indexOf('context') < events.indexOf('llm'));
    assert.equal(
      events.some((event) => event.startsWith('react:')),
      false
    );
    assert.equal(events.includes(`send:${selectedEmoji}`), false, 'never texts an emoji fallback');
    assert.equal(sms.toolsExecuted[0], 'react_to_message');
    assert.deepEqual(persisted, ['Here is the answer.']);
    assert.equal(sms.responseText, 'Here is the answer.');
    assert.equal(sms.committed, true);
    const firstTool = llmMessages.flatMap((message) => message.tool_calls ?? [])[0];
    assert.equal(firstTool.function.name, 'react_to_message');
    assert.equal(JSON.parse(firstTool.function.arguments).emoji, selectedEmoji);
    const feedback = llmMessages.find((message) => message.tool_call_id === firstTool.id);
    assert.ok(feedback);
    const reactionFeedback = JSON.parse(String(feedback.content));
    assert.equal(reactionFeedback.success, true);
    assert.deepEqual(JSON.parse(reactionFeedback.result), { skipped: true, delivered: false });
  }
  events.length = 0;
  const proactive = await handleSmsSupervisorMessage({
    userId: 'reaction-test',
    phoneNumber: '+15551234567',
    inboundMessage: 'Scheduled outreach',
    mySeq: 1,
    channel: 'SMS',
    trigger: 'scheduled',
  });
  assert.equal(
    events.some(
      (event) =>
        event === 'choose-emoji' || event === `send:${selectedEmoji}` || event.startsWith('react:')
    ),
    false
  );
  assert.equal(proactive.toolsExecuted.includes('react_to_message'), false);

  completionOnly = true;
  reactionFails = false;
  for (channel of ['SMS', 'WHATSAPP'] as const) {
    events.length = 0;
    persisted.length = 0;
    const result = await handleSmsSupervisorMessage({
      userId: 'reaction-test',
      phoneNumber: '+15551234567',
      inboundMessage: 'hello',
      inboundMessageId: 'wamid.INBOUND',
      mySeq: 1,
      inboundAlreadyPersisted: true,
      channel,
    });
    assert.equal(events[0], 'choose-emoji');
    assert.equal(result.toolsExecuted[0], 'react_to_message');
    assert.equal(
      result.responseText,
      SUPERVISOR_FALLBACK_MESSAGE,
      `${channel} reaction cannot satisfy the substantive reply requirement`
    );
    assert.equal(result.committed, true);
    assert.deepEqual(persisted, [SUPERVISOR_FALLBACK_MESSAGE]);
    assert.deepEqual(
      events.filter((event) => event.startsWith('send:')),
      [`send:${SUPERVISOR_FALLBACK_MESSAGE}`],
      'only the substantive fallback is sent'
    );
    assert.equal(
      events.filter((event) => event.startsWith('react:')).length,
      channel === 'WHATSAPP' ? 1 : 0
    );
  }
  process.stdout.write(
    'PASS first reaction ordering, swallowed SMS delivery, and substantive reply requirement\n'
  );
}

void main();
