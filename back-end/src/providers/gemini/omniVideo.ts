/**
 * Gemini Omni video generation (Interactions API) — the only place Rose talks
 * to Google for video. The raw GEMINI_API_KEY never leaves this provider: agents
 * and sandboxes reach it only through the backend (domains/agent-tools/videoService.ts).
 *
 *   generateOmniVideo({prompt, images, aspectRatio, resolution})
 *     │ POST {base}/v1beta/interactions   model, input[], response_format{type:video,
 *     │                                   aspect_ratio, resolution, delivery:uri},
 *     │                                   store:false, background:false, stream:false
 *     ▼
 *   steps[].content[type=video]  →  inline `data` (base64)  → bytes
 *                                   or `uri` (Files API)    → poll GET files/{id}
 *                                                              until ACTIVE, then
 *                                                              GET files/{id}:download
 *   mp4DurationSeconds(bytes) → billed seconds (price × duration; read from the mvhd box)
 *
 * Duration and audio are prompt-level in Omni (there is no duration/audio field);
 * callers append them to the prompt text. Failures throw OmniVideoError with the
 * provider's own message so the model sees what really happened.
 *
 * 10k agents: one bounded request (≤ OMNI_MAX_WAIT_MS) per call and nothing held
 * between calls; the per-user in-flight cap lives in the service.
 */
import { createLogger } from '../logger';

const log = createLogger('GeminiOmniVideo');

/** The single place the model id is configured (override with GEMINI_OMNI_VIDEO_MODEL). */
export const OMNI_VIDEO_MODEL_DEFAULT = 'gemini-omni-1.1-flash';
export function omniVideoModel(): string {
  return process.env.GEMINI_OMNI_VIDEO_MODEL?.trim() || OMNI_VIDEO_MODEL_DEFAULT;
}

export const OMNI_ASPECT_RATIOS = ['16:9', '9:16'] as const;
export const OMNI_RESOLUTIONS = ['360p', '720p', '1080p'] as const;
export type OmniAspectRatio = (typeof OMNI_ASPECT_RATIOS)[number];
export type OmniResolution = (typeof OMNI_RESOLUTIONS)[number];

/**
 * USD per generated second. Only the 720p rate ($0.10/s) is published to us;
 * 360p and 1080p are billed at the same rate here so cost is never under-counted
 * for a cheaper tier and the 1080p figure is flagged `rate_basis: 'assumed'`.
 */
const USD_PER_SECOND: Record<OmniResolution, { usd: number; basis: 'published' | 'assumed' }> = {
  '360p': { usd: 0.1, basis: 'assumed' },
  '720p': { usd: 0.1, basis: 'published' },
  '1080p': { usd: 0.1, basis: 'assumed' },
};

export function omniCost(resolution: OmniResolution, seconds: number) {
  const rate = USD_PER_SECOND[resolution];
  const usd = rate.usd * seconds;
  return {
    usd,
    // ToolUsage stores integer cents; round up so spend is never under-reported.
    cents: Math.ceil(usd * 100 - 1e-9),
    rate_usd_per_second: rate.usd,
    rate_basis: rate.basis,
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

export interface OmniVideoRequest {
  prompt: string;
  images: OmniImageInput[];
  aspectRatio: OmniAspectRatio;
  resolution: OmniResolution;
}

export interface OmniVideoResult {
  bytes: Buffer;
  mimeType: string;
  model: string;
  interactionId: string | null;
  durationSeconds: number;
  latencyMs: number;
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

async function providerErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message)
      return `${parsed.error.status ?? response.status}: ${parsed.error.message}`;
  } catch {
    // not JSON: fall through to the raw body
  }
  return text.slice(0, 500) || `HTTP ${response.status}`;
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
    background: false,
    store: false,
    stream: false,
  };
  log.info('[GenerateVideo] provider request', {
    model,
    prompt_chars: request.prompt.length,
    reference_images: request.images.length,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
  });
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
  const latencyMs = Date.now() - started;
  log.info('[GenerateVideo] provider response', {
    model,
    bytes: bytes.length,
    duration_seconds: durationSeconds,
    latency_ms: latencyMs,
  });
  return {
    bytes,
    mimeType: part.mime_type || 'video/mp4',
    model,
    interactionId: interaction.id ?? null,
    durationSeconds,
    latencyMs,
  };
}
