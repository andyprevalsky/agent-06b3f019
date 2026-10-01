import type { Prisma } from '@prisma/client';
import { z } from 'zod';

export type PlannerMemoryJson = Prisma.InputJsonValue;

export const plannerMemorySearchSchema = z.object({
  goal: z.string().min(1).max(20_000),
  user_id: z.string().optional(),
  exclude_root_agent_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  passed_only: z.boolean().optional(),
  min_similarity: z.number().min(-1).max(1).optional(),
});
export type PlannerMemorySearchBody = z.infer<typeof plannerMemorySearchSchema>;

/** Direct row upsert — internal tooling only (benchmark fixtures, backfill). */
export const plannerMemoryUpsertSchema = z.object({
  goal: z.string().min(1).max(20_000),
  user_id: z.string().nullable().optional(),
  benchmark_task_name: z.string().nullable().optional(),
  root_status: z.string().nullable().optional(),
  passed: z.boolean().nullable().optional(),
  world_model_mode: z.string().optional(),
  agent_created_at: z.string().nullable().optional(),
  critical_path: z.record(z.unknown()).nullable().optional(),
  compressor_version: z.string().optional(),
});
export type PlannerMemoryUpsertBody = z.infer<typeof plannerMemoryUpsertSchema>;

export const plannerMemoryCriticalPathSchema = z.object({
  critical_path: z.record(z.unknown()),
  compressor_version: z.string().min(1).max(64),
  lease_id: z.string().uuid(),
});
export type PlannerMemoryCriticalPathBody = z.infer<typeof plannerMemoryCriticalPathSchema>;

export const plannerMemoryCompressionClaimSchema = z.object({
  compressor_version: z.string().min(1).max(64),
});
export type PlannerMemoryCompressionClaimBody = z.infer<typeof plannerMemoryCompressionClaimSchema>;

export const plannerMemoryCompressionReleaseSchema = z.object({
  lease_id: z.string().uuid(),
});
export type PlannerMemoryCompressionReleaseBody = z.infer<
  typeof plannerMemoryCompressionReleaseSchema
>;

export const plannerMemoryEmbedPendingSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});
export type PlannerMemoryEmbedPendingBody = z.infer<typeof plannerMemoryEmbedPendingSchema>;
