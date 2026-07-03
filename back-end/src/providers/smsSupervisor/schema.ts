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
            'exports, Apple Notes, Obsidian vault notes, and generic user documents.'
        ),
      '-B': z.number().nullable().describe('Number of logical lines to show before each match.'),
      '-A': z.number().nullable().describe('Number of logical lines to show after each match.'),
      '-C': z
        .number()
        .nullable()
        .describe(
          'Number of logical lines to show before and after each match. Alias for context.'
        ),
      context: z
        .number()
        .nullable()
        .describe('Number of logical lines to show before and after each match.'),
      '-n': z
        .boolean()
        .nullable()
        .describe('Show logical line numbers in content output. Defaults to true.'),
      '-i': z.boolean().nullable().describe('Enable case-insensitive regex matching.'),
      head_limit: z
        .number()
        .nullable()
        .describe('Maximum number of returned result snippets. Defaults to 20.'),
      offset: z
        .number()
        .nullable()
        .describe('Skip this many matched snippets before applying head_limit.'),
      multiline: z
        .boolean()
        .nullable()
        .describe('Allow regex patterns to match across newlines within a record.'),
      filters: z
        .record(z.unknown())
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
- Do not use this for the public web, use web_search instead.
- \`pattern\` is a regular expression. Plain text works for literal searches.
- \`source\` is optional. Omit it to search messages and network.
- Supported sources: messages, network, transactions, documents.
- Grep-style flags: -A lines after, -B lines before, -C/context both sides, -n line numbers, -i case-insensitive, head_limit, offset, multiline.
- Use nested \`filters\` for source-specific narrowing. For messages: \`person\` and \`since\`. Legacy top-level \`person\` and \`since\` still work for messages.
- For transactions: \`filters.since\`, \`filters.until\`, \`filters.account\`, \`filters.min_amount\`, \`filters.max_amount\`, \`filters.status\` (\`posted\`, \`pending\`, or \`all\`), and \`filters.include_pending_in_totals\`.
- Transaction results include row snippets plus full-result aggregate totals by currency. Pending rows are visible, but excluded from totals unless \`include_pending_in_totals\` is true.
- Use \`source="documents"\` for synced ChatGPT/Claude exports, Apple Notes, Obsidian vault notes, and generic text documents. For documents: \`filters.document_source\` (\`chatgpt\`, \`claude\`, \`apple_notes\`, \`obsidian\`), \`filters.since\`, \`filters.until\`, \`filters.path\`, and \`filters.tag\`.

Returns:
- matching records with surrounding context and location metadata.`
  );

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
  grepCallSchema,
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
