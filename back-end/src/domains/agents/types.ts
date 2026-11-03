/**
 * Agents domain types — Zod schemas, TS interfaces, type aliases.
 */

import { z } from 'zod';
import { BACKGROUND_TASKS_MAX, backgroundTaskEntrySchema } from './typesAgentTree';
import { ResponseSchemaSchema } from './responseSchema';

export {
  NestedResponseSchemaFieldSchema,
  ResponseSchemaFieldSchema,
  ResponseSchemaSchema,
} from './responseSchema';

export * from './typesAgentTree';
export * from './typesAgentMessages';
export * from './typesAgentControl';
export type { Prisma } from '@prisma/client';

// FilePointer schema for validation - all files stored in Supabase Storage
export const filePointerSchema = z.object({
  id: z.string().uuid(),
  storage_path: z.string(), // Required - all files stored in storage
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
  // Set by the Mac quick launcher on the screenshot it attaches automatically.
  auto_captured: z.boolean().optional(),
});

// Validation schemas
const createAgentBaseSchema = z.object({
  // Optional caller-supplied agent id. When set, the row is created with this
  // exact id (instead of randomUUID()) so the caller's batch retry is
  // idempotent. Used by the spawn_sub_agents_batch worker activity, which
  // mints child ids upfront and passes the same ids on retry.
  agent_id: z.string().uuid().optional(),
  goal: z.string().min(1),
  model: z.string().optional().default('rose-labs/rose-1-ultra'),
  reasoning_max_tokens: z.number().int().min(0).optional().default(256),
  source: z.enum(['WEB', 'MAC_APP', 'SMS']).optional().default('WEB'),
  start_phase: z.enum(['plan', 'execute', 'browser']).optional(), // Optional: bypass chat mode and start Temporal workflow directly
  task_queue: z.string().optional(), // Optional: for test isolation
  user_id: z.string().optional(), // Optional: for internal auth (sub-agent creation)
  parent_agent_id: z.string().uuid().optional(), // Optional: parent agent ID (for hierarchy)
  // Sub-agents: slug unique among the parent's live children; the child's
  // address becomes `<parent path>/<task_name>` (409 on a sibling collision).
  task_name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,59}$/, 'task_name must be a lowercase slug (a-z, 0-9, _)')
    .optional(),
  parent_workflow_id: z.string().optional(), // Optional: for sub-agents to signal parent
  depth: z.number().int().min(0).max(4).optional().default(0), // Nesting depth (max 4)
  pause_state: z.boolean().optional().default(false), // Optional: inherit parent's pause state
  // Response schema: passed by parent agent for sub-agents (required for sub-agents, generated async for root agents)
  response_schema: ResponseSchemaSchema.optional(),
  bus_id: z.string().uuid().optional(), // Optional: shared bus channel for sub-agent tree updates
  max_iterations: z.number().int().min(1).optional(), // Optional: step limit for execute phase (sub-agents use 25)
  price_limit_cents: z.number().int().min(1).optional(), // Defaults to $10.00
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
  // DEMO cache: record/replay third-party responses for clean demos.
  // Own first-class flag — NOT a context gate. Default off (no read, no write).
  fast_mode_cache_enabled: z.boolean().optional(),
  // Provider speed forwarded to every LLM leg (providers/rose/speed.ts).
  // Absent: the legacy fast_mode_cache_enabled=true means fast; otherwise a
  // sub-agent inherits its parent's speed and a root runs standard.
  speed: z.enum(['standard', 'fast', 'ultrafast']).optional(),
  // Planner memory: retrieve compressed past trajectories for similar goals and
  // fork a get_memories tool call into the planner context. Own first-class
  // flag (not a context gate). Default off; sub-agents inherit their parent's.
  memory_enabled: z.boolean().optional(),
  /** Owning Project (left-bar grouping); sub-agents inherit the parent's when omitted. */
  project_id: z.string().uuid().nullable().optional(),
  folder_id: z.string().uuid().nullable().optional(),
  // Provider/environment execution mode. Defaults to real at the DB and
  // workflow boundaries; sub-agents inherit their parent's persisted mode.
  world_model_mode: z.enum(['real', 'simulate', 'shadow']).optional(),
  // "New agent in this branch": this agent's code-agent spawns work in the
  // named agent's code session (same worktree, branch and CLI conversation)
  // instead of getting their own branch. Must be an agent the caller owns.
  share_code_session_with: z.string().uuid().optional(),
});

