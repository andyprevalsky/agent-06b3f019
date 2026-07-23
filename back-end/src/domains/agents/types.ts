/**
 * Agents domain types — Zod schemas, TS interfaces, type aliases.
 */

import { z } from 'zod';
export type { Prisma } from '@prisma/client';

// FilePointer schema for validation - all files stored in Supabase Storage
export const filePointerSchema = z.object({
  id: z.string().uuid(),
  storage_path: z.string(), // Required - all files stored in storage
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
});

// Response schema field type
export const NestedResponseSchemaFieldSchema = z.object({
  name: z.string(),
  type: z.enum([
    'str',
    'int',
    'float',
    'bool',
    'list[str]',
    'list[int]',
    'file_pointer',
    'list[file_pointer]',
    'session_file_pointer',
    'list[session_file_pointer]',
  ]),
});

export const ResponseSchemaFieldSchema = z
  .object({
    name: z.string(),
    type: z.enum([
      'str',
      'int',
      'float',
      'bool',
      'list[str]',
      'list[int]',
      'object',
      'list[object]',
      'file_pointer',
      'list[file_pointer]',
      'session_file_pointer',
      'list[session_file_pointer]',
    ]),
    required: z.boolean(),
    properties: z.array(NestedResponseSchemaFieldSchema).optional(),
  })
  .superRefine((field, ctx) => {
    if (
      (field.type === 'object' || field.type === 'list[object]') &&
      (!field.properties || field.properties.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'object and list[object] fields must include explicit properties',
        path: ['properties'],
      });
    }
  });

// Response schema type (passed by parent agent for sub-agents)
export const ResponseSchemaSchema = z.object({
  fields: z.array(ResponseSchemaFieldSchema),
});

// Validation schemas
export const createAgentSchema = z.object({
  // Optional caller-supplied agent id. When set, the row is created with this
  // exact id (instead of randomUUID()) so the caller's batch retry is
  // idempotent. Used by the spawn_sub_agents_batch worker activity, which
  // mints child ids upfront and passes the same ids on retry.
  agent_id: z.string().uuid().optional(),
  goal: z.string().min(1),
  model: z.string().optional().default('rose-labs/rose-1-ultra'),
  reasoning_max_tokens: z.number().int().min(0).optional().default(256),
  source: z.enum(['WEB', 'MAC_APP', 'SMS']).optional().default('WEB'),
  start_phase: z.enum(['plan', 'execute']).optional(), // Optional: bypass chat mode and start Temporal workflow directly
  task_queue: z.string().optional(), // Optional: for test isolation
  user_id: z.string().optional(), // Optional: for internal auth (sub-agent creation)
  parent_agent_id: z.string().uuid().optional(), // Optional: parent agent ID (for hierarchy)
  parent_workflow_id: z.string().optional(), // Optional: for sub-agents to signal parent
  depth: z.number().int().min(0).max(4).optional().default(0), // Nesting depth (max 4)
  pause_state: z.boolean().optional().default(false), // Optional: inherit parent's pause state
  // Response schema: passed by parent agent for sub-agents (required for sub-agents, generated async for root agents)
  response_schema: ResponseSchemaSchema.optional(),
  bus_id: z.string().uuid().optional(), // Optional: shared bus channel for sub-agent tree updates
  max_iterations: z.number().int().min(1).optional(), // Optional: step limit for execute phase (sub-agents use 25)
  price_limit_cents: z.number().int().min(1).optional(), // Price limit in cents (default 100 = $1.00)
  write_lock_enabled: z.boolean().optional(), // Write lock for browser agent actions
  // Verifier is now optional and schema-driven only - the only per-agent
  // signal is the response_schema; type is fixed to FLOAT_LLM_JUDGE.
  verifier: z
    .object({
      type: z.literal('FLOAT_LLM_JUDGE'),
    })
    .optional(),
  // Context gates: control which user context sections the agent receives (default all true)
  context_gates: z
    .object({
      user_profile: z.boolean().optional(),
      authenticated_sessions: z.boolean().optional(),
      integrations: z.boolean().optional(),
      recent_communications: z.boolean().optional(),
      network: z.boolean().optional(),
      custom_system_prompt: z.boolean().optional(),
      shared_files: z.boolean().optional(),
    })
    .optional(),
  // File attachments for the initial goal message
  attachments: z.array(filePointerSchema).optional(),
  // Fast Mode aggressive cache: record/replay third-party responses for clean demos.
  // Own first-class flag — NOT a context gate. Default off (no read, no write).
  fast_mode_cache_enabled: z.boolean().optional(),
  // Provider/environment execution mode. Defaults to real at the DB and
  // workflow boundaries; sub-agents inherit their parent's persisted mode.
  world_model_mode: z.enum(['real', 'simulate', 'shadow']).optional(),
});

