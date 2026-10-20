/**
 * Claude Code domain types — Zod schemas and TypeScript interfaces.
 */

import { z } from 'zod';
import type { FilePointer } from '../../providers/storage';
import type { ProjectRestoreReport } from '../../providers/projects/types';

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
  // Persistent code session to resume; omitted → the root's latest for this repo.
  code_session_id: z.string().uuid().optional(),
  // Stable per tool call so Temporal retries of one spawn keep their lease.
  lease_owner: z.string().min(1).max(200).optional(),
  // Project default branch a new root session's branch is cut from (default: the repo's).
  base_branch: z.string().min(1).max(255).optional(),
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
  // Why the session is closing (close | failure | cancel | drain | timeout); recorded on the checkpoint.
  reason: z.string().min(1).max(64).optional(),
});

export const codeSessionCheckpointSchema = z.object({
  task_id: z.string().uuid(),
  reason: z.string().min(1).max(64).optional(),
});

export interface CreateSessionParams {
  agent_id: string;
  goal: string;
  attachments?: FilePointer[];
  github_repo_url?: string;
  user_id?: string;
  code_session_id?: string;
  lease_owner?: string;
  base_branch?: string;
  /** Explicit Project; defaults to the agent's (or its root's) project. */
  project_id?: string;
}

export interface CreateSessionResult {
  task_id: string;
  sandbox_id: string;
  ws_url: string;
  uploaded_files: string[];
  github_repo_url: string | null;
  code_session_id: string | null;
  resumed_from: string;
  cli_session_id: string | null;
  branch: string | null;
  base_branch: string | null;
  merge_target: string | null;
  parent_code_session_id: string | null;
  /** Restore summary when the session materialized a Project (PJ3). */
  project: ProjectRestoreReport | null;
}

export interface CloseSessionParams {
  task_id: string;
  user_id?: string;
  agent_id?: string;
  additional_paths?: string[];
  reason?: string;
}

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
