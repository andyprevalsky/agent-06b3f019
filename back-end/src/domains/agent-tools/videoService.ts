/**
 * `generate_video`: make real footage (with native audio) with Gemini Omni and
 * hand back a file the agent can `display` or pass on. One implementation for
 * every surface: the native tool (agents worker, X-API-Key) and code agents
 * (sandbox token) both call POST /api/agent-tools/:agentId/generate-video.
 *
 *   body ─► validate ─► resolve reference images (agent tree / owner storage)
 *     │
 *     ▼ claim ToolSideEffect  generate_video:<agent>:<sha256(idempotency_key)>
 *       DONE      ─► replay stored result            (no provider call, no bill)
 *       STARTED   ─► 409 in progress (stale > 12 min is re-claimed)
 *       UNCERTAIN ─► 409: a prior attempt may have billed; use a new key
 *       FAILED / none ─► claim (create or conditional update; one winner)
 *     ▼ generateOmniVideo (providers/gemini/omniVideo.ts: call, poll, download)
 *     ▼ store  <owner>/generated-video/<sha256>.mp4   (write-once, content-addressed)
 *     ▼ ToolUsage  tool_name generate_video, cost = $/s × real mp4 duration,
 *                  operationKey <claim>:usage (retry-safe)
 *     ▼ claim DONE + result  ─► { file_pointer, display_path, cost, duration, ... }
 *
 * The raw GEMINI_API_KEY stays in the provider. Errors are the provider's own
 * words (safety block, quota, timeout), not paraphrased by a classifier.
 *
 * 10k agents: per-agent claim row keyed by the call, no shared counter; spend is
 * bounded per call (≤ 10 s, ≤ 3 reference images) and per user by an in-process
 * in-flight cap (MAX_IN_FLIGHT_PER_USER); idle cost is zero.
 */
import { Prisma } from '@prisma/client';
import { createHash } from '../../providers/crypto';
import { prisma } from '../../providers/database';
import {
  OmniVideoError,
  generateOmniVideo,
  omniCost,
  type OmniImageInput,
} from '../../providers/gemini/omniVideo';
import { createLogger } from '../../providers/logger';
import { sniffDisplayMediaType, putDisplayObject } from '../../providers/agentTools/media';
import { WorkflowGenerationMismatchError, saveToolUsage } from '../tool-usage/service';
import { findAgent } from './repo';
import { resolveAll } from './displayResolution';
import { AgentToolsError, type ToolContext } from './service';
import type { GenerateVideoBody, GenerateVideoResult } from './videoTypes';

const log = createLogger('GenerateVideo');

export const GENERATE_VIDEO_TOOL = 'generate_video';
const OPERATION_TYPE = 'GENERATE_VIDEO';
/** A claim older than this with no result is treated as a dead attempt. */
export const GENERATE_VIDEO_STALE_CLAIM_MS = 12 * 60_000;
const MAX_IN_FLIGHT_PER_USER = 3;
const REFERENCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const inFlight = new Map<string, number>();

interface Claim {
  claimedAt: string;
}

export function videoOperationKey(agentId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  return `${GENERATE_VIDEO_TOOL}:${agentId}:${digest}`;
}

/** The prompt Omni sees: duration and audio are prompt-level controls. */
export function buildVideoPrompt(body: GenerateVideoBody): string {
  const parts = [body.prompt.trim()];
  if (body.duration_seconds !== undefined) {
    parts.push(`Duration: about ${body.duration_seconds} seconds.`);
  }
  if (!body.audio) parts.push('No audio: a silent video with no music, speech or sound effects.');
  return parts.join('\n\n');
}

