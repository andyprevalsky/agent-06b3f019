import { z } from 'zod';

// Literal caps (mirrored in videoService.ts): types is the lowest layer.
const MAX_REFERENCE_FILES = 3;
const MAX_DURATION_SECONDS = 10;

/**
 * POST /api/agent-tools/:agentId/generate-video
 *
 * `idempotency_key` is required: the same key for the same agent returns the
 * first call's file and never calls (or bills) the provider again. Callers use a
 * stable per-tool-call value (e.g. the Temporal workflow id + tool_call_id).
 * Duration and audio are prompt-level in Gemini Omni, so they steer, not
 * guarantee: the response reports the real duration and the cost billed on it.
 */
export const generateVideoRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    duration_seconds: z.number().min(1).max(MAX_DURATION_SECONDS).optional(),
    aspect_ratio: z.enum(['16:9', '9:16']).default('16:9'),
    resolution: z.enum(['360p', '720p', '1080p']).default('720p'),
    /** Files in the agent's tree (by name) or owner storage paths: images only. */
    reference_files: z.array(z.string().min(1).max(512)).max(MAX_REFERENCE_FILES).optional(),
    audio: z.boolean().default(true),
    idempotency_key: z.string().min(8).max(300),
  })
  .strict();

export type GenerateVideoBody = z.infer<typeof generateVideoRequestSchema>;

export interface GenerateVideoResult {
  status: 'completed';
  /** True when this is an earlier call's stored result (no provider call made). */
  replayed: boolean;
  file_pointer: {
    storage_path: string;
    original_filename: string;
    mime_type: string;
    size_bytes: number;
    kind: 'video';
    sha256: string;
  };
  /** Pass to `display` as a file path. */
  display_path: string;
  model: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
  latency_ms: number;
  cost: { usd: number; cents: number; rate_usd_per_second: number; rate_basis: string };
  interaction_id: string | null;
}
