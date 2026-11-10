import { zodToStrictJsonSchema } from '../rose/schema';
import { ChatGrepParamsSchema } from './chatGrepSchema';

/**
 * Universal structured-output schema for the chat router.
 *
 * The flat object keeps all fields required across OpenAI, Anthropic, and
 * Gemini. Action-specific fields use empty strings (or an empty array) when
 * they do not apply. `queries` has no maxItems: under Cerebras's constrained
 * decoding a capped array made the model loop inside its last string.
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
      description:
        'The action to take. Use direct_answer only when the chat reply itself will contain the requested representation. A pointer or limitation is not direct_answer; use start_superintelligence.',
    },
    queries: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Search queries, run in parallel. One or more for web_search; empty array for other actions.',
    },
    grep: {
      anyOf: [zodToStrictJsonSchema(ChatGrepParamsSchema), { type: 'null' }],
      description:
        'User-data search parameters for grep; null for other actions. Results return to the Router before answering.',
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
  },
  required: ['reasoning', 'action', 'queries', 'grep', 'goal', 'mode'],
  additionalProperties: false,
};

/**
 * The router once the turn's web-search rounds are spent: the results are in
 * context, so it answers from them or escalates.
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