async function loadReferences(ctx: ToolContext, files: string[]): Promise<OmniImageInput[]> {
  if (files.length === 0) return [];
  const resolved = await resolveAll(
    ctx.agent,
    files.map((file) => ({ file }))
  );
  const problems: string[] = [];
  const images: OmniImageInput[] = [];
  for (const entry of resolved) {
    if (entry.type !== 'single') {
      problems.push(`${files[entry.index].slice(0, 200)}: expected a single image file`);
      continue;
    }
    const mime = sniffDisplayMediaType(entry.bytes);
    if (mime === null || !REFERENCE_TYPES.has(mime)) {
      problems.push(
        `${files[entry.index].slice(0, 200)}: reference files must be PNG, JPEG or WebP images`
      );
      continue;
    }
    images.push({ bytes: entry.bytes, mimeType: mime });
  }
  if (problems.length > 0) throw new AgentToolsError(400, 'Invalid reference_files', problems);
  return images;
}

type Row = NonNullable<Awaited<ReturnType<typeof prisma.toolSideEffect.findUnique>>>;

/** Returns a stored result to replay, or null once this call owns the claim. */
async function claimOrReplay(key: string, agentId: string): Promise<GenerateVideoResult | null> {
  const claim: Claim = { claimedAt: new Date().toISOString() };
  const create = () =>
    prisma.toolSideEffect.create({
      data: {
        operationKey: key,
        operationType: OPERATION_TYPE,
        status: 'STARTED',
        externalId: agentId,
        request: claim as unknown as Prisma.InputJsonObject,
      },
    });
  let row: Row | null = await prisma.toolSideEffect.findUnique({ where: { operationKey: key } });
  if (row === null) {
    try {
      await create();
      return null;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      row = await prisma.toolSideEffect.findUnique({ where: { operationKey: key } });
      if (row === null) throw err;
    }
  }
  if (row.status === 'DONE') {
    return { ...(row.response as unknown as GenerateVideoResult), replayed: true };
  }
  if (row.status === 'UNCERTAIN') {
    throw new AgentToolsError(
      409,
      `An earlier attempt with this idempotency_key may already have been billed (${row.error ?? 'unknown outcome'}). Use a new idempotency_key to generate again.`
    );
  }
  if (row.status === 'STARTED') {
    const claimedAt = Date.parse((row.request as Claim | null)?.claimedAt ?? '');
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < GENERATE_VIDEO_STALE_CLAIM_MS) {
      throw new AgentToolsError(409, 'This video is still being generated; retry shortly.');
    }
  }
  // FAILED (definitive, nothing billed) or a dead STARTED claim: exactly one caller wins.
  const won = await prisma.toolSideEffect.updateMany({
    where: {
      operationKey: key,
      status: row.status,
      // Compare-and-set on the previous claim so two racing retries cannot both win.
      request: { path: ['claimedAt'], equals: (row.request as Claim | null)?.claimedAt ?? '' },
    },
    data: { status: 'STARTED', error: null, request: claim as unknown as Prisma.InputJsonObject },
  });
  if (won.count !== 1)
    throw new AgentToolsError(409, 'This video is still being generated; retry shortly.');
  return null;
}

async function settle(
  key: string,
  status: 'DONE' | 'FAILED' | 'UNCERTAIN',
  fields: { error?: string; response?: GenerateVideoResult }
): Promise<void> {
  await prisma.toolSideEffect.update({
    where: { operationKey: key },
    data: {
      status,
      error: fields.error ?? null,
      ...(fields.response
        ? { response: fields.response as unknown as Prisma.InputJsonObject }
        : {}),
    },
  });
}

