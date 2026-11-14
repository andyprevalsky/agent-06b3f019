/**
 * Agent message lookups by ID and response-schema generation.
 */

import { recordSchemaArchiveLink } from '../../providers/schemaArchiveLinks';
import {
  generateResponseSchema,
  type ResponseSchemaArchiveBinding,
  type ResponseSchemaDirectAuth,
} from '../../providers/setResponseSchema';
import { userArchiveRoot } from '../../providers/llmArchiveRecord';
import { rootOf } from './agentTaskPath';
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
export async function generateSchema(
  goal: string,
  directAuth?: ResponseSchemaDirectAuth,
  target: { agentId?: string; userId?: string | null; isInternal?: boolean } = {}
) {
  return generateResponseSchema(goal, { directAuth, archive: await schemaArchiveBinding(target) });
}

/**
 * Archive binding for a schema-generation call:
 *   agent_id of the caller's own (or, internally, any) agent → that tree's root
 *   unknown / pre-allocated / another user's id               → caller's `user-<userId>` root,
 *                                                               keeping the requested id as a link
 *   no agent id                                               → caller's `user-<userId>` root
 * An id never binds a record into another user's bundle.
 */
export async function schemaArchiveBinding(target: {
  agentId?: string;
  userId?: string | null;
  isInternal?: boolean;
}): Promise<ResponseSchemaArchiveBinding | undefined> {
  const userRoot =
    typeof target.userId === 'string' && target.userId !== ''
      ? userArchiveRoot(target.userId)
      : null;
  if (target.agentId !== undefined) {
    const agent = await repo.findAgentArchiveIdentity(target.agentId);
    if (agent !== null && (target.isInternal === true || agent.userId === target.userId)) {
      return {
        agent_id: target.agentId,
        root_agent_id: rootOf({ id: target.agentId, busId: agent.busId }),
      };
    }
    if (userRoot !== null) {
      const { agentId } = target;
      const userId = target.userId as string;
      return {
        agent_id: userRoot,
        root_agent_id: userRoot,
        extra: { requested_agent_id: agentId },
        // Creating `agentId` later (same user) copies these records into its root.
        on_record: (objectPath) => recordSchemaArchiveLink(userId, agentId, objectPath),
      };
    }
  }
  return userRoot === null ? undefined : { agent_id: userRoot, root_agent_id: userRoot };
}

// ---------------------------------------------------------------------------
// Batch fetch messages
// ---------------------------------------------------------------------------

/** Fetch messages by IDs, scoped to the requesting user. */
export async function batchFetchMessages(ids: string[], userId: string) {
  const messages = await repo.findMessagesByIds(ids, userId);
  return { messages };
}
