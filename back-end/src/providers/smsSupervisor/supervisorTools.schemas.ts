/**
 * Tool schemas surfaced to the SMS supervisor LLM.
 *
 * Kept in a sibling file (rather than inline in supervisorTools.ts) so the
 * main module stays under the project-wide max-lines limit. These schemas are
 * declarative — they describe what each tool accepts, not how it executes.
 * Pair them with the dispatcher in supervisorTools.ts.
 */

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
      'Spawn an autonomous agent that decomposes a goal and runs sub-agents in parallel. Use for work that cannot finish inside this SMS round-trip — multi-step research, persistent execution, or follow-ups after web_search returns thin or stale results.',
    parameters: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string' as const,
          description: 'The task goal for the agent',
        },
        budget_dollars: {
          type: 'number' as const,
          description: 'Budget in dollars (default: $1.00)',
        },
      },
      required: ['goal'],
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
- Supported sources: messages, network, transactions, documents.
- Grep-style flags: -A lines after, -B lines before, -C/context both sides, -n line numbers, -i case-insensitive, head_limit, offset, multiline.
- Use nested \`filters\` for source-specific narrowing. For messages: \`person\` and \`since\`. Legacy top-level \`person\` and \`since\` still work for messages.
- For transactions: \`filters.since\`, \`filters.until\`, \`filters.account\`, \`filters.min_amount\`, \`filters.max_amount\`, \`filters.status\` (\`posted\`, \`pending\`, or \`all\`), and \`filters.include_pending_in_totals\`.
- Transaction results include row snippets plus full-result aggregate totals by currency. Pending rows are visible, but excluded from totals unless \`include_pending_in_totals\` is true.
- Use \`source="documents"\` for synced ChatGPT/Claude exports, Apple Notes, Obsidian vault notes, and generic text documents. For documents: \`filters.document_source\` (\`chatgpt\`, \`claude\`, \`apple_notes\`, \`obsidian\`), \`filters.since\`, \`filters.until\`, \`filters.path\`, and \`filters.tag\`.

Returns:
- matching records with surrounding context and location metadata.`,
    parameters: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string' as const,
          description:
            'Regular expression pattern to search for. Plain text works as a literal regex. Use -i for case-insensitive matching and multiline for cross-line patterns.',
        },
        source: {
          type: 'string' as const,
          enum: ['messages', 'network', 'transactions', 'documents'],
          description:
            'Optional source bucket. Omit to search messages and network. messages searches user communication records. network searches contact records. transactions searches synced Plaid transaction rows. documents searches synced ChatGPT/Claude exports, Apple Notes, Obsidian vault notes, and generic user documents.',
        },
        '-B': {
          type: 'number' as const,
          description: 'Number of logical lines to show before each match.',
        },
        '-A': {
          type: 'number' as const,
          description: 'Number of logical lines to show after each match.',
        },
        '-C': {
          type: 'number' as const,
          description:
            'Number of logical lines to show before and after each match. Alias for context.',
        },
        context: {
          type: 'number' as const,
          description: 'Number of logical lines to show before and after each match.',
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
          description: 'Maximum number of returned result snippets. Defaults to 20.',
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
            "Source-specific nested filters. For transactions: since, until, account, min_amount, max_amount, status ('posted', 'pending', or 'all'), include_pending_in_totals. For messages: person and since. For documents: document_source, since, until, path, and tag. Unsupported filters are rejected by the backend for the selected source.",
        },
        person: {
          type: 'string' as const,
          description:
            'messages source only: narrow to one contact by email, phone, or full name. Ignored for network.',
        },
        since: {
          type: 'string' as const,
          description:
            'messages source only: only return messages at or after this time. ISO 8601 timestamp or a relative form like 7d, 24h, 30m. Ignored for other sources.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'attempt_completion',
    description:
      'Send the final SMS reply to the user. This is the only way to reply, and it also commits any queued write-tool calls from this turn. Call exactly once when you have an answer ready.',
    parameters: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string' as const,
          description: 'The SMS message to send to the user',
        },
      },
      required: ['message'],
    },
  },
];