async function produce(
  ctx: ToolContext,
  body: GenerateVideoBody,
  key: string,
  images: OmniImageInput[],
  onBilled: () => void
): Promise<GenerateVideoResult> {
  const { agent } = ctx;
  const video = await generateOmniVideo({
    prompt: buildVideoPrompt(body),
    images,
    aspectRatio: body.aspect_ratio,
    resolution: body.resolution,
  });
  onBilled();
  const sha256 = createHash('sha256').update(video.bytes).digest('hex');
  const storagePath = `${agent.userId}/generated-video/${sha256}.mp4`;
  await putDisplayObject(storagePath, video.bytes, 'video/mp4');
  const cost = omniCost(body.resolution, video.durationSeconds);
  const usage = {
    agent_id: agent.id,
    user_id: agent.userId,
    tool_name: GENERATE_VIDEO_TOOL,
    total_cost_cents: cost.cents,
    operation_key: `${key}:usage`,
    usage_items: [
      {
        type: 'service',
        cost_cents: cost.cents,
        provider: `Gemini Omni video (${video.model}, ${body.resolution}, ${video.durationSeconds.toFixed(2)}s)`,
      },
    ],
  };
  try {
    await saveToolUsage({ ...usage, workflow_generation: ctx.workflowGeneration });
  } catch (err) {
    if (!(err instanceof WorkflowGenerationMismatchError)) throw err;
    // The workflow rolled over during generation: the money is spent, so record it
    // against the agent's current generation rather than losing it.
    const fresh = await findAgent(agent.id);
    await saveToolUsage({
      ...usage,
      workflow_generation: fresh?.temporalWorkflowId ?? agent.id,
    });
  }
  return {
    status: 'completed',
    replayed: false,
    file_pointer: {
      storage_path: storagePath,
      original_filename: `generated-video-${sha256.slice(0, 12)}.mp4`,
      mime_type: 'video/mp4',
      size_bytes: video.bytes.length,
      kind: 'video',
      sha256,
    },
    display_path: storagePath,
    model: video.model,
    duration_seconds: video.durationSeconds,
    aspect_ratio: body.aspect_ratio,
    resolution: body.resolution,
    latency_ms: video.latencyMs,
    cost,
    interaction_id: video.interactionId,
  };
}

export async function generateVideo(
  ctx: ToolContext,
  body: GenerateVideoBody
): Promise<GenerateVideoResult> {
  const { agent } = ctx;
  const key = videoOperationKey(agent.id, body.idempotency_key);
  const images = await loadReferences(ctx, body.reference_files ?? []);
  log.info('[GenerateVideo] request', {
    agent_id: agent.id,
    operation_key: key,
    caller: ctx.caller.kind,
    aspect_ratio: body.aspect_ratio,
    resolution: body.resolution,
    duration_seconds: body.duration_seconds ?? null,
    audio: body.audio,
    reference_images: images.length,
  });
  const replay = await claimOrReplay(key, agent.id);
  if (replay !== null) {
    log.info('[GenerateVideo] replayed stored result', { agent_id: agent.id, operation_key: key });
    return replay;
  }
  if ((inFlight.get(agent.userId) ?? 0) >= MAX_IN_FLIGHT_PER_USER) {
    await settle(key, 'FAILED', { error: 'too many concurrent video generations' });
    throw new AgentToolsError(
      429,
      `At most ${MAX_IN_FLIGHT_PER_USER} videos can be generated at once; wait for one to finish.`
    );
  }
  inFlight.set(agent.userId, (inFlight.get(agent.userId) ?? 0) + 1);
  const started = Date.now();
  let billed = false;
  try {
    const result = await produce(ctx, body, key, images, () => {
      billed = true;
    });
    await settle(key, 'DONE', { response: result });
    log.info('[GenerateVideo] completed', {
      agent_id: agent.id,
      operation_key: key,
      duration_seconds: result.duration_seconds,
      cost_cents: result.cost.cents,
      latency_ms: Date.now() - started,
      bytes: result.file_pointer.size_bytes,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ambiguous = billed || (err instanceof OmniVideoError && err.mayHaveBilled);
    log.error('[GenerateVideo] failed', {
      agent_id: agent.id,
      operation_key: key,
      error: message,
      may_have_billed: ambiguous,
      latency_ms: Date.now() - started,
    });
    await settle(key, ambiguous ? 'UNCERTAIN' : 'FAILED', { error: message }).catch(
      () => undefined
    );
    if (err instanceof OmniVideoError) {
      const definitive =
        err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500;
      throw new AgentToolsError(definitive ? 422 : 502, message);
    }
    throw err;
  } finally {
    inFlight.set(agent.userId, Math.max(0, (inFlight.get(agent.userId) ?? 1) - 1));
  }
}
