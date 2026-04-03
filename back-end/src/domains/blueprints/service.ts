/**
 * Blueprints domain service -- business logic for blueprint search, CRUD, and feedback.
 */

import OpenAI from 'openai';
import type { Prisma, BlueprintMetadata } from './types';
import { createLogger } from '../../providers/logger';
import { SIMILARITY_THRESHOLD, DEFAULT_SEARCH_LIMIT, EMBEDDING_MODEL } from './config';
import * as repo from './repo';

const log = createLogger('Blueprints');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class EmbeddingError extends Error {
  constructor(cause?: unknown) {
    super('Failed to generate embedding for blueprint');
    this.name = 'EmbeddingError';
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// OpenAI client (module-level singleton)
// ---------------------------------------------------------------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search blueprints by goal similarity using pre-computed embeddings.
 * Returns top-K results above the similarity threshold, or [] on embedding failure.
 */
export async function searchByGoal(
  userId: string,
  goal: string,
  limit: number = DEFAULT_SEARCH_LIMIT
) {
  const blueprints = await repo.findManyWithEmbeddings(userId);

  if (blueprints.length === 0) {
    return [];
  }

  // Generate embedding for the query goal
  let queryEmbedding: number[];
  try {
    queryEmbedding = await getEmbedding(goal);
  } catch (embeddingError) {
    log.error('Embeddings failed', {
      error: embeddingError instanceof Error ? embeddingError.message : String(embeddingError),
    });
    return [];
  }

  // Filter blueprints that have embeddings
  const blueprintsWithEmbeddings = blueprints.filter(
    (bp) => bp.embedding !== null && bp.embedding !== undefined
  );

  if (blueprintsWithEmbeddings.length === 0) {
    return [];
  }

  // Calculate cosine similarity (skip blueprints with mismatched embedding dimensions)
  const withSimilarity: Array<(typeof blueprintsWithEmbeddings)[number] & { similarity: number }> =
    [];
  for (const bp of blueprintsWithEmbeddings) {
    const embedding = bp.embedding as unknown;
    if (!Array.isArray(embedding) || embedding.length !== queryEmbedding.length) {
      log.warn('Skipping blueprint with incompatible embedding', { id: bp.id });
      continue;
    }
    const score = cosineSimilarity(queryEmbedding, embedding as number[]);
    withSimilarity.push({ ...bp, similarity: score });
  }

  // Filter by threshold, sort, and strip internal fields
  return withSimilarity
    .filter((bp) => bp.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map(({ similarity: _similarity, embedding: _embedding, ...bp }) => bp);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Save a new blueprint with an auto-generated embedding.
 * Throws EmbeddingError if embedding generation fails.
 */
export async function createBlueprint(
  userId: string,
  title: string,
  blueprint: Prisma.InputJsonValue
) {
  let embedding: number[];
  try {
    embedding = await getEmbedding(title);
  } catch (embeddingError) {
    log.error('Failed to generate embedding for blueprint', {
      error: embeddingError instanceof Error ? embeddingError.message : String(embeddingError),
    });
    throw new EmbeddingError(embeddingError);
  }

  return repo.create({ userId, title, blueprint, embedding });
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
