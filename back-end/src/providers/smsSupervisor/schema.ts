import { z } from 'zod';

import { buildOpenAiResponseFormat, responseModel } from '../rose';

const replyToAgentCallSchema = z.object({
  tool: z.literal('reply_to_agent'),
  arguments: z.object({
    agent_id_or_prefix: z.string(),
    message: z.string(),
    attention_request_id: z.string().nullable(),
    reject: z.boolean().nullable(),
  }),
});

const killAgentCallSchema = z.object({
  tool: z.literal('kill_agent'),
  arguments: z.object({
    agent_id_or_prefix: z.string(),
  }),
});

const increaseBudgetCallSchema = z.object({
  tool: z.literal('increase_budget'),
  arguments: z.object({
    agent_id_or_prefix: z.string(),
    amount_dollars: z.number(),
  }),
});

const startNewAgentCallSchema = z.object({
  tool: z.literal('start_new_agent'),
  arguments: z.object({
    goal: z.string(),
    budget_dollars: z.number().nullable(),
  }),
});

const webSearchCallSchema = z.object({
  tool: z.literal('web_search'),
  arguments: z.object({
    query: z.string(),
  }),
});

const attemptCompletionCallSchema = z.object({
  tool: z.literal('attempt_completion'),
  arguments: z.object({
    message: z.string(),
  }),
});

export const SmsSupervisorToolCallSchema = z.discriminatedUnion('tool', [
  replyToAgentCallSchema,
  killAgentCallSchema,
  increaseBudgetCallSchema,
  startNewAgentCallSchema,
  webSearchCallSchema,
  attemptCompletionCallSchema,
]);

export const SmsSupervisorResponseSchema = z.object({
  reasoning: z.string().describe('Internal thought process (not shown to user)'),
  tool_calls: z
    .array(SmsSupervisorToolCallSchema)
    .describe('Tool calls to execute. Include attempt_completion when ready to respond.'),
});

export type SmsSupervisorResponse = z.infer<typeof SmsSupervisorResponseSchema>;

export const SUPERVISOR_RESPONSE_MODEL = responseModel(
  'sms_supervisor_response',
  SmsSupervisorResponseSchema
);

export const SUPERVISOR_RESPONSE_SCHEMA = buildOpenAiResponseFormat(SUPERVISOR_RESPONSE_MODEL);
