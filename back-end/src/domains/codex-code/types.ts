import { z } from 'zod';
import type { FilePointer } from '../../providers/storage';

export const createSessionSchema = z.object({
  agent_id: z.string().uuid(),
  goal: z.string().min(1),
  attachments: z.array(z.any()).optional(),
  github_repo_url: z.string().optional(),
  user_id: z.string().uuid(),
  fast_mode_cache_enabled: z.boolean().optional(),
  memory_enabled: z.boolean().optional(),
  harness_mode: z.enum(['code', 'rose']).optional(),
  rose_api_base_url: z.string().url().optional(),
  code_session_id: z.string().uuid().optional(),
  lease_owner: z.string().min(1).max(200).optional(),
  base_branch: z.string().min(1).max(255).optional(),
});

export const closeSessionSchema = z.object({
  task_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  additional_paths: z.array(z.string()).optional(),
  reason: z.string().min(1).max(64).optional(),
});

export interface CreateSessionParams {
  agent_id: string;
  goal: string;
  attachments?: FilePointer[];
  github_repo_url?: string;
  user_id: string;
  fast_mode_cache_enabled?: boolean;
  memory_enabled?: boolean;
  harness_mode?: 'code' | 'rose';
  rose_api_base_url?: string;
  code_session_id?: string;
  lease_owner?: string;
  base_branch?: string;
}

export interface CloseSessionParams {
  task_id: string;
  user_id?: string;
  agent_id?: string;
  additional_paths?: string[];
  reason?: string;
}

/** POST /:taskId/usage-limit — Codex stopped on a provider usage limit (C15). */
export const codeTaskUsageLimitSchema = z.object({
  // Epoch seconds/ms or ISO time the provider reports the limit resets.
  resets_at: z.union([z.number().positive(), z.string().min(1).max(64)]).optional(),
});
