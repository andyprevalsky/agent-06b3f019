/**
 * A person's model / effort / speed for the turn that resumes a stopped code
 * agent (claude-code-session and codex-code-session create `cli_settings`):
 * codeAgentCliEnvs applies them to that run's CLI env (cliSettingsEnvOverrides).
 */
import { z } from 'zod';

export const codeCliSettingsSchema = z.object({
  model: z.string().trim().min(1).max(128).optional(),
  reasoning_effort: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    .optional(),
  speed: z.enum(['standard', 'fast', 'ultrafast', 'priority']).optional(),
});
