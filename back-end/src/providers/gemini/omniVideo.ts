/**
 * Gemini Omni video generation (Interactions API) — the only place Rose talks
 * to Google for video. The raw GEMINI_API_KEY never leaves this provider: agents
 * and sandboxes reach it only through the backend (domains/agent-tools/videoService.ts).
 *
 *   generateOmniVideo({prompt, images[], aspectRatio, resolution, seed?})
 *     │ POST {base}/v1beta/interactions   model, input (text, or image parts + text),
 *     │                                   response_format{type:video, aspect_ratio,
 *     │                                   resolution, delivery:uri}, generation_config{seed},
 *     │                                   store:true (Google requires it for uri delivery),
 *     │                                   stream:false
 *     ▼
 *   steps[type=model_output].content[type=video]
 *        uri  ".../files/{id}:download?alt=media"  → GET files/{id} until ACTIVE,
 *                                                     then GET files/{id}:download?alt=media
 *        data (inline base64, if a gateway inlines) → bytes
 *   usage.output_tokens_by_modality[video]  → cost (documented $/1M tokens)
 *   mp4DurationSeconds(bytes)               → real seconds (mvhd box)
 *
 * Live facts (probed 2026-10-28, gemini-omni-1.1-flash): a clip is 3–10 s
 * (no prompt yields more than 10 s); duration, audio and negatives are
 * prompt-level (the API rejects duration/fps/negative_prompt/audio fields);
 * temperature is documented as unsupported, seed is accepted. Errors come back
 * as {"error":{"message","code"}} and are passed through verbatim.
 *
 * 10k agents: one bounded request (≤ OMNI_MAX_WAIT_MS) per call and nothing held
 * between calls; the per-user in-flight cap lives in the service.
 */
import { createHash } from 'node:crypto';
import { archiveBytes } from '../traceArchive';
import { finishLlmCapture, type LlmCapture, llmCaptureRoot, startLlmCapture } from '../llmDump';
import { type ArchiveScope, simpleArchiveOutput } from '../llmArchiveRecord';
import { createLogger } from '../logger';

const log = createLogger('GeminiOmniVideo');

/** The single place the model id is configured (override with GEMINI_OMNI_VIDEO_MODEL). */
export const OMNI_VIDEO_MODEL_DEFAULT = 'gemini-omni-1.1-flash';
export function omniVideoModel(): string {
  return process.env.GEMINI_OMNI_VIDEO_MODEL?.trim() || OMNI_VIDEO_MODEL_DEFAULT;
}

export const OMNI_ASPECT_RATIOS = ['16:9', '9:16'] as const;
export const OMNI_RESOLUTIONS = ['360p', '720p', '1080p', '4k'] as const;
export type OmniAspectRatio = (typeof OMNI_ASPECT_RATIOS)[number];
export type OmniResolution = (typeof OMNI_RESOLUTIONS)[number];

/**
 * Documented paid-tier prices for gemini-omni-1.1-flash (ai.google.dev pricing,
 * 2026-10-28), USD per 1M tokens: input $1.50; output $17.50 video, $9.00 text
 * and thinking. Google bills 720p at 5,792 video tokens per second (~$0.10/s).
 */
export const OMNI_USD_PER_M_TOKENS = { input: 1.5, videoOutput: 17.5, textOutput: 9 } as const;

/**
 * Video tokens per generated second by resolution. 720p is Google's published
 * rate; the others were measured from live usage (360p 1,931, 1080p 8,604,
 * 4k 17,238). Used for pre-call estimates and when a response lacks usage.
 */
export const OMNI_VIDEO_TOKENS_PER_SECOND: Record<OmniResolution, number> = {
  '360p': 1931,
  '720p': 5792,
  '1080p': 8604,
  '4k': 17238,
};

export interface OmniUsage {
  inputTokens: number;
  videoOutputTokens: number;
  /** Text output plus thinking tokens (both billed at the text output rate). */
  textOutputTokens: number;
}

export interface OmniCost {
  usd: number;
  cents: number;
  /** Effective USD per generated second for this clip. */
  rate_usd_per_second: number;
  /** usage_tokens: billed from the response's token usage; estimated: tokens/s table. */
  rate_basis: 'usage_tokens' | 'estimated';
  video_tokens: number;
}

export function omniEstimatedUsdPerSecond(resolution: OmniResolution): number {
  return (OMNI_VIDEO_TOKENS_PER_SECOND[resolution] * OMNI_USD_PER_M_TOKENS.videoOutput) / 1e6;
}

