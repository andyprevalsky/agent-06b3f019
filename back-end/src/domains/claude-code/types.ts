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
  code_provider: string;
  provider_handoff: boolean;
  /** vCPUs / memory of the E2B sandbox (C16); null for a local session. */
  sandbox_size: { cpu: number; memory_gb: number } | null;
  /** Restore summary when the session materialized a Project (PJ3). */
  project: ProjectRestoreReport | null;
  /** Live dev-server preview URL (Rose dev accounts, A1); null otherwise. */
  preview_url: string | null;
}

export interface CloseSessionParams {
  task_id: string;
  user_id?: string;
  agent_id?: string;
  additional_paths?: string[];
  reason?: string;
}

/** POST /api/agents/:id/code-agent/:taskId/messages — a user turn typed to the CLI. */
export const directTurnSchema = z
  .object({
    client_message_id: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    text: z.string().trim().max(100_000).default(''),
    attachments: z
      .array(
        filePointerSchema.extend({ storage_path: z.string().min(1) }).omit({ base64_data: true })
      )
      .max(20)
      .optional(),
    model: z.string().trim().min(1).max(128).optional(),
    reasoning_effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    speed: z.enum(['standard', 'fast', 'ultrafast']).optional(),
    tool_call_id: z.string().min(1).max(256).optional(),
    user_id: z.string().uuid().optional(), // internal callers only (API key)
  })
  .refine((value) => value.text.length > 0 || (value.attachments?.length ?? 0) > 0);

/** POST /:taskId/usage-limit — the code agent stopped on a provider usage limit (C15). */
export const codeTaskUsageLimitSchema = z.object({
  // Epoch seconds/ms or ISO time the provider reports the limit resets.
  resets_at: z.union([z.number().positive(), z.string().min(1).max(64)]).optional(),
});

/** POST /:taskId/resize — the attached activity applies a pending size change (C16). */
export const codeTaskResizeSchema = z.object({ request_id: z.string().uuid() }).strict();

/** POST /:taskId/publish — push the session's branch and open a PR (A1; never merges). */
export const codePublishSchema = z
  .object({
    title: z.string().trim().min(1).max(256).optional(),
    body: z.string().max(20_000).optional(),
    draft: z.boolean().optional(),
  })
  .strict();

/** POST /api/preview-handoff/redeem — the one-time code from the preview URL fragment. */
export const previewHandoffRedeemSchema = z
  .object({
    code: z
      .string()
      .min(16)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

/** GET /credential-availability — can a Claude / Codex credential be leased now. */
export const credentialAvailabilityQuerySchema = z.object({
  user_id: z.string().min(1).max(200),
  // A local (Mac) run: count only the user's own logins.
  own_only: z.enum(['true', 'false']).optional(),
});
