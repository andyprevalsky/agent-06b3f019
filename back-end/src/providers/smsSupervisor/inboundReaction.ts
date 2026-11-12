/**
 * Inbound -> react_to_message -> media/environment -> model tools -> reply.
 *
 * The model chooses an emoji; the runtime executes this before any other tool.
 * WhatsApp attaches it natively; SMS silently discards the reaction attempt.
 * A reaction never satisfies the supervisor's substantive-reply gate.
 */
import type { CompletionMessage } from '../rose';
import { isLinqEnabled, sendLinqReaction } from '../linq';
import { sendWhatsAppReaction } from '../whatsappCloud';
import type { SupervisorChannel } from './channelDelivery';
import { callWithRetries, dispatchToolSafely } from './supervisorResilience';
import type { ToolCall } from './supervisorTools';
import { callSupervisorLlm } from './supervisorLlm';
import type { SupervisorComputeToken } from './supervisorComputeToken';
import { isSingleEmoji } from './emoji';

export { isSingleEmoji } from './emoji';

export async function reactToInboundMessage(
  config: {
    userId: string;
    phoneNumber: string;
    channel?: SupervisorChannel;
    inboundMessageId?: string;
    inboundMessage: string;
    inboundAlreadyPersisted?: boolean;
    mySeq: number;
    trigger?: 'inbound' | 'scheduled';
    abortSignal?: AbortSignal;
  },
  computeToken: SupervisorComputeToken | null = null
) {
  if (config.trigger === 'scheduled') return null;
  const toolCall: ToolCall = {
    tool: 'react_to_message',
    arguments: {},
  };
  const result = await dispatchToolSafely(toolCall.tool, async () => {
    const emoji = await callWithRetries(
      async () => {
        const response = await callSupervisorLlm(
          [
            {
              role: 'system',
              content:
                'Choose one emoji reaction that fits the meaning and emotional tone of the incoming message. You may choose any Unicode emoji, including compound emoji, flags, and skin tones. Return exactly one react_to_message call. Do not answer the message or call other tools. For a media-only message, acknowledge receipt without pretending to understand unseen media.',
            },
            {
              role: 'user',
              content: config.inboundMessage || 'The user sent an attachment without text.',
            },
          ],
          computeToken,
          config.userId,
          true
        );
        const selected = response.tool_calls[0]?.arguments.emoji;
        if (
          response.tool_calls.length !== 1 ||
          response.tool_calls[0].tool !== toolCall.tool ||
          !isSingleEmoji(selected)
        ) {
          throw new Error(
            'Reaction selection must return exactly one react_to_message call with a single Unicode emoji'
          );
        }
        return selected;
      },
      { attempts: 3, baseDelayMs: 400, signal: config.abortSignal }
    );
    toolCall.arguments = { emoji };
    if (config.abortSignal?.aborted) {
      throw config.abortSignal.reason ?? new Error('Reaction selection aborted');
    }
    if (config.channel !== 'WHATSAPP' && !isLinqEnabled(config.phoneNumber)) {
      return {
        tool: toolCall.tool,
        success: true,
        result: JSON.stringify({ skipped: true, delivered: false }),
      };
    }
    const delivery =
      config.channel === 'WHATSAPP'
        ? await sendWhatsAppReaction(config.phoneNumber, config.inboundMessageId ?? '', emoji)
        : await sendLinqReaction(config.inboundMessageId ?? '', emoji);
    if (!delivery.success) {
      return {
        tool: toolCall.tool,
        success: false,
        result: '',
        error: delivery.error ?? 'Reaction delivery failed',
      };
    }
    return {
      tool: toolCall.tool,
      success: true,
      result: `Added ${emoji} reaction to the incoming message`,
    };
  });
  const callId = `sms-inbound-reaction-${config.mySeq}`;
  const messages: CompletionMessage[] = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: toolCall.tool, arguments: JSON.stringify(toolCall.arguments) },
        },
      ],
    },
    { role: 'tool', tool_call_id: callId, content: JSON.stringify(result) },
  ];
  return { toolCall, result, messages };
}