export function omniCost(
  resolution: OmniResolution,
  seconds: number,
  usage: OmniUsage | null
): OmniCost {
  const videoTokens =
    usage?.videoOutputTokens ?? Math.ceil(OMNI_VIDEO_TOKENS_PER_SECOND[resolution] * seconds);
  const usd =
    (videoTokens * OMNI_USD_PER_M_TOKENS.videoOutput +
      (usage?.textOutputTokens ?? 0) * OMNI_USD_PER_M_TOKENS.textOutput +
      (usage?.inputTokens ?? 0) * OMNI_USD_PER_M_TOKENS.input) /
    1e6;
  return {
    usd,
    // ToolUsage stores integer cents; round up so spend is never under-reported.
    cents: Math.ceil(usd * 100 - 1e-9),
    rate_usd_per_second: seconds > 0 ? usd / seconds : 0,
    rate_basis: usage ? 'usage_tokens' : 'estimated',
    video_tokens: videoTokens,
  };
}

export const OMNI_POLL_INTERVAL_MS = 5_000;
export const OMNI_MAX_WAIT_MS = 8 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

export class OmniVideoError extends Error {
  constructor(
    message: string,
    /** True when the provider may already have generated (and billed) a video. */
    readonly mayHaveBilled: boolean,
    readonly httpStatus?: number
  ) {
    super(message);
  }
}

export interface OmniImageInput {
  bytes: Buffer;
  mimeType: string;
}

/** Images are sent in this order; the prompt's tags refer to them as Image1..N. */
export interface OmniVideoRequest {
  prompt: string;
  images: OmniImageInput[];
  aspectRatio: OmniAspectRatio;
  resolution: OmniResolution;
  seed?: number;
  /**
   * Agent tree binding: request + generated video are archived in the root
   * bundle; the root resolves off the call path (llmDump archive_scope).
   */
  archive?: { archive_scope: ArchiveScope } | null;
}

export interface OmniVideoResult {
  bytes: Buffer;
  mimeType: string;
  model: string;
  interactionId: string | null;
  durationSeconds: number;
  latencyMs: number;
  /** Null when the response carried no usage block. */
  usage: OmniUsage | null;
}

function apiBase(): string {
  return (
    process.env.GEMINI_API_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com'
  ).replace(/\/+$/, '');
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new OmniVideoError('GEMINI_API_KEY is not configured on the backend', false);
  return key;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function providerFetch(url: string, init: RequestInit, key: string): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-goog-api-key': key },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Google's own words. Interactions errors are {"error":{"message","code"}};
 * Files API errors are {"error":{"code":<number>,"message","status"}}.
 */
export async function providerErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  let message = '';
  let label = '';
  try {
    const error = (JSON.parse(text) as { error?: Record<string, unknown> }).error ?? {};
    message = typeof error.message === 'string' ? error.message.trim() : '';
    label =
      [error.status, error.code].find(
        (value): value is string => typeof value === 'string' && value.length > 0
      ) ?? '';
  } catch {
    // not JSON: fall through to the raw body
  }
  const http = `HTTP ${response.status}`;
  if (message) return `${message} (${label ? `${label}, ` : ''}${http})`;
  return text.trim() ? `${text.trim().slice(0, 500)} (${http})` : http;
}

function readUsage(body: unknown): OmniUsage | null {
  const usage = (body as { usage?: Record<string, unknown> })?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const byModality = Array.isArray(usage.output_tokens_by_modality)
    ? (usage.output_tokens_by_modality as { modality?: string; tokens?: unknown }[])
    : [];
  const video = byModality
    .filter((entry) => entry?.modality === 'video')
    .reduce((sum, entry) => sum + num(entry.tokens), 0);
  if (video === 0) return null;
  return {
    inputTokens: num(usage.total_input_tokens),
    videoOutputTokens: video,
    textOutputTokens:
      Math.max(0, num(usage.total_output_tokens) - video) + num(usage.total_thought_tokens),
  };
}

interface VideoPart {
  mime_type?: string;
  data?: string;
  uri?: string;
}

function findVideoPart(body: unknown): VideoPart | null {
  const steps = (body as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    const content = (step as { type?: string; content?: unknown })?.content;
    if ((step as { type?: string })?.type !== 'model_output' || !Array.isArray(content)) continue;
    for (const part of content) {
      if ((part as { type?: string })?.type === 'video') return part as VideoPart;
    }
  }
  // The SDK's convenience field, if a gateway returns it.
  const direct = (body as { output_video?: VideoPart })?.output_video;
  return direct ?? null;
}