function validateParentWorkflowPair(
  body: { parent_agent_id?: string; parent_workflow_id?: string },
  ctx: z.RefinementCtx
): void {
  if (body.parent_agent_id !== undefined && body.parent_workflow_id === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'parent_workflow_id is required for sub-agents',
      path: ['parent_workflow_id'],
    });
  }
  if (body.parent_agent_id === undefined && body.parent_workflow_id !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'parent_agent_id is required with parent_workflow_id',
      path: ['parent_agent_id'],
    });
  }
}

export const createAgentSchema = createAgentBaseSchema.superRefine(validateParentWorkflowPair);

export const postMessageSchema = z.object({
  message: z.string().min(0), // Actual message content (tool result, assistant response, etc)
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']).optional(),
  metadata: z.record(z.any()).optional(), // JSON metadata about the tool call (toolCallId, toolName, status, etc)
  attachments: z.array(filePointerSchema).optional(), // File attachments (array, creates separate messages)
  file_pointer: filePointerSchema.optional(), // Single file pointer for this message (OAI-style)
  // User Browser composer: deliver this USER message straight to the agent's
  // running browser task (BrowserSession.id), not to the agent's own loop.
  browser_task_id: z.string().min(1).max(200).optional(),
  // Internal callers only: piggyback one task-inbox read (explore progress posts);
  // the response carries `pending_inbox` rows addressed to `task_id` after `since`.
  inbox: z
    .object({
      task_id: z.string().min(1).max(200),
      since: z.coerce.date().optional(),
    })
    .optional(),
});

export const progressEstimateSchema = z.object({
  progress: z.number().min(0).max(1),
  etaSeconds: z.number().min(60).max(31536000),
  observedAt: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  model: z.literal('jev-1.13.0'),
  promptVersion: z.string(),
  taskId: z.string().optional(),
});

export const updateProgressEstimateSchema = z.object({
  progressEstimate: progressEstimateSchema.nullable(),
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
  iterationOffset: z.number().int().min(0).optional(),
  structuredResponse: z.record(z.unknown()).optional(),
});

export const updateAgentSchema = z.object({
  project_id: z.string().uuid().nullable().optional(),
  folder_id: z.string().uuid().nullable().optional(),
  // Sidebar rename. `null` clears the override and falls back to the goal.
  title: z.string().trim().min(1).max(80).nullable().optional(),
  // Internal schema-generator candidate. Applied only to an untitled root agent,
  // so a concurrent human rename always wins and sub-agents never store titles.
  generated_title: z.string().trim().min(1).max(80).optional(),
  // Sidebar pin toggle — maps to Agent.pinnedAt (now / null).
  pinned: z.boolean().optional(),
  model: z.string().optional(),
  reasoning_max_tokens: z.number().int().min(0).optional(),
  tool_ids: z.array(z.string().uuid()).optional(),
  tools_in_use: z.array(z.string()).optional(), // For tree state updates
  // In-flight background explore/browser/code tasks (tree state; list_agents).
  background_tasks: z.array(backgroundTaskEntrySchema).max(BACKGROUND_TASKS_MAX).optional(),
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

// Archived (soft-deleted) agent listing. Bounded on purpose: the archive grows
// monotonically for the lifetime of an account, so an unbounded read would
// degrade linearly with agent count.
export const ARCHIVED_AGENTS_DEFAULT_LIMIT = 100;
export const ARCHIVED_AGENTS_MAX_LIMIT = 200;
export const listArchivedAgentsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ARCHIVED_AGENTS_MAX_LIMIT)
    .optional()
    .default(ARCHIVED_AGENTS_DEFAULT_LIMIT),
});

// Sidebar search is deliberately bounded even though an account's chat history
// grows forever. The query fans into Message.text, so accepting arbitrarily
// large needles or returning the whole account would make a keystroke an
// unbounded database operation.
export const AGENT_SEARCH_RESULT_LIMIT = 100;
export const searchAgentsQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});

// Batch creation: up to 200 children in one HTTP call, used by the
// spawn_sub_agents_batch worker activity. Each child must include `agent_id`
// (worker mints them upfront) so the call is idempotent on retry.
export const BATCH_CREATE_MAX = 200;
export const batchCreateAgentsSchema = z.object({
  agents: z
    .array(
      createAgentBaseSchema
        .extend({ agent_id: z.string().uuid() })
        .superRefine(validateParentWorkflowPair)
    )
    .min(1)
    .max(BATCH_CREATE_MAX),
});

export type CreateAgentBody = z.infer<typeof createAgentSchema>;
export type BatchCreateAgentsBody = z.infer<typeof batchCreateAgentsSchema>;
export type PostMessageBody = z.infer<typeof postMessageSchema>;
export type UpdateStatusBody = z.infer<typeof updateStatusSchema>;
export type UpdateAgentBody = z.infer<typeof updateAgentSchema>;
