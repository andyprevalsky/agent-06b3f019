import type { CompletionMessage } from '../rose';
import { buildSmsContext } from './contextBuilder';
import type { ToolInvocationContext } from './supervisorTools';

export const MAX_TOOL_ROUNDS = 10;

/** Run-local environment injection placed after the newest inbound SMS. */
export function buildEnvironmentToolMessages(
  contextUserMessage: string,
  sequence: number
): CompletionMessage[] {
  const callId = `sms-environment-${sequence}`;
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: 'get_environment', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      content: contextUserMessage,
    },
  ];
}

export async function refreshEnvironmentSnapshot(
  userId: string,
  excludeInboundSeq?: number
): Promise<string> {
  const context = await buildSmsContext(
    userId,
    excludeInboundSeq === undefined ? {} : { excludeInboundSeq }
  );
  return context.contextUserMessage;
}

export function buildToolInvocationContext(params: {
  inboundText: string;
  sessionHistory: CompletionMessage[];
  pendingAttentionRequestIds: string[];
}): ToolInvocationContext {
  return {
    currentUserMessage: params.inboundText || 'The user sent an attachment without text.',
    visibleSessionHistory: params.sessionHistory.flatMap((message) =>
      typeof message.content === 'string' ? [message.content] : []
    ),
    pendingAttentionRequestIds: params.pendingAttentionRequestIds,
  };
}

export async function prepareSmsEnvironment(
  userId: string,
  sequence: number,
  inboundAlreadyPersisted: boolean,
  inboundText: string
) {
  const context = await buildSmsContext(
    userId,
    inboundAlreadyPersisted ? { excludeInboundSeq: sequence } : {}
  );
  return {
    ...context,
    invocationContext: buildToolInvocationContext({
      inboundText,
      sessionHistory: context.sessionHistory,
      pendingAttentionRequestIds: context.pendingAttentionRequestIds,
    }),
  };
}
