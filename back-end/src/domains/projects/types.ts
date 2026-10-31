/**
 * Projects domain request schemas (Zod). Secret values only ever appear in
 * env-file write bodies (`variables[].value`, `content`) and are encrypted
 * before persistence; no response schema carries them.
 */
import { z } from 'zod';
/** Limits shared with config.ts (types may not import other layers). */
export const DEFAULT_STARTUP_TIMEOUT_S = 120;
export const MIN_STARTUP_TIMEOUT_S = 1;
export const MAX_STARTUP_TIMEOUT_S = 3600;
export const MAX_STARTUP_SCRIPT_BYTES = 64 * 1024;
/** Plaintext size cap for one env/config file. */
export const MAX_ENV_FILE_BYTES = 256 * 1024;

const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/, 'invalid branch name');

const repoUrlSchema = z.string().trim().min(1).max(500).nullable();

const lifecycleSchema = z.object({ autoWake: z.boolean().optional() }).strict();

/** Upper bounds for a project's default code-sandbox size (C16). */
export const MAX_SANDBOX_CPU = 64;
export const MAX_SANDBOX_MEMORY_GB = 256;

/**
 * Default sandbox size of the project's new code sessions: vCPUs and/or memory
 * (GB); a missing dimension takes the deployment default, null clears it. The
 * closest built template that satisfies it is used.
 */
const sandboxSizeSchema = z
  .object({
    cpu: z.number().int().min(1).max(MAX_SANDBOX_CPU).optional(),
    memoryGb: z.number().int().min(1).max(MAX_SANDBOX_MEMORY_GB).optional(),
  })
  .strict()
  .refine((size) => size.cpu !== undefined || size.memoryGb !== undefined, {
    message: 'give cpu, memoryGb or both',
  })
  .nullable();

const settingsShape = {
  repoUrl: repoUrlSchema.optional(),
  defaultBranch: branchSchema.optional(),
  startupScript: z.string().max(MAX_STARTUP_SCRIPT_BYTES).nullable().optional(),
  startupTimeoutS: z
    .number()
    .int()
    .min(MIN_STARTUP_TIMEOUT_S)
    .max(MAX_STARTUP_TIMEOUT_S)
    .optional(),
  lifecycle: lifecycleSchema.optional(),
  sandboxSize: sandboxSizeSchema.optional(),
};

const projectNameSchema = z.string().trim().min(1).max(100);

export const createProjectSchema = z.object({ name: projectNameSchema, ...settingsShape }).strict();

export const updateProjectSchema = z
  .object({ name: projectNameSchema.optional(), ...settingsShape })
  .strict();

/** PUT /api/projects — upsert by name (rose-sync / seeds). */
export const upsertProjectSchema = createProjectSchema;

export const projectFolderSchema = z.object({ name: projectNameSchema }).strict();

export const projectIdSchema = z.string().uuid();

export const projectFolderOrderSchema = z
  .object({
    folderIds: z
      .array(projectIdSchema.transform((id) => id.toLowerCase()))
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'folderIds must be unique' }),
  })
  .strict();

const variableNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/, 'invalid variable name');

export const envVariableInputSchema = z
  .object({
    name: variableNameSchema,
    value: z.string().max(MAX_ENV_FILE_BYTES).optional(),
    description: z.string().max(500).optional(),
  })
  .strict();

export const createEnvFileSchema = z
  .object({
    path: z.string().min(1).max(300),
    description: z.string().max(500).nullable().optional(),
    variables: z.array(envVariableInputSchema).max(500).optional(),
    /** Full dotenv content (paste/import). Mutually exclusive with values in `variables`. */
    content: z.string().max(MAX_ENV_FILE_BYTES).optional(),
    /** Declared files have no values yet; codebase sync fills them. */
    declared: z.boolean().optional(),
  })
  .strict();

export const updateEnvFileSchema = z
  .object({
    path: z.string().min(1).max(300).optional(),
    description: z.string().max(500).nullable().optional(),
    variables: z.array(envVariableInputSchema).max(500).optional(),
    removeVariables: z.array(variableNameSchema).max(500).optional(),
    content: z.string().max(MAX_ENV_FILE_BYTES).optional(),
  })
  .strict();

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const envelopeSchema = z.string().min(1);

export const syncFileSchema = z
  .object({
    path: z.string().min(1).max(300),
    kind: z.enum(['env', 'config']),
    fingerprint: fingerprintSchema,
    sizeBytes: z.number().int().min(0).max(MAX_ENV_FILE_BYTES),
    /** Variable names only (dotenv files); values stay inside the envelope. */
    variables: z.array(variableNameSchema).max(500).default([]),
    linkTarget: z.string().max(1000).nullable().optional(),
    /** Client-side credential envelope; omitted = unchanged since last sync. */
    encryptedContent: envelopeSchema.optional(),
  })
  .strict();

const syncArtifactSchema = z
  .object({ fingerprint: fingerprintSchema, encrypted: envelopeSchema.optional() })
  .strict()
  .nullable();

export const syncPushSchema = z
  .object({
    baseRevision: z.number().int().min(0),
    keyId: z.string().min(1).max(64),
    manifest: z.record(z.unknown()),
    files: z.array(syncFileSchema).max(200),
    /** Remove previously synced files that this push no longer lists (default true). */
    prune: z.boolean().optional(),
    gitBundle: syncArtifactSchema.optional(),
    uncommittedPatch: syncArtifactSchema.optional(),
  })
  .strict();

export type CreateProjectBody = z.infer<typeof createProjectSchema>;
export type UpdateProjectBody = z.infer<typeof updateProjectSchema>;
export type CreateEnvFileBody = z.infer<typeof createEnvFileSchema>;
export type UpdateEnvFileBody = z.infer<typeof updateEnvFileSchema>;
export type SyncPushBody = z.infer<typeof syncPushSchema>;
export type SyncFileBody = z.infer<typeof syncFileSchema>;