/** Duration in seconds from the movie header (mvhd) of an MP4; null if unreadable. */
export function mp4DurationSeconds(bytes: Buffer): number | null {
  const find = (start: number, end: number, wanted: string[]): number | null => {
    let at = start;
    while (at + 8 <= end) {
      let size = bytes.readUInt32BE(at);
      const type = bytes.toString('latin1', at + 4, at + 8);
      let header = 8;
      if (size === 1 && at + 16 <= end) {
        size = Number(bytes.readBigUInt64BE(at + 8));
        header = 16;
      } else if (size === 0) size = end - at;
      if (size < header || at + size > end) return null;
      if (type === wanted[0]) {
        if (wanted.length === 1) return at + header;
        const inner = find(at + header, at + size, wanted.slice(1));
        if (inner !== null) return inner;
      }
      at += size;
    }
    return null;
  };
  const body = find(0, bytes.length, ['moov', 'mvhd']);
  if (body === null || body + 20 > bytes.length) return null;
  const version = bytes.readUInt8(body);
  const timescale = bytes.readUInt32BE(body + (version === 1 ? 20 : 12));
  const duration =
    version === 1 ? Number(bytes.readBigUInt64BE(body + 24)) : bytes.readUInt32BE(body + 16);
  return timescale > 0 ? duration / timescale : null;
}

async function pollAndDownload(uri: string, key: string, deadline: number): Promise<Buffer> {
  // ".../v1beta/files/{id}:download?alt=media" (live shape) or ".../files/{id}".
  const fileMatch = /\/files\/([^/:?]+)/.exec(uri);
  if (!fileMatch) throw new OmniVideoError(`unrecognised video uri ${uri.slice(0, 200)}`, true);
  const base = `${apiBase()}/v1beta/files/${fileMatch[1]}`;
  for (;;) {
    const status = await providerFetch(base, { method: 'GET' }, key);
    if (!status.ok) {
      throw new OmniVideoError(
        `video file status failed: ${await providerErrorMessage(status)}`,
        true,
        status.status
      );
    }
    const state = ((await status.json()) as { state?: string }).state;
    if (state === 'ACTIVE') break;
    if (state === 'FAILED')
      throw new OmniVideoError('video generation failed (file state FAILED)', true);
    if (Date.now() + OMNI_POLL_INTERVAL_MS > deadline) {
      throw new OmniVideoError(
        `video was still ${state ?? 'processing'} after ${Math.round(OMNI_MAX_WAIT_MS / 1000)}s`,
        true
      );
    }
    await sleep(OMNI_POLL_INTERVAL_MS);
  }
  const download = await providerFetch(`${base}:download?alt=media`, { method: 'GET' }, key);
  if (!download.ok) {
    throw new OmniVideoError(
      `video download failed: ${await providerErrorMessage(download)}`,
      true,
      download.status
    );
  }
  return Buffer.from(await download.arrayBuffer());
}

/** Inline fallback bound: 32 MiB → ~43 MiB base64, under the 72 MiB record ciphertext cap. */
const INLINE_VIDEO_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Store the generated video under the capture's archive root (resolved after
 * the model call). Returns the stored object path, or the failure reason.
 */
