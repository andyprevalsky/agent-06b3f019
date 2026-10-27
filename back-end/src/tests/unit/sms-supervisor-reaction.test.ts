/** First-action reactions: native WhatsApp delivery, silently swallowed SMS; no live sends. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { CompletionMessage } from '../../providers/rose';
import type { PendingOp } from '../../providers/smsSupervisor/supervisorTools';

async function main(): Promise<void> {
  const events: string[] = [];
  let channel: 'SMS' | 'WHATSAPP' = 'SMS';
  let reactionFails = false;
  let completionOnly = false;
  let cappedMode = '';
  let finalReplyCalls = 0;
  let cancelFinal: (() => void) | undefined;
  let lastInboundSeq = 1;
  const traces: Array<{ tool: string; round: number; success: boolean }> = [];
  let selectedEmoji = '🎉';
  let replyTarget: string | undefined;
  let cancelSelection: (() => void) | undefined;
  const selectionQueue: string[] = [];
  let llmMessages: CompletionMessage[] = [];
  const persisted: string[] = [];

  await mock.module('../../providers/logger', {
    namedExports: {
      createLogger: () => ({
        info: (message: string, data?: { toolTrace?: string }) => {
          if (message.includes('TOOL_TRACE') && data?.toolTrace)
            traces.push(...JSON.parse(data.toolTrace));
        },
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      }),
    },
  });
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: {
        smsSession: { findUnique: async () => ({ lastInboundSeq }) },
      },
    },
  });
  // Cross-instance locking is covered by multi-instance.blackbox.ts; here the
  // commit lock only needs to run its critical section.
  await mock.module('../../providers/sharedState', {
    namedExports: {
      withSerializedLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
    },
  });
  await mock.module('../../providers/rose', {
    namedExports: {
      markCacheable: (content: string) => ({ role: 'system', content }),
    },
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
        return {
          success:
            (!reactionFails || body !== selectedEmoji) &&
            !(cappedMode === 'delivery-failed' && body.startsWith('The store')),
          messageSid: 'sent-id',
        };
      },
    },
  });
  await mock.module('../../providers/whatsappCloud', {
    namedExports: {
      sendWhatsAppReaction: async (_phone: string, messageId: string, emoji: string) => {
        events.push(`react:${messageId}:${emoji}`);
        return {
          success: !reactionFails,
          error: reactionFails ? 'provider rejected' : undefined,
        };
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
      commitPendingWrites: async (operations: PendingOp[]) =>
        operations.map((operation) => {
          events.push(`commit:${operation.kind}`);
          return {
            tool: operation.kind,
            success: cappedMode !== 'queued-failure',
            result: '',
            ...(cappedMode === 'queued-failure' ? { error: 'fixture write failed' } : {}),
          };
        }),
      dispatchToolCall: async ({ tool }: { tool: string }, _user: string, pending: PendingOp[]) => {
        events.push(`tool:${tool}`);
        if (tool === 'kill_agent')
          pending.push({
            kind: 'kill_agent',
            args: { agent_id_or_prefix: 'queued-agent' },
            agentId: 'queued-agent',
          });
        return {
          tool,
          success: true,
          result: cappedMode
            ? 'Store is TEMPORARILY CLOSED and not accepting pickup orders.'
            : 'done',
        };
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
          cancelSelection?.();
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
        if (cappedMode) {
          const finalInstruction = messages.some(
            (message) =>
              message.role === 'tool' &&
              String(message.content).includes('maximum number of tool-calling rounds')
          );
          if (!finalInstruction)
            return {
              reasoning: '',
              tool_calls: [
                {
                  tool:
                    cappedMode.startsWith('queued-') &&
                    events.filter((event) => event === 'llm').length === 10
                      ? 'kill_agent'
                      : 'web_search',
                  arguments: { query: 'pickup' },
                  id: `search-${events.filter((event) => event === 'llm').length}`,
                },
              ],
            };
          finalReplyCalls += 1;
          assert.equal(
            messages.filter(
              (message) =>
                message.role === 'tool' &&
                String(message.content).includes('Store is TEMPORARILY CLOSED')
            ).length,
            10,
            'final response retains every actual work result'
          );
          cancelFinal?.();
          if (cappedMode === 'superseded') lastInboundSeq = 2;
          if (cappedMode === 'empty-final') return { reasoning: '', tool_calls: [] };
          if (cappedMode === 'completion-only')
            return { reasoning: '', tool_calls: [{ tool: 'attempt_completion', arguments: {} }] };
          return {
            reasoning: '',
            tool_calls:
              cappedMode === 'more-work'
                ? [
                    {
                      tool: 'start_new_agent',
                      arguments: { goal: 'unrequested extra work' },
                    },
                  ]
                : [
                    {
                      tool: 'send_user_message',
                      arguments: {
                        message: 'The store is closed, so I could not place your pickup order.',
                      },
                      id: 'final-send',
                    },
                    ...(cappedMode === 'multiple-replies'
                      ? [
                          {
                            tool: 'send_user_message',
                            arguments: { message: 'A duplicate final reply.' },
                          },
                        ]
                      : []),
                    {
                      tool: 'attempt_completion',
                      arguments: {},
                      id: 'final-stop',
                    },
                  ],
          };
        }
        return {
          reasoning: '',
          tool_calls: completionOnly
            ? [{ tool: 'attempt_completion', arguments: {} }]
            : [
                { tool: 'grep', arguments: { pattern: 'hello' } },
                {
                  tool: 'send_user_message',
                  arguments: {
                    message: 'Here is the answer.',
                    reply_to_message_id: replyTarget,
                  },
                },
                { tool: 'attempt_completion', arguments: {} },
              ],
        };
      },
    },
  });
  const { handleSmsSupervisorMessage, SUPERVISOR_FALLBACK_MESSAGE } =
    await import('../../providers/smsSupervisor/supervisorHandler');

  const { reactToInboundMessage } = await import('../../providers/smsSupervisor/inboundReaction');
  for (const mode of ['already-aborted', 'abort-throw', 'abort-success'] as const) {
    const controller = new AbortController();
    if (mode === 'already-aborted') controller.abort(new Error('cancelled fixture'));
    cancelSelection = () => {
      controller.abort(new Error('cancelled fixture'));
      if (mode === 'abort-throw') throw new Error('selection failed after cancellation');
    };
    events.length = 0;
    persisted.length = 0;
    const reaction = await reactToInboundMessage({
      userId: 'reaction-test',
      phoneNumber: '+15551234567',
      inboundMessage: 'hello',
      inboundMessageId: 'wamid.INBOUND',
      mySeq: 1,
      channel: 'WHATSAPP',
      abortSignal: controller.signal,
    });
    assert.ok(reaction);
    assert.equal(
      events.filter((event) => event === 'choose-emoji').length,
      mode === 'already-aborted' ? 0 : 1
    );
    assert.equal(reaction.toolCall.tool, 'react_to_message');
    assert.equal(reaction.result.success, false);
    assert.equal(reaction.messages[0].tool_calls?.[0].function?.name, 'react_to_message');
    assert.equal(JSON.parse(String(reaction.messages[1].content)).success, false);
    assert.equal(
      events.some((event) => event.startsWith('react:') || event.startsWith('send:')),
      false
    );
    assert.deepEqual(persisted, []);
  }
  cancelSelection = undefined;

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
        assert.ok(firstTool.function);
        assert.equal(typeof firstTool.function.arguments, 'string');
        assert.equal(firstTool.function.name, 'react_to_message');
        assert.equal(JSON.parse(String(firstTool.function.arguments)).emoji, selectedEmoji);
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
    assert.ok(firstTool.function);
    assert.equal(typeof firstTool.function.arguments, 'string');
    assert.equal(firstTool.function.name, 'react_to_message');
    assert.equal(JSON.parse(String(firstTool.function.arguments)).emoji, selectedEmoji);
    const feedback = llmMessages.find((message) => message.tool_call_id === firstTool.id);
    assert.ok(feedback);
    const reactionFeedback = JSON.parse(String(feedback.content));
    assert.equal(reactionFeedback.success, true);
    assert.deepEqual(JSON.parse(reactionFeedback.result), {
      skipped: true,
      delivered: false,
    });
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
  completionOnly = false;
  channel = 'SMS';
  for (const mode of [
    'final-answer',
    'more-work',
    'multiple-replies',
    'cancelled',
    'queued-success',
    'queued-failure',
    'superseded',
    'guard-denied',
    'delivery-failed',
    'empty-final',
    'completion-only',
  ]) {
    cappedMode = mode;
    events.length = 0;
    persisted.length = 0;
    finalReplyCalls = 0;
    lastInboundSeq = 1;
    traces.length = 0;
    const controller = new AbortController();
    cancelFinal = mode === 'cancelled' ? () => controller.abort() : undefined;
    const result = await handleSmsSupervisorMessage({
      userId: 'reaction-test',
      phoneNumber: '+15551234567',
      inboundMessage: 'hello',
      mySeq: 1,
      inboundAlreadyPersisted: true,
      channel,
      abortSignal: controller.signal,
      commitGuard: async () => !(mode === 'guard-denied' && finalReplyCalls > 0),
    });
    assert.equal(
      finalReplyCalls,
      1,
      `${mode}: one contextual final response opportunity after the cap`
    );
    assert.equal(
      events.filter((event) => event === 'llm').length,
      11,
      'ten work rounds plus one bounded final response'
    );
    assert.equal(
      events.filter((event) => event === 'tool:web_search').length,
      mode.startsWith('queued-') ? 9 : 10,
      'the final response cannot execute extra work'
    );
    assert.equal(events.includes('tool:start_new_agent'), false);
    if (mode.startsWith('queued-')) {
      assert.equal(
        events.filter((event) => event === 'commit:kill_agent').length,
        1,
        'previously queued work commits once through the existing gate'
      );
    }
    if (mode === 'more-work' || mode === 'multiple-replies') {
      const rejected = traces.filter((entry) => entry.round === 10);
      assert.equal(rejected.length, mode === 'more-work' ? 1 : 3);
      assert.ok(
        rejected.every((entry) => !entry.success),
        'rejected final calls remain auditable'
      );
    }
    if (mode === 'final-answer' || mode === 'queued-success') {
      assert.equal(
        result.responseText,
        'The store is closed, so I could not place your pickup order.'
      );
      assert.deepEqual(persisted, [result.responseText]);
      assert.ok(result.toolsExecuted.includes('send_user_message'));
    } else if (['cancelled', 'superseded', 'guard-denied'].includes(mode)) {
      assert.equal(result.committed, false);
      assert.deepEqual(persisted, []);
    } else if (mode === 'queued-failure') {
      assert.ok(result.responseText.includes('fixture write failed'));
      assert.ok(!result.responseText.includes('The store is closed'));
      assert.deepEqual(persisted, [result.responseText]);
    } else {
      assert.equal(result.responseText, SUPERVISOR_FALLBACK_MESSAGE);
      assert.deepEqual(persisted, [SUPERVISOR_FALLBACK_MESSAGE]);
    }
  }
  process.stdout.write(
    'PASS existing reaction cases and bounded contextual cap response, queued writes, rejection traces, ownership guards and failure boundaries\n'
  );
}

void main();
