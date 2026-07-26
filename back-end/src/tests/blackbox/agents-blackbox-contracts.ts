import { z } from 'zod';

export const DATE_LIKE = z.union([z.string(), z.date()]);

export const ErrorResponse = z.object({ error: z.string(), details: z.array(z.any()).optional() });

export const AgentListItem = z.object({
  agent_id: z.string().uuid(),
  goal: z.string(),
  model: z.string(),
  source: z.enum(['WEB', 'MAC_APP', 'SMS']),
  reasoning_max_tokens: z.number(),
  progress: z.number(),
  status: z.string(),
  status_message: z.string().nullable(),
  temporal_workflow_id: z.string().nullable(),
  token_count: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  context_size: z.number(),
  message_count: z.number(),
  world_model_mode: z.enum(['real', 'simulate', 'shadow']),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
});

export const ListAgentsResponse = z.object({
  agents: z.array(AgentListItem),
});

export const TreeAgentItem = z.object({
  agent_id: z.string().uuid(),
  parent_agent_id: z.string().uuid().nullable(),
  goal: z.string(),
  status: z.string(),
  progress: z.number(),
  tools_in_use: z.array(z.string()),
  message_count: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  output_schema: z.unknown().nullable(),
  structured_output: z.unknown().nullable(),
  tree_cost_cents: z.number(),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
});

export const TreeResponse = z.object({
  agents: z.array(TreeAgentItem),
});

export const CreateAgentResponse = z.object({
  agent_id: z.string().uuid(),
  progress: z.number(),
  goal: z.string(),
  model: z.string(),
  source: z.enum(['WEB', 'MAC_APP', 'SMS']),
  reasoning_max_tokens: z.number(),
  status: z.string(),
  status_message: z.string().nullable(),
  temporal_workflow_id: z.string().nullable(),
  world_model_mode: z.enum(['real', 'simulate', 'shadow']),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
  available_endpoints: z.record(z.any()),
});

export const MessageItem = z.object({
  message_id: z.string(),
  timestamp: DATE_LIKE,
  text: z.string(),
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']),
  metadata: z.unknown().nullable(),
  file_pointer: z.unknown().nullable(),
});

export const VerifierSchema = z
  .object({
    type: z.string(),
  })
  .nullable();

export const ToolItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

export const AgentDetail = z.object({
  agent_id: z.string().uuid(),
  parent_agent_id: z.string().uuid().nullable(),
  parent_goal: z.string().nullable(),
  goal: z.string(),
  model: z.string(),
  source: z.enum(['WEB', 'MAC_APP', 'SMS']),
  reasoning_max_tokens: z.number(),
  progress: z.number(),
  status: z.string(),
  status_message: z.string().nullable(),
  temporal_workflow_id: z.string().nullable(),
  token_count: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  tool_tokens_in: z.number(),
  tool_tokens_out: z.number(),
  tool_cost_cents: z.number(),
  context_size: z.number(),
  message_count: z.number(),
  price_limit_cents: z.number(),
  tree_cost_cents: z.number(),
  world_model_mode: z.enum(['real', 'simulate', 'shadow']),
  token_in_price_microdollars: z.number().nullable(),
  token_out_price_microdollars: z.number().nullable(),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
  write_lock_enabled: z.boolean(),
  structured_output: z.unknown().nullable(),
  failure_context: z
    .object({
      partial_structured_response: z.unknown(),
    })
    .nullable(),
  verifier: VerifierSchema,
  tools: z.array(ToolItem),
  response_schema: z.unknown().nullable(),
});

export const GetAgentResponse = z.object({
  agent: AgentDetail,
  messages: z.array(MessageItem),
  pagination: z.object({
    has_more: z.boolean(),
    oldest_timestamp: z.unknown().nullable(),
  }),
});

export const AncestorsResponse = z.object({
  ancestors: z.array(z.object({ id: z.string(), goal: z.string() })),
});

export const PostMessageResponse = z.object({
  message_id: z.string(),
  timestamp: DATE_LIKE,
  text: z.string(),
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']),
});

export const StatusResponse = z.object({
  agent_id: z.string().uuid(),
  status: z.string(),
});

export const UpdateStatusResponse = z.object({
  agent_id: z.string().uuid(),
  status: z.string(),
  status_message: z.string().nullable(),
  progress: z.number(),
  token_count: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  context_size: z.number(),
  message_count: z.number(),
  updated_at: DATE_LIKE,
});

export const WorkflowReplacementBootstrapAckResponse = z.object({
  acknowledged: z.literal(true),
  already_acknowledged: z.boolean(),
});

export const UpdateAgentResponse = z.object({
  agent: z.object({
    agent_id: z.string().uuid(),
    goal: z.string().optional(),
    model: z.string(),
    reasoning_max_tokens: z.number(),
    progress: z.number(),
    status: z.string(),
    status_message: z.string().nullable(),
    temporal_workflow_id: z.string().nullable(),
    token_count: z.number(),
    tokens_in: z.number(),
    tokens_out: z.number(),
    context_size: z.number(),
    message_count: z.number(),
    price_limit_cents: z.number(),
    tree_cost_cents: z.number(),
    created_at: DATE_LIKE,
    updated_at: DATE_LIKE,
    write_lock_enabled: z.boolean(),
    verifier: VerifierSchema,
    tools: z.array(ToolItem),
  }),
});

export const SuccessResponse = z.object({ success: z.boolean() });
