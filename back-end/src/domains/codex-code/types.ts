import { z } from 'zod';

export const createSessionSchema = z.object({
  agent_id: z.string().uuid(),
  goal: z.string().min(1),
  attachments: z.array(z.any()).optional(),
  github_repo_url: z.string().optional(),
  user_id: z.string().uuid(),
  fast_mode_cache_enabled: z.boolean().optional(),
});

export const closeSessionSchema = z.object({
  task_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  additional_paths: z.array(z.string()).optional(),
});
