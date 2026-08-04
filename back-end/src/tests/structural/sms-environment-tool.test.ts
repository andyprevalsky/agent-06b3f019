#!/usr/bin/env tsx

import { transformMessagesForAnthropic } from '../../providers/rose/transforms';
import { buildOpenRouterBody } from '../../providers/rose/waterfall';
import { buildEnvironmentToolMessages } from '../../providers/smsSupervisor/environmentMessages';
import { SmsSupervisorResponseSchema } from '../../providers/smsSupervisor/schema';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const environmentSchema = TOOL_SCHEMAS.find((tool) => tool.name === 'get_environment');
check(environmentSchema !== undefined, 'get_environment missing from the SMS tool catalog');
check(
  Object.keys(environmentSchema.parameters.properties).length === 0 &&
    environmentSchema.parameters.required.length === 0,
  'get_environment must accept no arguments'
);
check(
  SmsSupervisorResponseSchema.safeParse({
    reasoning: 'refresh runtime state',
    tool_calls: [{ tool: 'get_environment', arguments: {} }],
  }).success,
  'get_environment missing from the live supervisor response schema'
);

const inbound = { role: 'user' as const, content: 'Newest inbound SMS' };
const environmentMessages = buildEnvironmentToolMessages('Current runtime state', 42);
const requestMessages = [
  { role: 'system' as const, content: 'Stable system prompt' },
  { role: 'user' as const, content: 'Earlier SMS' },
  { role: 'assistant' as const, content: 'Earlier reply' },
  inbound,
  ...environmentMessages,
];
check(requestMessages.indexOf(inbound) === 3, 'newest SMS moved from its chronological position');
check(
  requestMessages[4]?.role === 'assistant' && requestMessages[5]?.role === 'tool',
  'synthetic environment call/result must follow the newest inbound SMS'
);

const anthropic = transformMessagesForAnthropic(requestMessages);
check(
  anthropic.dynamicSystem === null,
  'runtime environment leaked into the dynamic system prompt'
);
check(anthropic.messages[2]?.role === 'user', 'newest inbound SMS is not before environment call');
check(anthropic.messages[3]?.role === 'assistant', 'get_environment tool_use is missing');
check(anthropic.messages[4]?.role === 'user', 'get_environment tool_result is missing');
const toolResult = anthropic.messages[4]?.content as Array<Record<string, unknown>>;
check(toolResult[0]?.type === 'tool_result', 'environment was not encoded as a tool_result');

// The injection is sent to BOTH dialects. Asserting only the Anthropic
// projection is why a tool_call missing OpenAI's `type: "function"` shipped
// green: Anthropic reads `.function.name` directly and never notices, while
// Google rejects the whole transcript and demotes the pool to its weakest leg.
const openAiMessages = buildOpenRouterBody({
  model: 'google/gemini-3.5-flash',
  messages: requestMessages,
}).messages as Array<{ role: string; tool_calls?: Array<Record<string, unknown>> }>;
const openAiCall = openAiMessages.find((message) => message.tool_calls?.length)?.tool_calls?.[0];
check(
  openAiCall?.type === 'function',
  'environment tool_call must carry the OpenAI type discriminator'
);
const openAiFn = openAiCall?.function as { name?: string } | undefined;
check(
  openAiFn?.name === 'get_environment',
  'environment tool_call must name get_environment in the OpenAI dialect'
);

process.stdout.write('SMS environment tool structural tests passed\n');
