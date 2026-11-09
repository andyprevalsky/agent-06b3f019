/**
 * Request schemas for agent-tree navigation and addressing (GET /:id/tree,
 * GET /:id/resolve-address, tree-state background tasks). Re-exported by types.ts.
 */

import { z } from 'zod';

// One in-flight background task owned by an agent, persisted on Agent.backgroundTasks.
export const BACKGROUND_TASKS_MAX = 50;
export const backgroundTaskEntrySchema = z.object({
  address: z.string().min(1).max(200),
  type: z.string().min(1).max(40),
  goal: z.string().max(200),
  status: z.string().min(1).max(40),
  started_at: z.string().max(40).nullable().optional(),
  // Codex-style path `<owner path>/<task_name>`; null when the owner has no path.
  task_name: z.string().max(60).nullable().optional(),
  path: z.string().max(400).nullable().optional(),
  // The owner's workflow holds a wake record for this finished task (not a foreground
  // spawn, not an older record): only then can it start the task's next run.
  wakeable: z.boolean().optional(),
});
export type BackgroundTaskEntry = z.infer<typeof backgroundTaskEntrySchema>;

// GET /:id/tree navigation. Out-of-range numbers clamp instead of failing so a
// model asking for depth=10 still gets the deepest allowed view.
export const AGENT_TREE_DEFAULT_DEPTH = 1;
export const AGENT_TREE_MAX_DEPTH = 3;
export const AGENT_TREE_DEFAULT_LIMIT = 20;
export const AGENT_TREE_MAX_LIMIT = 50;
const clampedInt = (fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .optional()
    .transform((value) => Math.min(max, Math.max(1, value ?? fallback)));
// Any address accepted by agentAddressResolver.ts: "/root/...", "parent", or an agent id.
export const agentAddressSchema = z.string().trim().min(1).max(400);
export const agentTreeQuerySchema = z.object({
  node: agentAddressSchema.optional(),
  path_prefix: agentAddressSchema.optional(),
  depth: clampedInt(AGENT_TREE_DEFAULT_DEPTH, AGENT_TREE_MAX_DEPTH),
  limit: clampedInt(AGENT_TREE_DEFAULT_LIMIT, AGENT_TREE_MAX_LIMIT),
  cursor: z.string().min(1).max(200).optional(),
  q: z
    .string()
    .max(200)
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim())),
});
export type AgentTreeQuery = z.infer<typeof agentTreeQuerySchema>;
export const resolveAddressQuerySchema = z.object({ address: agentAddressSchema });
