/**
 * Postgres text and jsonb cannot store U+0000. Model or page output can still
 * contain it (run 7, 2026-10-20: a simulated explore result quoted a title as
 * "\u0000Rose Labs …"), and one such character made every retry of the
 * message write fail with 22021 until the tool result was lost.
 *
 *   caller params ──storableMessageParams──▶ idempotency/dedup keys ──▶ INSERT
 *
 * Removal happens before idempotency keys and duplicate checks so a retry of the
 * same write still matches the stored row.
 */

const NUL = '\u0000';

export interface CreateMessageParams {
  agentId: string;
  text: string;
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  metadata?: Record<string, unknown> | null;
  filePointer?: object | null;
  /** The caller generated a unique toolCallId inside a non-retried request. */
  skipDuplicateToolCheck?: boolean;
  /** Finalize lifecycle writes that do not belong to the Agent's current workflow. */
  enforceCurrentWorkflowGeneration?: boolean;
  /** Server-only authority to create a deployment fence. */
  allowDeploymentFinalizer?: boolean;
  /** Immutable Temporal Workflow ID that produced an internal message. */
  workflowGeneration?: string;
  /** Test/internal batch control; persistence semantics are unchanged. */
  skipBroadcast?: boolean;
}

export function withoutNulText(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, '') : value;
}

/** Recursively drop U+0000 from JSON strings and object keys; other values are unchanged. */
export function withoutNulJson<T>(value: T): T {
  if (typeof value === 'string') return withoutNulText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => withoutNulJson(item)) as T;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        withoutNulText(key),
        withoutNulJson(item),
      ])
    ) as T;
  }
  return value;
}

/** Postgres-storable message content; apply before any idempotency or duplicate key. */
export function storableMessageParams<
  T extends Pick<CreateMessageParams, 'text' | 'metadata' | 'filePointer'>,
>(params: T): T {
  return {
    ...params,
    text: withoutNulText(params.text),
    ...(params.metadata === undefined ? {} : { metadata: withoutNulJson(params.metadata) }),
    ...(params.filePointer === undefined
      ? {}
      : { filePointer: withoutNulJson(params.filePointer) }),
  };
}