async function archiveVideoBytes(
  capture: LlmCapture,
  objectPath: string,
  body: Buffer,
  mimeType: string | undefined
): Promise<{ path: string } | { error: string }> {
  try {
    const rootAgentId = await llmCaptureRoot(capture);
    if (rootAgentId === null) return { error: 'capture has no archive root' };
    // createOnly: a failed write throws; null means the content-addressed
    // object already exists (or archiving is off, when no record is written).
    await archiveBytes({
      rootAgentId,
      objectPath,
      body,
      contentType: mimeType || 'video/mp4',
      compress: false,
      createOnly: true,
    });
    return { path: objectPath };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The final record's video reference: the confirmed archive path, or — when the
 * separate write failed — the failure plus the bytes inline, so the final
 * record (stored with its own retries) still carries the video.
 */
async function videoArchiveFields(
  capture: LlmCapture,
  bytes: Buffer,
  mimeType: string | undefined
): Promise<Record<string, unknown>> {
  const videoPath = `media/video/${createHash('sha256').update(bytes).digest('hex')}.mp4`;
  const stored = await archiveVideoBytes(capture, videoPath, bytes, mimeType);
  if ('path' in stored) return { video_archive_path: stored.path };
  log.warn('[GenerateVideo] video archive failed', { error: stored.error, bytes: bytes.length });
  return {
    video_archive_error: stored.error,
    ...(bytes.length <= INLINE_VIDEO_FALLBACK_MAX_BYTES
      ? { video_data_base64: bytes.toString('base64'), video_mime_type: mimeType || 'video/mp4' }
      : {}),
  };
}

/** Final record for a failed generation (provider error, refusal, network, download). */
function finishFailedVideoCapture(
  capture: LlmCapture | null,
  model: string,
  startedAtMs: number,
  error: unknown
): void {
  if (capture === null) return;
  finishLlmCapture(capture, {
    model,
    output: simpleArchiveOutput({
      content: '',
      actualModel: model,
      provider: 'gemini',
      startedAtMs,
      error,
    }),
  });
}

export async function generateOmniVideo(request: OmniVideoRequest): Promise<OmniVideoResult> {
  const key = apiKey();
  const model = omniVideoModel();
  const started = Date.now();
  const input: unknown[] = [
    ...request.images.map((image) => ({
      type: 'image',
      data: image.bytes.toString('base64'),
      mime_type: image.mimeType,
    })),
    { type: 'text', text: request.prompt },
  ];
  const body = {
    model,
    input: request.images.length > 0 ? input : request.prompt,
    response_format: {
      type: 'video',
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
      delivery: 'uri',
    },
    ...(request.seed !== undefined ? { generation_config: { seed: request.seed } } : {}),
    // Google: "store=true is required when response format has video delivery set to URI."
    store: true,
    stream: false,
  };
  const capture =
    request.archive === undefined || request.archive === null
      ? null
      : startLlmCapture({
          call_site: 'generate_video',
          ...request.archive,
          model,
          message_count: 1,
          messages: [{ role: 'user', content: input }],
          config: { provider: 'gemini', request: { ...body, input: '[messages[0].content]' } },
        });
  log.info('[GenerateVideo] provider request', {
    model,
    prompt_chars: request.prompt.length,
    images: request.images.length,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    seed: request.seed ?? null,
  });
  let generated: GeneratedVideo;
  try {
    generated = await requestVideo(body, key, started);
  } catch (error) {
    finishFailedVideoCapture(capture, model, started, error);
    throw error;
  }
  const { interaction, part, bytes, durationSeconds } = generated;
  const latencyMs = Date.now() - started;
  const usage = readUsage(interaction);
  if (capture !== null) {
    finishLlmCapture(capture, {
      model,
      output: simpleArchiveOutput({
        content: '',
        actualModel: model,
        provider: 'gemini',
        startedAtMs: started,
        requestId: interaction.id ?? null,
        structured: {
          interaction,
          ...(await videoArchiveFields(capture, bytes, part.mime_type)),
          duration_seconds: durationSeconds,
        },
      }),
    });
  }
  log.info('[GenerateVideo] provider response', {
    model,
    interaction_id: interaction.id ?? null,
    bytes: bytes.length,
    duration_seconds: durationSeconds,
    video_tokens: usage?.videoOutputTokens ?? null,
    latency_ms: latencyMs,
  });
  return {
    bytes,
    mimeType: part.mime_type || 'video/mp4',
    model,
    interactionId: interaction.id ?? null,
    durationSeconds,
    latencyMs,
    usage,
  };
}

interface GeneratedVideo {
  interaction: { id?: string; status?: string };
  part: VideoPart;
  bytes: Buffer;
  durationSeconds: number;
}

/** One Interactions call plus its download; throws OmniVideoError on every failure. */
async function requestVideo(
  body: Record<string, unknown>,
  key: string,
  started: number
): Promise<GeneratedVideo> {
  let response: Response;
  try {
    response = await providerFetch(
      `${apiBase()}/v1beta/interactions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      key
    );
  } catch (err) {
    // The request may have reached Google before the connection failed.
    throw new OmniVideoError(`video request failed: ${(err as Error).message}`, true);
  }
  if (!response.ok) {
    // 4xx is a definitive refusal (nothing generated); 5xx is ambiguous.
    throw new OmniVideoError(
      `video generation rejected: ${await providerErrorMessage(response)}`,
      response.status >= 500,
      response.status
    );
  }
  const interaction = (await response.json()) as { id?: string; status?: string };
  if (interaction.status && interaction.status !== 'completed') {
    throw new OmniVideoError(`video generation ended with status ${interaction.status}`, true);
  }
  const part = findVideoPart(interaction);
  if (part === null) {
    throw new OmniVideoError(
      'provider returned no video (the prompt may have been blocked by safety filters)',
      false
    );
  }
  let bytes: Buffer;
  if (typeof part.data === 'string' && part.data.length > 0)
    bytes = Buffer.from(part.data, 'base64');
  else if (typeof part.uri === 'string') {
    bytes = await pollAndDownload(part.uri, key, started + OMNI_MAX_WAIT_MS);
  } else throw new OmniVideoError('provider video part has neither data nor uri', true);

  const durationSeconds = mp4DurationSeconds(bytes);
  if (bytes.length === 0 || durationSeconds === null) {
    throw new OmniVideoError('provider returned an unreadable video file', true);
  }
  return { interaction, part, bytes, durationSeconds };
}
