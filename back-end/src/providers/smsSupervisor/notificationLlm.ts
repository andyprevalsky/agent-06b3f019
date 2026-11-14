import { archiveBindingFor } from '../archiveRootResolver';
import {
  createStreamingCompletion,
  StructuredOutputAccumulator,
  type CompletionMessage,
} from '../rose';
import { SMS_DELIVERY_INSTRUCTIONS } from '../smsDeliveryContract';
import { USER_FACING_WRITING_STYLE } from '../userFacingWritingPrompt';
import { loadBlackboxFixtureObject } from './supervisorFixtures';

export const SMS_NOTIFICATION_SYSTEM_PROMPT = `Rewrite a lifecycle notification for delivery to the user.
${SMS_DELIVERY_INSTRUCTIONS}
Preserve the event's actual status, essential names, amounts, approval question, and required links. Do not invent progress or success. Summarize internal task instructions rather than copying them. Do not repeat passwords or secret tokens from task instructions. For a long approval draft, explain what is awaiting approval and link to the full draft in Rose. The full underlying task or approval remains unchanged.
Delivery tool results describe real rejected messages. Use the reported error to correct your next message. Return the complete replacement message as plain text in the message field.

${USER_FACING_WRITING_STYLE}`;

export function notificationFixtureKey(agentId: string): string {
  return `sms-notification:${agentId}`;
}

export async function rewriteNotification(
  messages: CompletionMessage[],
  agentId?: string
): Promise<string> {
  const fixture = agentId
    ? loadBlackboxFixtureObject(notificationFixtureKey(agentId), messages)
    : null;
  if (fixture) {
    if (typeof fixture.message !== 'string')
      throw new Error('Notification fixture needs a message');
    return fixture.message;
  }
  const stream = await createStreamingCompletion({
    model: 'rose-labs/rose-1-flash',
    route_key: agentId,
    messages,
    temperature: 0.3,
    abort_signal: AbortSignal.timeout(60_000),
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'sms_notification',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: SMS_DELIVERY_INSTRUCTIONS },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    // Notifications act on an agent tree: archive under that tree's root.
    dump_context: { call_site: 'sms_notification', ...(await archiveBindingFor({ agentId })) },
  });
  const output = new StructuredOutputAccumulator();
  for await (const chunk of stream) output.addCompletionChunk(chunk);
  const response = JSON.parse(output.finalText()) as { message?: unknown };
  if (typeof response.message !== 'string')
    throw new Error('Notification model returned no message');
  return response.message;
}
