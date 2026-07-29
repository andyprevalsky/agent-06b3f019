import type { CompletionMessage } from '../rose';
import { buildSmsContext } from './contextBuilder';
import type { ToolInvocationContext } from './supervisorTools';

export const MAX_TOOL_ROUNDS = 10;

/**
 * Hard ceiling on outbound SMS that ONE inbound SMS may produce.
 *
 * `send_user_message` deliberately does not end the run, so without a budget a
 * single inbound can fan out to one SMS per round. Two is "a short ack plus the
 * substantive result", which is the most a human ever wants from one text.
 */
export const MAX_USER_MESSAGES_PER_RUN = 2;

/** Refusal handed back to the model once the per-run send budget is spent. */
export const SEND_BUDGET_EXHAUSTED_ERROR =
  `Refused: this run already sent ${String(MAX_USER_MESSAGES_PER_RUN)} SMS, which is the ` +
  'per-inbound limit. Do not try to send again in this run. Call argument-free ' +
  'attempt_completion now — agents you started report their own progress and results to ' +
  'the user directly.';

/**
 * Feed a round's tool results back to the model as a TOOL turn, never a USER turn.
 *
 * In this transcript `role: 'user'` means exactly one thing: an SMS the human
 * typed (that is the only shape `sessionStore.recordInboundSms` ever writes).
 * Injecting loop control text as `role: 'user'` made every internal nudge
 * indistinguishable from a new inbound text, so the model politely replied to
 * its own scaffolding with another `send_user_message` — one SMS per round until
 * MAX_TOOL_ROUNDS. Mirrors `buildEnvironmentToolMessages`, which already used
 * the tool channel for the same reason.
 */
export function buildToolFeedbackMessages(params: {
  round: number;
  assistantPayload: string;
  toolResultSummary: string;
  guidance: string;
}): CompletionMessage[] {
  const callId = `sms-tool-results-${String(params.round)}`;
  const body =
    params.toolResultSummary === ''
      ? params.guidance
      : `${params.toolResultSummary}\n\n${params.guidance}`;
  return [
    {
      role: 'assistant',
      content: params.assistantPayload,
      tool_calls: [
        {
          id: callId,
          // `type` is required by OpenAI-compatible providers. Cerebras rejects
          // the request without it ("messages.N.assistant.tool_calls.0.type:
          // Field required", code=wrong_api_format), which surfaced as an
          // invalid_request failover to the generic waterfall on every turn.
          type: 'function',
          function: { name: 'tool_results', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      content: body,
    },
  ];
}

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
