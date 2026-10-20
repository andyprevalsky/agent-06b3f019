/**
 * Claude Code domain types — Zod schemas and TypeScript interfaces.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const filePointerSchema = z.object({
  id: z.string(),
  storage_path: z.string().optional(),
  base64_data: z.string().optional(),
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
  created_by_agent_id: z.string().optional(),
});

export const createSessionSchema = z.object({
  agent_id: z.string().uuid(),
  goal: z.string(),
  attachments: z.array(filePointerSchema).optional(),
  github_repo_url: z.string().optional(),
  user_id: z.string().uuid().optional(), // Required for GitHub repo access check
  // C14: 'local' starts the session on the agent tree's Mac (Rose Mac app).
  target: z.enum(['cloud', 'local']).optional(),
  device_id: z.string().uuid().optional(),
  /** Project to restore; defaults to the agent's own (or its root's) project. */
  project_id: z.string().uuid().optional(),
});

export const closeSessionSchema = z.object({
  task_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  additional_paths: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((v) => v ?? undefined), // Additional file paths to extract (e.g., from verifier)
});

/** POST /api/agents/:id/code-agent/:taskId/messages — a user turn typed to the CLI. */
export const directTurnSchema = z.object({
  client_message_id: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  text: z.string().trim().min(1).max(100_000),
  tool_call_id: z.string().min(1).max(256).optional(),
  user_id: z.string().uuid().optional(), // internal callers only (API key)
});
