/**
 * Tool schemas surfaced to the SMS supervisor LLM.
 *
 * Kept in a sibling file (rather than inline in supervisorTools.ts) so the
 * main module stays under the project-wide max-lines limit. These schemas are
 * declarative — they describe what each tool accepts, not how it executes.
 * Pair them with the dispatcher in supervisorTools.ts.
 */

import { GREP_TOOL_DEFINITION } from '../grepTool';
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
  // The shared grep definition (providers/grepTool): every surface sends this one tool.
  GREP_TOOL_DEFINITION,
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
