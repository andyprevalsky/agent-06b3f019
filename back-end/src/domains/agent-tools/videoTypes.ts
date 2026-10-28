import { z } from 'zod';

// Literal caps (mirrored in videoService.ts and the sandbox `rose video` CLI):
// types is the lowest layer.
/** Gemini Omni clips are 3–10 s; no prompt yields more than 10 s (live probe 2026-10-28). */
export const VIDEO_MIN_DURATION_SECONDS = 3;
export const VIDEO_MAX_DURATION_SECONDS = 10;
const MAX_REFERENCE_IMAGES = 3;
const MAX_IMAGES = MAX_REFERENCE_IMAGES + 2;
/** ~10 MB of image bytes per inline image. */
const MAX_IMAGE_BASE64_CHARS = 14_000_000;
const MAX_SEED = 2_147_483_647;

/**
 * An image steering the clip: the exact first or last frame, or a reference
 * (subject, character, product or style). `file` is a file in the agent's tree
 * (by name) or an owner storage path; `content_base64` is raw bytes (the
 * sandbox CLI). PNG, JPEG or WebP.
 */
export const videoImageSchema = z
  .object({
    role: z.enum(['first_frame', 'last_frame', 'reference']),
    file: z.string().min(1).max(1024).optional(),
    content_base64: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS).optional(),
  })
  .strict()
  .refine((image) => (image.file === undefined) !== (image.content_base64 === undefined), {
    message: 'each image needs exactly one of file or content_base64',
  });

/**
 * POST /api/agent-tools/:agentId/generate-video
 *
 * `idempotency_key` is required: the same key for the same agent returns the
 * first call's file and never calls (or bills) the provider again.
 * duration_seconds, audio, audio_direction and avoid are prompt-level in
 * Gemini Omni, so they steer rather than guarantee: the response reports the
 * real duration and the cost billed on it.
 */
export const generateVideoRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    duration_seconds: z
      .number()
      .int()
      .min(VIDEO_MIN_DURATION_SECONDS)
      .max(VIDEO_MAX_DURATION_SECONDS)
      .optional(),
    aspect_ratio: z.enum(['16:9', '9:16']).default('16:9'),
    resolution: z.enum(['360p', '720p', '1080p', '4k']).default('720p'),
    seed: z.number().int().min(0).max(MAX_SEED).optional(),
    audio: z.boolean().default(true),
    /** Music, sound effects, dialogue or ambience wanted (prompt-level). */
    audio_direction: z.string().trim().min(1).max(1000).optional(),
    /** What must not appear (prompt-level; Omni has no negative-prompt field). */
    avoid: z.string().trim().min(1).max(1000).optional(),
    images: z.array(videoImageSchema).max(MAX_IMAGES).optional(),
    idempotency_key: z.string().min(8).max(300),
  })
  .strict()
  .superRefine((body, ctx) => {
    const images = body.images ?? [];
    const count = (role: string) => images.filter((image) => image.role === role).length;
    if (count('first_frame') > 1 || count('last_frame') > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['images'],
        message: 'at most one first_frame and one last_frame',
      });
    }
    if (count('last_frame') > 0 && count('first_frame') === 0) {
      ctx.addIssue({ code: 'custom', path: ['images'], message: 'last_frame needs a first_frame' });
    }
    if (count('reference') > MAX_REFERENCE_IMAGES) {
      ctx.addIssue({
        code: 'custom',
        path: ['images'],
        message: `at most ${MAX_REFERENCE_IMAGES} reference images`,
      });
    }
    if (!body.audio && body.audio_direction !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['audio_direction'],
        message: 'audio_direction needs audio: true',
      });
    }
  });

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
  /** GET this (relative to /api/agent-tools/:agentId) for the MP4 bytes. */
  download_path: string;
  model: string;
  duration_seconds: number;
  aspect_ratio: string;
  resolution: string;
  seed: number | null;
  latency_ms: number;
  cost: {
    usd: number;
    cents: number;
    rate_usd_per_second: number;
    rate_basis: string;
    video_tokens: number;
  };
  interaction_id: string | null;
}
