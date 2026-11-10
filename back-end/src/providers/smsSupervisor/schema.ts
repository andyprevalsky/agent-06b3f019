import { z } from 'zod';

import { buildOpenAiResponseFormat, responseModel } from '../rose';
import { grepToolCallSchema } from '../grepTool';
import { userFacingTextDescription } from '../userFacingWritingPrompt';
import { SMS_DELIVERY_INSTRUCTIONS } from '../smsDeliveryContract';

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

export const START_PHASE_DESCRIPTION =
  "Phase the agent starts in. 'execute' skips planning and the agent cannot ask the user anything: use it only when every input the goal needs is already known and one agent can finish it without splitting into parallel sub-tasks. Otherwise 'plan'. Prefer 'plan' when unsure.";

const startNewAgentCallSchema = z.object({
  tool: z.literal('start_new_agent'),
  arguments: z.object({
    goal: z.string(),
    notification_message: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Short user-facing kickoff notification for this agent. Include what you are starting, omit internal task instructions and links; the agent link is appended automatically.'
      ),
    budget_dollars: z
      .number()
      .nullable()
      .describe(
        'Agent-run budget for LLM and metered tool calls only (default $1; usually under $2). Never include purchase cost; purchases are approved separately.'
      ),
    start_phase: z.enum(['plan', 'execute']).describe(START_PHASE_DESCRIPTION),
  }),
});

const webSearchCallSchema = z.object({
  tool: z.literal('web_search'),
  arguments: z.object({
    query: z.string(),
  }),
});

const sendUserMessageCallSchema = z.object({
  tool: z.literal('send_user_message'),
  arguments: z.object({
    reply_to_message_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Optional message ID or reference from the reply-target index. Quote that incoming or previously sent message. SMS includes the selected message as quoted text; WhatsApp uses a native reply. Omit or null for an ordinary message.'
      ),
    message: z
      .string()
      .describe(
        userFacingTextDescription(
          `The exact SMS message to send to the user. Sending does not end the run. ${SMS_DELIVERY_INSTRUCTIONS}`
        )
      ),
  }),
});

const getEnvironmentCallSchema = z.object({
  tool: z.literal('get_environment'),
  arguments: z.object({}).strict(),
});

const attemptCompletionCallSchema = z.object({
  tool: z.literal('attempt_completion'),
  arguments: z.object({}).strict(),
});

export const SmsSupervisorToolCallSchema = z.discriminatedUnion('tool', [
  replyToAgentCallSchema,
  killAgentCallSchema,
  increaseBudgetCallSchema,
  startNewAgentCallSchema,
  webSearchCallSchema,
  grepToolCallSchema,
  getEnvironmentCallSchema,
  sendUserMessageCallSchema,
  attemptCompletionCallSchema,
]);

export const SmsSupervisorResponseSchema = z.object({
  reasoning: z.string().describe('Internal thought process (not shown to user)'),
  tool_calls: z
    .array(SmsSupervisorToolCallSchema)
    .describe(
      'Tool calls to execute. Use send_user_message for user-visible text. Include argument-free attempt_completion only after this run has sent at least one user message.'
    ),
});

export type SmsSupervisorResponse = z.infer<typeof SmsSupervisorResponseSchema>;

export const SUPERVISOR_RESPONSE_MODEL = responseModel(
  'sms_supervisor_response',
  SmsSupervisorResponseSchema
);

export const SUPERVISOR_RESPONSE_SCHEMA = buildOpenAiResponseFormat(SUPERVISOR_RESPONSE_MODEL);

export const SmsSupervisorReactionResponseSchema = z.object({
  reasoning: z.string(),
  tool_calls: z
    .array(
      z
        .object({
          tool: z.literal('react_to_message'),
          arguments: z
            .object({
              emoji: z
                .string()
                .describe(
                  'Choose any single Unicode emoji that fits the incoming message. Compound emoji, skin tones, flags, and keycaps are allowed. No fixed palette or default emoji.'
                ),
            })
            .strict(),
        })
        .strict()
    )
    .length(1),
});

export const SUPERVISOR_REACTION_MODEL = responseModel(
  'sms_supervisor_reaction',
  SmsSupervisorReactionResponseSchema
);
