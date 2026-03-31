/**
 * Blueprints domain repo — all Prisma calls for blueprint CRUD and search.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { SEARCH_SCAN_LIMIT, LIST_LIMIT } from './config';

/**
 * Find many blueprints for a user with embeddings (for similarity search).
 */
export async function findManyWithEmbeddings(userId: string) {
  return prisma.goalBlueprint.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: SEARCH_SCAN_LIMIT,
    select: {
      id: true,
      userId: true,
      title: true,
      embedding: true,
      blueprint: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Create a new blueprint with an embedding.
 */
export async function create(params: {
  userId: string;
  title: string;
  blueprint: Prisma.InputJsonValue;
  embedding: number[];
}) {
  return prisma.goalBlueprint.create({
    data: {
      userId: params.userId,
      title: params.title,
      embedding: params.embedding,
      blueprint: params.blueprint,
    },
  });
}

/**
 * List blueprints for a user (most recent first).
 */
export async function listByUser(userId: string) {
  return prisma.goalBlueprint.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: LIST_LIMIT,
  });
}

/**
 * Find the most recent blueprint matching a title/goal for a user.
 */
export async function findByGoal(userId: string, goal: string) {
  return prisma.goalBlueprint.findFirst({
    where: { userId, title: goal },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Find a blueprint by ID and user (ownership check).
 */
export async function findByIdAndUser(id: string, userId: string) {
  return prisma.goalBlueprint.findFirst({
    where: { id, userId },
  });
}

/**
 * Delete a blueprint by ID.
 */
export async function deleteById(id: string) {
  return prisma.goalBlueprint.delete({
    where: { id },
  });
}

/**
 * Update a blueprint's metadata.
 */
export async function updateMetadata(id: string, metadata: Prisma.InputJsonValue) {
  return prisma.goalBlueprint.update({
    where: { id },
    data: { metadata },
  });
}
