/**
 * Universal structured-output schema for the chat router.
 *
 * The flat object keeps all fields required across OpenAI, Anthropic, and
 * Gemini. Action-specific fields use empty strings when they do not apply.
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
      enum: ['direct_answer', 'web_search', 'start_superintelligence'],
      description: 'The action to take',
    },
    query: {
      type: 'string',
      description: 'Search query. Required for web_search, empty string for other actions.',
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
        'Execution mode: "plan" for 3+ tool calls, "execute" for 1-2 tool calls. Required for start_superintelligence; ignored for other actions (pick either enum value).',
    },
  },
  required: ['reasoning', 'action', 'query', 'goal', 'mode'],
  additionalProperties: false,
};
