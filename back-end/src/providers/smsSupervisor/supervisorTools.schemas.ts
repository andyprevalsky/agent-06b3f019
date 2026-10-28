/**
 * Tool schemas surfaced to the SMS supervisor LLM.
 *
 * Kept in a sibling file (rather than inline in supervisorTools.ts) so the
 * main module stays under the project-wide max-lines limit. These schemas are
 * declarative — they describe what each tool accepts, not how it executes.
 * Pair them with the dispatcher in supervisorTools.ts.
 */

import { userFacingTextDescription } from '../userFacingWritingPrompt';
import { START_PHASE_DESCRIPTION } from './schema';
import { SMS_DELIVERY_INSTRUCTIONS } from '../smsDeliveryContract';

export const TOOL_SCHEMAS = [
  {
    name: 'reply_to_agent',
    description:
      'Send a reply to an agent — answers questions, approves/rejects write-locks, or sends any message.',
    parameters: {
      type: 'object' as const,
      properties: {
        agent_id_or_prefix: {
          type: 'string' as const,
          description: 'Agent ID or 6-char prefix (e.g. "a3f2b1")',
        },
        message: {
          type: 'string' as const,
          description: 'The reply text to send to the agent',
        },
        attention_request_id: {
          type: 'string' as const,
          description:
            'If resolving a pending attention request, provide the attn_id from the Pending Requests list',
        },
        reject: {
          type: 'boolean' as const,
          description: 'Set to true to reject an attention request. Default: false (approve)',
        },
      },
      required: ['agent_id_or_prefix', 'message'],
    },
  },
  {
    name: 'kill_agent',
    description:
      'Stop/kill an agent and all its sub-agents. Use the 6-character prefix or full ID.',
    parameters: {
      type: 'object' as const,
      properties: {
        agent_id_or_prefix: {
          type: 'string' as const,
          description: 'Agent ID or 6-char prefix (e.g. "a3f2b1")',
        },
      },
      required: ['agent_id_or_prefix'],
    },
  },
  {
    name: 'increase_budget',
    description: "Increase an agent's cost limit. The amount is ADDED to the current limit.",
    parameters: {
      type: 'object' as const,
      properties: {
        agent_id_or_prefix: {
          type: 'string' as const,
          description: 'Agent ID or 6-char prefix',
        },
        amount_dollars: {
          type: 'number' as const,
          description: 'Amount in dollars to ADD to the current budget (e.g. 5.00 adds $5)',
        },
      },
      required: ['agent_id_or_prefix', 'amount_dollars'],
    },
  },
  {
    name: 'start_new_agent',
    description:
      "Spawn an autonomous agent that decomposes a goal and runs sub-agents in parallel. Use for work that cannot finish inside this SMS round-trip — multi-step research, purchases/orders, persistent execution, or follow-ups after web_search returns thin or stale results. This is the SMS-surface equivalent of the main agent's spawn_agent — call start_new_agent here; do not invent progress in send_user_message without calling it.",
    parameters: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string' as const,
          description: 'The task goal for the agent',
        },
        notification_message: {
          type: 'string' as const,
          description:
            'Short user-facing kickoff notification for this agent. Include what you are starting, omit internal task instructions and links; the agent link is appended automatically.',
        },
        budget_dollars: {
          type: 'number' as const,
          description: 'Budget in dollars (default: $1.00)',
        },
        start_phase: {
          type: 'string' as const,
          enum: ['plan', 'execute'],
          description: START_PHASE_DESCRIPTION,
        },
      },
      required: ['goal', 'start_phase'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string' as const,
          description: 'Search query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'grep',
    description: `Search local data sources for information specific to this user.

Usage:
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
- Use \`source="documents"\` for synced ChatGPT/Claude exports, Apple Notes, Obsidian vault notes, Granola meeting notes, and generic text documents. For documents: \`filters.document_source\` (\`chatgpt\`, \`claude\`, \`apple_notes\`, \`obsidian\`, \`granola\` — or \`granola_note\`, \`granola_summary\`, \`granola_transcript\` for one layer), \`filters.since\`, \`filters.until\`, \`filters.path\`, and \`filters.tag\`.

Returns:
- matching records with full bodies, aligned per-record metadata, explicit pagination metadata, and oldest-first display for message conversations.`,
    parameters: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string' as const,
          description:
            'Regular expression over record text. Omit for agent_trajectories to list recent records using metadata filters.',
        },
        source: {
          type: 'string' as const,
          enum: ['messages', 'network', 'agent_trajectories', 'transactions', 'documents'],
          description:
            "Optional source bucket. Omit to search messages and network. agent_trajectories searches this user's agent history across chat, SMS, and Temporal. Other sources: messages, network, transactions, documents.",
        },
        role: {
          type: 'string' as const,
          enum: ['USER', 'ASSISTANT', 'TOOL'],
          description:
            'Agent trajectory message role. Implies agent_trajectories when source is omitted.',
        },
        record_kind: {
          type: 'string' as const,
          enum: ['message', 'llm_output', 'llm_context', 'all'],
          description: 'Agent trajectory record kind.',
        },
        surface: {
          type: 'string' as const,
          enum: ['WEB', 'MAC_APP', 'SMS', 'WHATSAPP'],
          description: 'Agent trajectory origin surface.',
        },
        trace_path: {
          type: 'string' as const,
          description: 'Agent trajectory root path/UUID, child agent path, or message path.',
        },
        order: {
          type: 'string' as const,
          enum: ['newest_first', 'oldest_first'],
          description: 'Order one agent_trajectories search; defaults to newest_first.',
        },
        page_after: {
          type: 'string' as const,
          description: 'Use the prior next_page_after path with the same agent_trajectories query.',
        },
        until: {
          type: 'string' as const,
          description: 'Latest timestamp for agent trajectory results (ISO 8601).',
        },
        '-B': {
          type: 'number' as const,
          description:
            'Context before each match: adjacent message records for messages, logical lines for text records.',
        },
        '-A': {
          type: 'number' as const,
          description:
            'Context after each match: adjacent message records for messages, logical lines for text records.',
        },
        '-C': {
          type: 'number' as const,
          description:
            'Context on both sides: adjacent message records for messages, logical lines for text records. Alias for context.',
        },
        context: {
          type: 'number' as const,
          description:
            'Context on both sides: adjacent message records for messages, logical lines for text records.',
        },
        '-n': {
          type: 'boolean' as const,
          description: 'Show logical line numbers in content output. Defaults to true.',
        },
        '-i': {
          type: 'boolean' as const,
          description: 'Enable case-insensitive regex matching.',
        },
        head_limit: {
          type: 'number' as const,
          description: 'Maximum number of returned records (1-100). Defaults to 20.',
        },
        offset: {
          type: 'number' as const,
          description: 'Skip this many matched snippets before applying head_limit.',
        },
        multiline: {
          type: 'boolean' as const,
          description: 'Allow regex patterns to match across newlines within a record.',
        },
        filters: {
          type: 'object' as const,
          description:
            "Source-specific nested filters. For agent_trajectories: path, since, until, role, surface, record_kind. For transactions: since, until, account, min_amount, max_amount, status ('posted', 'pending', or 'all'), include_pending_in_totals. For messages: person and since. For documents: document_source, since, until, path, and tag. Unsupported filters are rejected by the backend for the selected source.",
          properties: {
            since: { type: 'string' as const },
            until: { type: 'string' as const },
            account: { type: 'string' as const },
            min_amount: { type: 'number' as const },
            max_amount: { type: 'number' as const },
            status: { type: 'string' as const, enum: ['posted', 'pending', 'all'] },
            include_pending_in_totals: { type: 'boolean' as const },
            person: { type: 'string' as const },
            document_source: {
              type: 'string' as const,
              enum: ['chatgpt', 'claude', 'apple_notes', 'obsidian'],
            },
            path: { type: 'string' as const },
            role: { type: 'string' as const, enum: ['USER', 'ASSISTANT', 'TOOL'] },
            surface: { type: 'string' as const, enum: ['WEB', 'MAC_APP', 'SMS', 'WHATSAPP'] },
            record_kind: {
              type: 'string' as const,
              enum: ['all', 'message', 'llm_output', 'llm_context'],
            },
            tag: { type: 'string' as const },
          },
        },
        person: {
          type: 'string' as const,
          description:
            'messages source only: narrow to one contact by email, phone, or full name. Ignored for network.',
        },
        since: {
          type: 'string' as const,
          description:
            'Messages or agent trajectories at or after this time. ISO 8601 timestamp or a relative form like 7d, 24h, 30m.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_environment',
    description:
      'Refresh the current runtime environment: current datetime, agent hierarchy, pending requests, and recent agent activity. Takes no arguments. The result is runtime context, not user-authored SMS content, and is not persisted in the SMS conversation.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_user_message',
    description:
      'Deliver a real SMS to the user immediately. This is not a draft and cannot be undone. Sending does not end the run: continue using tools if more work or a later result is needed, then call attempt_completion when the run is actually complete.',
    parameters: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string' as const,
          description: userFacingTextDescription(
            `The exact SMS message to send to the user. ${SMS_DELIVERY_INSTRUCTIONS}`
          ),
        },
        reply_to_message_id: {
          type: 'string' as const,
          description:
            'Optional message ID or reference from the reply-target index to quote an incoming or previously sent message. SMS includes the selected text as a quote; WhatsApp uses a native reply. Omit for an ordinary message.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'attempt_completion',
    description:
      'End the current run. This sends no message and accepts no information. The runtime rejects it unless this run has already successfully called send_user_message at least once.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];
