import { z } from 'zod';
import { USER_UI_MAX_FILES } from '../../providers/userUi/manifest';

export {
  userUiManifestSchema,
  userUiThemeSchema,
  type UserUiManifest,
  type UserUiTheme,
} from '../../providers/userUi/manifest';

/** POST /api/user-ui/versions — the whole rose_user_ui folder, base64 per file. */
export const publishUserUiVersionSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        contentBase64: z.string(),
      })
    )
    .min(1)
    .max(USER_UI_MAX_FILES),
  activate: z.boolean().optional(),
});
export type PublishUserUiVersionBody = z.infer<typeof publishUserUiVersionSchema>;

export const userUiVersionIdSchema = z.string().uuid();

// ── User tools (internal: the agents worker, X-API-Key + X-User-Id) ──

/** sha256(root workflow id, tool call id), derived by the agents workflow. */
const idempotencyKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const userToolNameSchema = z.string().regex(/^[a-z0-9_]{1,48}$/);
const agentIdSchema = z.string().min(1).max(128);

/** One handler process run (same shape as the agents HandlerRun). */
export const userToolRunRecordSchema = z
  .object({
    returncode: z.number().int().nullable(),
    // 256 KB of stdout, base64.
    stdout_b64: z.string().max(360_000),
    stderr_tail: z.string().max(16_384),
    timed_out: z.boolean(),
    overflow: z.boolean(),
    executor: z.string().max(32),
    code_session_id: z.string().max(128).nullable().optional(),
  })
  .strict();

/** POST /api/user-ui/tool-calls/claim — claim a side-effecting call before its handler starts. */
export const userToolCallClaimSchema = z
  .object({
    idempotency_key: idempotencyKeySchema,
    agent_id: agentIdSchema,
    tool: userToolNameSchema,
    version_id: z.string().min(1).max(128),
    input_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** POST /api/user-ui/tool-calls/complete — store the run record (first write wins). */
export const userToolCallCompleteSchema = z
  .object({ idempotency_key: idempotencyKeySchema, run: userToolRunRecordSchema })
  .strict();

/** POST /api/user-ui/tool-calls/release — the handler never started; re-open the claim. */
export const userToolCallReleaseSchema = z
  .object({ idempotency_key: idempotencyKeySchema, error: z.string().max(500).optional() })
  .strict();

/** POST /api/user-ui/tools/run — run a handler in the caller's own code session. */
export const userToolRunSchema = z
  .object({
    agent_id: agentIdSchema,
    version_id: userUiVersionIdSchema,
    tool: userToolNameSchema,
    runtime: z.enum(['node', 'python']),
    entry: z.string().min(1).max(1024),
    files: z.array(z.string().min(1).max(1024)).min(1).max(64),
    timeout_s: z.number().int().min(1).max(300),
    input_json: z.string().max(256 * 1024),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .strict();
export type UserToolRunBody = z.infer<typeof userToolRunSchema>;
