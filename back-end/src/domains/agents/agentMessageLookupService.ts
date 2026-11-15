/**
 * Agent message lookups by ID and response-schema generation.
 */

import {
  generateResponseSchema,
  type ResponseSchemaDirectAuth,
} from '../../providers/setResponseSchema';
import * as repo from './repo';

// ---------------------------------------------------------------------------
// Batch message lookup (context pointer resolution)
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 50;

/** Fetch messages by IDs for context pointer resolution. Scoped to user's agents. */
export async function getMessagesBatch(ids: unknown, userId: string) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'ids must be a non-empty array', status: 400 };
  }

  if (ids.length > MAX_BATCH_SIZE) {
    return { error: `Maximum ${MAX_BATCH_SIZE} IDs per batch request`, status: 400 };
  }

  const messages = await repo.findMessagesByIds(ids as string[], userId);
  return { messages };
}

// ---------------------------------------------------------------------------
// Generate response schema
// ---------------------------------------------------------------------------

/**
 * Generate response schema for a goal (used by browser agent). The call is
 * archived under the caller's per-user root `user-<userId>`; an internal call
 * without a user is refused by the archive writer (logged, never misfiled).
 */
export async function generateSchema(
  goal: string,
  directAuth?: ResponseSchemaDirectAuth,
  userId?: string | null
) {
  return generateResponseSchema(goal, { directAuth, archive: { archive_scope: { userId } } });
}

// ---------------------------------------------------------------------------
// Batch fetch messages
// ---------------------------------------------------------------------------

/** Fetch messages by IDs, scoped to the requesting user. */
export async function batchFetchMessages(ids: string[], userId: string) {
  const messages = await repo.findMessagesByIds(ids, userId);
  return { messages };
}
