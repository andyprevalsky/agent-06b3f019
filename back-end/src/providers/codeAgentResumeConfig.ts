import { z } from 'zod';
import { codeCliSettingsSchema } from './codeCliSettings';
import type { CodeCliSettingsOverride } from './codeAgentModels';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)])
);

/** Only durable task inputs; launcher credentials and control environment never belong here. */
export const codeAgentResumeConfigSchema = z
  .object({
    spawn_args: z
      .object({
        type: z.literal('code'),
        goal: z.string(),
        output_schema: z
          .record(json)
          .refine((value) => Array.isArray(value.fields), 'fields is required'),
        github_repo_link: z
          .string()
          .refine((value) => {
            // Preserve credential-free clone URLs, including Git's SCP-style SSH form.
            if (/^git@[^:]+:.+/.test(value)) return true;
            try {
              const url = new URL(value);
              return (
                url.username === '' && url.password === '' && url.search === '' && url.hash === ''
              );
            } catch {
              return false;
            }
          }, 'A credential-free repository URL is required')
          .nullable(),
        target: z.enum(['cloud', 'local']),
        task_name: z.string().nullable(),
        // The spawn's explicit connected-repo selection; a resumed run keeps it (agents
        // workflows/code_agent_resume.py copies spawn_args into the next tool call).
        github_repo_ref: z.string().trim().min(1).max(300).optional(),
        attachments: z.array(z.string()),
      })
      .strict(),
    attachments: z.array(
      z
        .object({
          id: z.string(),
          storage_path: z.string(),
          original_filename: z.string(),
          mime_type: z.string(),
          size_bytes: z.number().nonnegative(),
          created_at: z.string(),
          created_by_agent_id: z.string().optional(),
          auto_captured: z.boolean().optional(),
        })
        .strict()
    ),
    model: z.string().min(1),
    fast_mode_cache_enabled: z.boolean(),
    source_code_provider: z.enum(['claude', 'codex']).optional(),
  })
  .strict();

export type CodeAgentResumeConfig = z.infer<typeof codeAgentResumeConfigSchema>;

/** Credential failover keeps portable settings, never a model from another provider. */
export function compatibleResumeCliSettings(
  provider: 'claude' | 'codex',
  source: 'claude' | 'codex' | undefined,
  settings: CodeCliSettingsOverride | null | undefined
) {
  if (settings === null || settings === undefined) return undefined;
  const compatible = { ...settings };
  if (source !== undefined && source !== provider) delete compatible.model;
  return compatible;
}

const executionSchema = z
  .object({
    github_repo_link: codeAgentResumeConfigSchema.shape.spawn_args.shape.github_repo_link,
    target: z.enum(['cloud', 'local']),
    code_session_id: z.string().uuid().nullable(),
  })
  .strict();

export function spawnToolCallId(
  agentId: string,
  leaseOwner: string | null | undefined
): string | null {
  const prefix = `tool:${agentId}:`;
  return leaseOwner?.startsWith(prefix) && leaseOwner.length > prefix.length
    ? leaseOwner.slice(prefix.length)
    : null;
}

/** Reject invalid snapshot ownership at either create API before launch side effects. */
export function validateCodeResumeLease(
  input: { agent_id: string; lease_owner?: string; resume_config?: CodeAgentResumeConfig },
  ctx: z.RefinementCtx
): void {
  if (
    input.resume_config !== undefined &&
    spawnToolCallId(input.agent_id, input.lease_owner) === null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lease_owner'],
      message: 'resume_config requires the owning spawn lease_owner',
    });
  }
}

export interface CodeResumeConfigInput {
  agentId: string;
  taskId: string;
  leaseOwner?: string | null;
  resumeConfig?: CodeAgentResumeConfig;
  provider: 'claude' | 'codex';
  envs: Record<string, string | undefined>;
  execution?: z.infer<typeof executionSchema>;
}

/** A pure serialization boundary: inspect only the provider's three CLI setting keys. */
export function codeResumeConfigMessage(input: CodeResumeConfigInput) {
  if (input.resumeConfig === undefined) return null;
  const toolCallId = spawnToolCallId(input.agentId, input.leaseOwner);
  if (toolCallId === null) {
    throw new Error('resume_config requires the owning spawn lease_owner');
  }
  const config = codeAgentResumeConfigSchema.parse(input.resumeConfig);
  const claude = input.provider === 'claude';
  const cliSettings = codeCliSettingsSchema.required().parse({
    model: input.envs[claude ? 'CLAUDE_CODE_MODEL' : 'CODEX_MODEL'],
    reasoning_effort: input.envs[claude ? 'CLAUDE_CODE_EFFORT' : 'CODEX_REASONING_EFFORT'],
    speed: input.envs[claude ? 'CLAUDE_CODE_SPEED' : 'CODEX_SPEED'],
  });
  return {
    agentId: input.agentId,
    role: 'TOOL' as const,
    text: '',
    skipBroadcast: true,
    metadata: {
      action_type: 'code_resume_config',
      // A snapshot precedes launch: it must not look like an actual task/chip row.
      codeResumeTaskId: input.taskId,
      toolCallId,
      hidden: true,
      excludeFromModel: true,
      idempotencyKey: `code-resume-config:${input.taskId}`,
      codeAgentResumeConfig: {
        version: 1,
        ...config,
        cli_settings: cliSettings,
        code_provider: input.provider,
        ...(input.execution === undefined
          ? {}
          : { execution: executionSchema.parse(input.execution) }),
      },
    },
  };
}
