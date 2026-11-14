import { GREP_TOOL_STRICT_PARAMETERS } from '../grepTool';

/** One terminal-action contract for every Router prompt and provider schema. */
export const DIRECT_ANSWER_CONTRACT =
  'Use direct_answer to finish the current user request. Choose it only when the available context supports a complete answer to what the user asked, with no further research, action, or user clarification needed. The answer must deliver the requested outcome. Search-failure reports, missing-information notices, progress updates, and clarification questions are not substitutes for an unmet requested outcome; continue the available searches or use start_superintelligence instead. If the user asked for status, progress, or an explanation of a limitation, that information itself may completely satisfy the request using available context.';

/**
 * Universal structured-output schema for the chat router.
 *
 * The flat object keeps all fields required across OpenAI, Anthropic, and
 * Gemini. Action-specific fields use empty strings (or an empty array, or
 * null for `grep`) when they do not apply. Order-keeping hosts write the
 * fields in declared order, so `goal` and `mode` follow `action` directly:
 * an escalation writes its agent goal in the first slot after deciding,
 * never after a search field. With `queries` there, the live GLM failover
 * once wrote the re-plan brief into `queries` and the stale first request
 * into `goal` (FLAKY 6a3ec2af). Every stage shares this order. `queries` has
 * no maxItems: under Cerebras's constrained decoding a capped array made the
 * model loop inside its last string. `grep` is the shared grep tool
 * definition's parameters in strict form (providers/grepTool), never a local
 * copy; it comes last so the top-level string fields before it stay
 * recoverable from a cut-off stream.
 */
export const ROUTER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Brief explanation of why this action was chosen',
    },
    action: {
      type: 'string',
      enum: ['direct_answer', 'web_search', 'grep', 'start_superintelligence'],
      description: DIRECT_ANSWER_CONTRACT,
    },
    goal: {
      type: 'string',
      description:
        'Task goal for the agent. Required for start_superintelligence, empty string for other actions.',
    },
    mode: {
      type: 'string',
      // Match RouterDecisionSchema so providers reject out-of-band values
      // instead of allowing the runtime's compatibility fallback to mask one.
      enum: ['plan', 'execute'],
      description:
        'Agent start phase, chosen per Mode Selection. Required for start_superintelligence; ignored for other actions (pick either enum value).',
    },
    queries: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Search queries, run in parallel. One or more for web_search; empty array for other actions.',
    },
    grep: {
      anyOf: [GREP_TOOL_STRICT_PARAMETERS, { type: 'null' }],
      description:
        'Arguments for the grep action (the grep tool definition); null for other actions.',
    },
  },
  required: ['reasoning', 'action', 'goal', 'mode', 'queries', 'grep'],
  additionalProperties: false,
};

/**
 * The router once the turn's search rounds (web_search and grep) are spent:
 * the results are in context, so it answers from them or escalates.
 */
export const ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA = {
  ...ROUTER_JSON_SCHEMA,
  properties: {
    reasoning: ROUTER_JSON_SCHEMA.properties.reasoning,
    action: {
      ...ROUTER_JSON_SCHEMA.properties.action,
      enum: ['direct_answer', 'start_superintelligence'],
    },
    goal: ROUTER_JSON_SCHEMA.properties.goal,
    mode: ROUTER_JSON_SCHEMA.properties.mode,
  },
  required: ROUTER_JSON_SCHEMA.required.filter((field) => field !== 'queries' && field !== 'grep'),
};
