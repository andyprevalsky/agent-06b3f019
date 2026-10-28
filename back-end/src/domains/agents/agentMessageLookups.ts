/**
 * Message lookups and response-schema generation for the agents message routes:
 * context-pointer batch reads and the browser agent's goal schema. Split from
 * agentMessageService to keep that module within the strict domain size limit.
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

/** Generate response schema for a goal (used by browser agent). */
export async function generateSchema(goal: string, directAuth?: ResponseSchemaDirectAuth) {
  return generateResponseSchema(goal, { directAuth });
}

// ---------------------------------------------------------------------------
// Batch fetch messages
// ---------------------------------------------------------------------------

/** Fetch messages by IDs, scoped to the requesting user. */
export async function batchFetchMessages(ids: string[], userId: string) {
  const messages = await repo.findMessagesByIds(ids, userId);
  return { messages };
}
