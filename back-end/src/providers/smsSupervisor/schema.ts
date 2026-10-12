import { z } from 'zod';

import { buildOpenAiResponseFormat, responseModel } from '../rose';
import { userFacingTextDescription } from '../userFacingWritingPrompt';

const AGENT_TARGET_DESCRIPTION =
  'Agent ID or 6-character prefix from the agent hierarchy or a start_new_agent result (e.g. "a3f2b1").';

const replyToAgentCallSchema = z
  .object({
    tool: z.literal('reply_to_agent'),
    arguments: z.object({
      agent_id_or_prefix: z.string().describe(AGENT_TARGET_DESCRIPTION),
      message: z.string().describe('The reply text the agent receives.'),
      attention_request_id: z
        .string()
        .nullable()
        .describe(
          'If resolving a pending attention request, provide the attn_id from the Pending Requests list.'
        ),
      reject: z
        .boolean()
        .nullable()
        .describe(
          'Set to true to reject that attention request; requires attention_request_id. Omit to approve or simply reply.'
        ),
    }),
  })
  .describe(
    "Send a message to one of the user's agents: answer its question, approve or reject its pending request, or pass on new instructions from the user. The agent cannot see this SMS thread or your tool results; it receives only this message. Works for an agent started earlier in this run."
  );

const killAgentCallSchema = z
  .object({
    tool: z.literal('kill_agent'),
    arguments: z.object({
      agent_id_or_prefix: z.string().describe(AGENT_TARGET_DESCRIPTION),
    }),
  })
  .describe('Stop an agent and all of its sub-agents. Their in-flight work is discarded.');

const increaseBudgetCallSchema = z
  .object({
    tool: z.literal('increase_budget'),
    arguments: z.object({
      agent_id_or_prefix: z.string().describe(AGENT_TARGET_DESCRIPTION),
      amount_dollars: z
        .number()
        .describe('Amount in dollars to ADD to the current budget (e.g. 5.00 adds $5).'),
    }),
  })
  .describe("Increase an agent's cost limit. The amount is ADDED to the current limit.");

export const START_PHASE_DESCRIPTION =
  "Phase the agent starts in. 'execute' skips planning and the agent cannot ask the user anything: use it only when every input the goal needs is already known and one agent can finish it without splitting into parallel sub-tasks. Otherwise 'plan'. Prefer 'plan' when unsure.";

const startNewAgentCallSchema = z
  .object({
    tool: z.literal('start_new_agent'),
    arguments: z.object({
      goal: z
        .string()
        .describe(
          'What the agent should accomplish. Be specific and self-contained: it knows nothing about this SMS conversation or your tool results, so include every relevant fact already known and what is still unknown.'
        ),
      budget_dollars: z
        .number()
        .nullable()
        .describe(
          'Agent-run budget for LLM and metered tool calls only (default $1; usually under $2). Never include purchase cost; purchases are approved separately.'
        ),
      start_phase: z.enum(['plan', 'execute']).describe(START_PHASE_DESCRIPTION),
    }),
  })
  .describe(
    `Start an autonomous agent that works on a goal in the background: it plans, runs sub-agents in parallel, and texts the user directly when it starts, asks a question, needs an approval, and finishes. Use it for work that cannot finish inside this SMS run: multi-step research, forms and applications, purchases and orders, and follow-ups after web_search returns thin or stale results. This is the SMS-surface equivalent of the main agent's spawn_agent. Do not describe progress in send_user_message without calling it.

Writing the goal: the agent starts with zero context. It has not seen this SMS thread or your tool results. Brief it like a smart colleague who just walked into the room:
- What the user wants done, and why.
- Every relevant fact you already have, from the user or from grep and web_search results: names, numbers, dates, addresses, links.
- What is still unknown, so it asks the user only for that.
Terse goals produce shallow work, and a fact you leave out is one the agent has to ask the user for again.`
  );

const webSearchCallSchema = z
  .object({
    tool: z.literal('web_search'),
    arguments: z.object({
      query: z.string().describe('Search query'),
    }),
  })
  .describe(
    'Search the public web for current information. For facts about the user or their own data, use grep instead.'
  );

const sendUserMessageCallSchema = z
  .object({
    tool: z.literal('send_user_message'),
    arguments: z.object({
      message: z
        .string()
        .describe(
          userFacingTextDescription(
            'The exact SMS message to send to the user. Sending does not end the run.'
          )
        ),
    }),
  })
  .describe(
    'Deliver a real SMS to the user immediately. Only text sent through this tool reaches the user; your reasoning and any other output never do. This is not a draft and cannot be undone. Sending does not end the run: continue using tools if more work or a later result is needed, then call attempt_completion when the run is actually complete.'
  );

const getEnvironmentCallSchema = z
  .object({
    tool: z.literal('get_environment'),
    arguments: z.object({}).strict(),
  })
  .describe(
    'Refresh the current runtime environment: current datetime, agent hierarchy, pending requests, and recent agent activity. Takes no arguments. The result is runtime context, not user-authored SMS content, and is not persisted in the SMS conversation.'
  );