export const postMessageSchema = z.object({
  message: z.string().min(0), // Actual message content (tool result, assistant response, etc)
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']).optional(),
  metadata: z.record(z.any()).optional(), // JSON metadata about the tool call (toolCallId, toolName, status, etc)
  attachments: z.array(filePointerSchema).optional(), // File attachments (array, creates separate messages)
  file_pointer: filePointerSchema.optional(), // Single file pointer for this message (OAI-style)
});

export const updateStatusSchema = z.object({
  status: z.enum([
    'STARTING_UP',
    'ACTIVE',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'OUT_OF_CREDITS',
    'COST_LIMIT_REACHED',
  ]),
  statusMessage: z.string().optional(),
  progress: z.number().min(0).max(1),
  tokenCount: z.number().int().min(0),
  tokensIn: z.number().int().min(0).optional().default(0),
  tokensOut: z.number().int().min(0).optional().default(0),
  contextSize: z.number().int().min(0),
  messageCount: z.number().int().min(0),
  structuredResponse: z.record(z.unknown()).optional(),
});

export const updateAgentSchema = z.object({
  model: z.string().optional(),
  reasoning_max_tokens: z.number().int().min(0).optional(),
  tool_ids: z.array(z.string().uuid()).optional(),
  tools_in_use: z.array(z.string()).optional(), // For tree state updates
  progress: z.number().min(0).max(1).optional(), // For tree state updates
  message_count: z.number().int().min(0).optional(), // For tree state updates
  response_schema: ResponseSchemaSchema.optional(), // For storing generated schema during set_plan
  price_limit_cents: z.number().int().min(1).optional(), // User sets this (min 1 cent)
  tree_cost_cents: z.number().int().min(0).optional(), // Workflow updates this
  own_cost_cents: z.number().min(0).optional(), // Workflow updates this (actual_model-aware cost)
  write_lock_enabled: z.boolean().optional(), // Write lock for browser agent actions
  status: z
    .enum([
      'STARTING_UP',
      'ACTIVE',
      'PAUSED',
      'COMPLETED',
      'FAILED',
      'OUT_OF_CREDITS',
      'COST_LIMIT_REACHED',
    ])
    .optional(), // For tree state status updates
});

export const generateSchemaRequestSchema = z.object({
  goal: z.string().min(1),
});

// Batch creation: up to 200 children in one HTTP call, used by the
// spawn_sub_agents_batch worker activity. Each child must include `agent_id`
// (worker mints them upfront) so the call is idempotent on retry.
export const BATCH_CREATE_MAX = 200;
export const batchCreateAgentsSchema = z.object({
  agents: z
    .array(createAgentSchema.extend({ agent_id: z.string().uuid() }))
    .min(1)
    .max(BATCH_CREATE_MAX),
});

export type CreateAgentBody = z.infer<typeof createAgentSchema>;
export type BatchCreateAgentsBody = z.infer<typeof batchCreateAgentsSchema>;
export type PostMessageBody = z.infer<typeof postMessageSchema>;
export type UpdateStatusBody = z.infer<typeof updateStatusSchema>;
export type UpdateAgentBody = z.infer<typeof updateAgentSchema>;
