import type { CompletionMessage } from '../rose';
import { buildSmsContext } from './contextBuilder';
import type { ToolCall, ToolResult } from './supervisorTools';

export const MAX_TOOL_ROUNDS = 10;

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

/** Provider call id for a supervisor tool call; content-path calls carry none. */
export function supervisorToolCallId(round: number, index: number, toolCall: ToolCall): string {
  return toolCall.id ?? `sms-${String(round)}-${String(index)}`;
}

export function formatToolResult(result: ToolResult): string {
  return `[${result.tool}] ${result.success ? 'OK' : 'ERROR'}: ${result.result || result.error}`;
}

/**
 * Replay a round in the native tool-calling shape (Rose.complete standard): the
 * assistant turn carries the model's actual tool calls and each call gets its
 * own tool result. Round-level outcomes that belong to no single call (queued
 * writes committing, a failure notice sent to the user) and the loop guidance
 * travel on the last result, so control text never becomes a user turn.
 */
export function buildNativeToolFeedbackMessages(params: {
  round: number;
  toolCalls: ToolCall[];
  resultsByCall: ReadonlyMap<ToolCall, ToolResult[]>;
  roundResults: ToolResult[];
  guidance: string;
}): CompletionMessage[] {
  const ids = params.toolCalls.map((toolCall, index) =>
    supervisorToolCallId(params.round, index, toolCall)
  );
  const results: CompletionMessage[] = params.toolCalls.map((toolCall, index) => {
    const own = params.resultsByCall.get(toolCall) ?? [];
    return {
      role: 'tool',
      tool_call_id: ids[index],
      content: own.length > 0 ? own.map(formatToolResult).join('\n') : 'No result recorded.',
    };
  });
  const last = results[results.length - 1];
  const trailer = [...params.roundResults.map(formatToolResult), params.guidance].join('\n');
  last.content = `${String(last.content)}\n\n${trailer}`;
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: params.toolCalls.map((toolCall, index) => ({
        id: ids[index],
        type: 'function',
        function: { name: toolCall.tool, arguments: JSON.stringify(toolCall.arguments ?? {}) },
      })),
    },
    ...results,
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

export async function prepareSmsEnvironment(
  userId: string,
  sequence: number,
  inboundAlreadyPersisted: boolean
) {
  return buildSmsContext(userId, inboundAlreadyPersisted ? { excludeInboundSeq: sequence } : {});
}
