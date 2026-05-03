/**
 * Blueprints domain service -- business logic for blueprint search, CRUD, and feedback.
 *
 * Blueprints are temporarily disabled. The OpenAI-embedding-driven search and
 * create paths are short-circuited (search returns [], create is a no-op stub
 * that does NOT touch OpenAI or the DB). The remaining list/find/delete/
 * feedback paths still operate against the existing DB rows for back-compat.
 */

import type { Prisma, BlueprintMetadata } from './types';
import * as repo from './repo';

// ---------------------------------------------------------------------------
// Error classes (kept for back-compat with route handlers)
// ---------------------------------------------------------------------------

export class EmbeddingError extends Error {
  constructor(cause?: unknown) {
    super('Failed to generate embedding for blueprint');
    this.name = 'EmbeddingError';
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Search (disabled)
// ---------------------------------------------------------------------------

/**
 * Disabled: blueprint similarity search relied on OpenAI embeddings, which
 * are temporarily turned off. Always returns no matches.
 */
export async function searchByGoal(
  _userId: string,
  _goal: string,
  _limit?: number
): Promise<never[]> {
  return [];
}

// ---------------------------------------------------------------------------
// Create (disabled)
// ---------------------------------------------------------------------------

/**
 * Disabled: blueprint creation required generating an OpenAI embedding for the
 * title. Returns a stub object so existing internal callers (agents) continue
 * to receive a successful response without any DB write or external call.
 */
export async function createBlueprint(
  userId: string,
  title: string,
  blueprint: Prisma.InputJsonValue
): Promise<{
  id: null;
  userId: string;
  title: string;
  blueprint: Prisma.InputJsonValue;
  disabled: true;
}> {
  return {
    id: null,
    userId,
    title,
    blueprint,
    disabled: true,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List all blueprints for a user.
 */
export async function listBlueprints(userId: string) {
  return repo.listByUser(userId);
}

// ---------------------------------------------------------------------------
// Find by goal
// ---------------------------------------------------------------------------

/**
 * Find the most recent blueprint matching a goal title.
 */
export async function findByGoal(userId: string, goal: string) {
  return repo.findByGoal(userId, goal);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a blueprint (with ownership verification).
 * Returns true if deleted, null if not found.
 */
export async function deleteBlueprint(id: string, userId: string) {
  const blueprint = await repo.findByIdAndUser(id, userId);
  if (blueprint === null) {
    return null;
  }

  await repo.deleteById(id);
  return true;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * Submit feedback for a blueprint (with ownership verification).
 * Returns the updated blueprint, or null if not found.
 */
export async function submitFeedback(
  id: string,
  userId: string,
  params: {
    rating: number;
    issueType?: string;
    comment?: string;
    helpImprove?: boolean;
    agentId?: string;
  }
) {
  const blueprint = await repo.findByIdAndUser(id, userId);
  if (blueprint === null) {
    return null;
  }

  const existingMetadata =
    (blueprint.metadata as BlueprintMetadata | null) ?? ({} as BlueprintMetadata);
  const updatedMetadata: BlueprintMetadata = {
    ...existingMetadata,
    feedback: {
      rating: params.rating,
      issueType: params.issueType ?? null,
      comment: params.comment ?? null,
      helpImprove: params.helpImprove ?? false,
      agentId: params.agentId,
      submittedAt: new Date().toISOString(),
    },
  };

  return repo.updateMetadata(id, updatedMetadata as unknown as Prisma.InputJsonValue);
}
