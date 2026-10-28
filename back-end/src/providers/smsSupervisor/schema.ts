import { z } from 'zod';

import { buildOpenAiResponseFormat, responseModel } from '../rose';
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

// Symmetrical port of the explore agent's grep tool (agents/utils/tool_schemas.py
// GrepTool + agents/tools/prompts/grep.py), minus the agent_network source —
// that source needs an agent_id and the supervisor is not an agent.
const grepCallSchema = z
  .object({
    tool: z.literal('grep'),
    arguments: z.object({
      pattern: z
        .string()
        .describe(
          'Regular expression pattern to search for. Plain text works as a literal regex. ' +
            'Use -i for case-insensitive matching and multiline for cross-line patterns.'
        ),
      source: z
        .enum(['messages', 'network', 'transactions', 'documents'])
        .nullable()
        .describe(
          'Optional source bucket. Omit to search messages and network. ' +
            'messages searches user communication records. network searches contact records. ' +
            'transactions searches synced Plaid transaction rows. documents searches synced ChatGPT/Claude ' +
            'exports, Apple Notes, Obsidian vault notes, Granola meeting notes, and generic user documents.'
        ),
      '-B': z
        .number()
        .nullable()
        .describe(
          'Context before each match: adjacent message records for messages, logical lines for text records.'
        ),
      '-A': z
        .number()
        .nullable()
        .describe(
          'Context after each match: adjacent message records for messages, logical lines for text records.'
        ),
      '-C': z
        .number()
        .nullable()
        .describe(
          'Context on both sides: adjacent message records for messages, logical lines for text records. Alias for context.'
        ),
      context: z
        .number()
        .nullable()
        .describe(
          'Context on both sides: adjacent message records for messages, logical lines for text records.'
        ),
      '-i': z.boolean().nullable().describe('Enable case-insensitive regex matching.'),
      '-n': z
        .boolean()
        .nullable()
        .describe('Show logical line numbers in content output. Defaults to true.'),
      head_limit: z
        .number()
        .nullable()
        .describe('Maximum number of returned records (1-100). Defaults to 20.'),
      offset: z
        .number()
        .nullable()
        .describe('Skip this many matched snippets before applying head_limit.'),
      multiline: z
        .boolean()
        .nullable()
        .describe('Allow regex patterns to match across newlines within a record.'),
      filters: z
        .object({
          since: z.string().nullable(),
          until: z.string().nullable(),
          account: z.string().nullable(),
          min_amount: z.number().nullable(),
          max_amount: z.number().nullable(),
          status: z.enum(['posted', 'pending', 'all']).nullable(),
          include_pending_in_totals: z.boolean().nullable(),
          person: z.string().nullable(),
          document_source: z.enum(['chatgpt', 'claude', 'apple_notes', 'obsidian']).nullable(),
          path: z.string().nullable(),
          tag: z.string().nullable(),
        })
        .nullable()
        .describe(
          'Source-specific nested filters. For transactions: since, until, account, min_amount, ' +
            "max_amount, status ('posted', 'pending', or 'all'), include_pending_in_totals. " +
            'For messages: person and since. For documents: document_source, since, until, path, and tag. ' +
            'Unsupported filters are rejected by the backend for the selected source.'
        ),
      person: z
        .string()
        .nullable()
        .describe(
          'messages source only: narrow to one contact by email, phone, or full name. ' +
            'Ignored for network.'
        ),
      since: z
        .string()
        .nullable()
        .describe(
          'messages source only: only return messages at or after this time. ' +
            'ISO 8601 timestamp or a relative form like 7d, 24h, 30m. Ignored for other sources.'
        ),
    }),
  })
  .describe(
    `Search local data sources for information specific to this user.

Usage:
- Search here before asking the user for a fact about themselves or their plans (IDs, documents, addresses, contacts, past bookings); their synced data often has it.
- Do not use this for the public web, use web_search instead.
- \`pattern\` is a regular expression. Plain text works for literal searches.
- \`source\` is optional. Omit it to search messages and network.
- Supported sources: messages, network, transactions, documents.
- Grep-style flags: for messages, -A/-B/-C/context return adjacent message records; for text records they return logical lines. -n controls numbering, -i is case-insensitive, head_limit supports up to 100, plus offset and multiline.
- Use nested \`filters\` for source-specific narrowing. For messages: \`person\` and \`since\`. Legacy top-level \`person\` and \`since\` still work for messages.
- For transactions: \`filters.since\`, \`filters.until\`, \`filters.account\`, \`filters.min_amount\`, \`filters.max_amount\`, \`filters.status\` (\`posted\`, \`pending\`, or \`all\`), and \`filters.include_pending_in_totals\`.
- Transaction results include row snippets plus full-result aggregate totals by currency. Pending rows are visible, but excluded from totals unless \`include_pending_in_totals\` is true.
- Use \`source="documents"\` for synced ChatGPT/Claude exports, Apple Notes, Obsidian vault notes, Granola meeting notes, and generic text documents. For documents: \`filters.document_source\` (\`chatgpt\`, \`claude\`, \`apple_notes\`, \`obsidian\`, \`granola\` — or \`granola_note\`, \`granola_summary\`, \`granola_transcript\` for one layer), \`filters.since\`, \`filters.until\`, \`filters.path\`, and \`filters.tag\`.

Returns:
- matching records with full bodies, aligned per-record metadata, explicit pagination metadata, and oldest-first display for message conversations.`
  );

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
  grepCallSchema,
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