// Symmetrical port of the explore agent's grep tool (agents/utils/tool_schemas.py
// GrepTool + agents/tools/prompts/grep.py), minus the agent_network source —
// that source needs an agent_id and the supervisor is not an agent.
const grepCallSchema = z
  .object({
    tool: z.literal('grep'),
    arguments: z.object({
      pattern: z
        .string()
        .nullable()
        .describe(
          'Regular expression over record text. Omit for agent_trajectories to list recent records using metadata filters.'
        ),
      source: z
        .enum(['messages', 'network', 'agent_trajectories', 'transactions', 'documents'])
        .nullable()
        .describe(
          "Optional source bucket. Omit to search messages and network. agent_trajectories searches this user's agent history across chat, SMS, and Temporal. Other sources: messages, network, transactions, documents."
        ),
      role: z
        .enum(['USER', 'ASSISTANT', 'TOOL'])
        .nullable()
        .describe(
          'Agent trajectory message role. Implies agent_trajectories when source is omitted.'
        ),
      record_kind: z
        .enum(['message', 'llm_output', 'llm_context', 'all'])
        .nullable()
        .describe('Agent trajectory record kind.'),
      surface: z
        .enum(['WEB', 'MAC_APP', 'SMS', 'WHATSAPP'])
        .nullable()
        .describe('Agent trajectory origin surface.'),
      trace_path: z
        .string()
        .nullable()
        .describe('Agent trajectory root path/UUID, child agent path, or message path.'),
      order: z
        .enum(['newest_first', 'oldest_first'])
        .nullable()
        .describe('Order one agent_trajectories search; defaults to newest_first.'),
      page_after: z
        .string()
        .nullable()
        .describe('Use the prior next_page_after path with the same agent_trajectories query.'),
      until: z
        .string()
        .nullable()
        .describe('Latest timestamp for agent trajectory results (ISO 8601).'),
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
          role: z.enum(['USER', 'ASSISTANT', 'TOOL']).nullable(),
          surface: z.enum(['WEB', 'MAC_APP', 'SMS', 'WHATSAPP']).nullable(),
          record_kind: z.enum(['all', 'message', 'llm_output', 'llm_context']).nullable(),
          tag: z.string().nullable(),
        })
        .nullable()
        .describe(
          "Source-specific nested filters. For agent_trajectories: path, since, until, role, surface, record_kind. For transactions: since, until, account, min_amount, max_amount, status ('posted', 'pending', or 'all'), include_pending_in_totals. For messages: person and since. For documents: document_source, since, until, path, and tag. Unsupported filters are rejected by the backend for the selected source."
        ),
      person: z
        .string()
        .nullable()
        .describe(
          'messages source only: narrow to one contact by email, phone, or full name. Ignored for network.'
        ),
      since: z
        .string()
        .nullable()
        .describe(
          'Messages or agent trajectories at or after this time. ISO 8601 timestamp or a relative form like 7d, 24h, 30m.'
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
- Supported sources: messages, network, agent_trajectories, transactions, documents. agent_trajectories searches this user's prior agent runs across chat, SMS, and Temporal.
- Agent trajectory results include trace_path, message_role, and agent_title as separate fields.
- A root trace_path searches its child tree; a child path narrows to one agent. Use next_page_after as page_after with the same query to continue through results; order selects newest_first or oldest_first.
- Trajectory record_kind: message is a stored agent message, llm_output is a model response, and llm_context is text passed to a model and may replay earlier turns. Ordinary results include messages and outputs, newest first; record_kind=all includes replayed inputs.
- Grep-style flags: for messages, -A/-B/-C/context return adjacent message records; for text records they return logical lines. -n controls numbering, -i is case-insensitive, head_limit supports up to 100, plus offset and multiline.
- Use nested \`filters\` for source-specific narrowing. For messages: \`person\` and \`since\`. Legacy top-level \`person\` and \`since\` still work for messages.
- For transactions: \`filters.since\`, \`filters.until\`, \`filters.account\`, \`filters.min_amount\`, \`filters.max_amount\`, \`filters.status\` (\`posted\`, \`pending\`, or \`all\`), and \`filters.include_pending_in_totals\`.
- Transaction results include row snippets plus full-result aggregate totals by currency. Pending rows are visible, but excluded from totals unless \`include_pending_in_totals\` is true.
- Use \`source="documents"\` for synced ChatGPT/Claude exports, Apple Notes, Obsidian vault notes, and generic text documents. For documents: \`filters.document_source\` (\`chatgpt\`, \`claude\`, \`apple_notes\`, \`obsidian\`), \`filters.since\`, \`filters.until\`, \`filters.path\`, and \`filters.tag\`.

Returns:
- each matching record's matching lines, ripgrep style, with -A/-B/-C context lines (pattern "." returns a whole record, up to 250 lines), aligned per-record metadata, explicit pagination metadata, and oldest-first display for message conversations.`
  );

const attemptCompletionCallSchema = z
  .object({
    tool: z.literal('attempt_completion'),
    arguments: z.object({}).strict(),
  })
  .describe(
    'End the current run. This sends no message and accepts no information. The runtime rejects it unless this run has already successfully called send_user_message at least once.'
  );

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
