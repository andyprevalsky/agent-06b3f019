#!/usr/bin/env tsx
/**
 * Opt-in LIVE smoke for generate_video: real Gemini Omni, real key, real MP4.
 * Skipped unless VIDEO_LIVE_SMOKE=1 (it spends money: 2 clips, about $0.75 in total:
 * 6 s at 720p with a seed, 4 s at 360p from a first frame).
 *   VIDEO_LIVE_SMOKE=1 VIDEO_LIVE_OUT=/tmp/video-live bash scripts/run-blackbox-tests.sh agent-tools-video-live
 * Reads a reference image from VIDEO_LIVE_OUT/ref.png and writes each clip and result.json under VIDEO_LIVE_OUT for ffprobe / frame checks.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { getDisplayObject, putDisplayObject } from '../../providers/agentTools/media';
import { resolveContext } from '../../domains/agent-tools/service';
import { generateVideo } from '../../domains/agent-tools/videoService';
import { generateVideoRequestSchema } from '../../domains/agent-tools/videoTypes';
config();

const live = process.env.VIDEO_LIVE_SMOKE === '1';
const out = process.env.VIDEO_LIVE_OUT || '/tmp/video-live';
const userId = `video-live-${randomUUID().slice(0, 8)}`;
const agentId = randomUUID();
const results: unknown[] = [];

before(async () => {
  if (!live) return;
  process.env.DISPLAY_STORAGE_BACKEND = 'local';
  process.env.DISPLAY_STORAGE_LOCAL_DIR = join(out, 'storage');
  mkdirSync(out, { recursive: true });
  await prisma.user.create({ data: { userId, name: 'Video Live' } });
  await prisma.agent.create({
    data: { id: agentId, userId, goal: 'video live smoke', status: 'ACTIVE' },
  });
});

after(async () => {
  if (live) {
    await prisma.toolUsage.deleteMany({ where: { agentId } });
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: { startsWith: `generate_video:${agentId}:` } },
    });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId } });
    writeFileSync(join(out, 'result.json'), JSON.stringify(results, null, 2));
  }
  await prisma.$disconnect();
});

async function run(name: string, extra: Record<string, unknown>) {
  const body = generateVideoRequestSchema.parse({
    idempotency_key: `live-${name}-${agentId}`,
    ...extra,
  });
  const result = await generateVideo(
    await resolveContext({ kind: 'agent', userId, agentId }),
    body
  );
  const bytes = await getDisplayObject(result.file_pointer.storage_path);
  assert.ok(bytes && bytes.length > 10_000, 'a real MP4, not a stub');
  assert.ok(result.duration_seconds >= 3 && result.duration_seconds <= 10.5, 'a 3-10 s clip');
  assert.equal(result.cost.rate_basis, 'usage_tokens', 'billed from the returned usage tokens');
  assert.ok(result.cost.video_tokens > 0);
  writeFileSync(join(out, `${name}.mp4`), bytes);
  results.push({ name, ...result });
  const replay = await generateVideo(
    await resolveContext({ kind: 'agent', userId, agentId }),
    body
  );
  assert.equal(replay.replayed, true, 'retry replays without a second provider call');
  assert.equal(replay.file_pointer.sha256, result.file_pointer.sha256);
  return result;
}

test('live: text-to-video', { skip: !live }, async () => {
  await run('text', {
    prompt:
      'A slow cinematic dolly shot of rain falling on a neon-lit city street at night, reflections on wet asphalt, a lone cyclist passes by.',
    duration_seconds: 6,
    seed: 1234,
    audio_direction: 'ambient rain and distant city sounds',
    avoid: 'text and logos',
  });
});

test('live: image-referenced video', { skip: !live }, async () => {
  const png = readFileSync(join(out, 'ref.png'));
  const path = `${userId}/refs/ref.png`;
  await putDisplayObject(path, png, 'image/png');
  await run('image', {
    prompt: 'The scene comes alive: gentle camera push-in, soft natural motion.',
    duration_seconds: 4,
    resolution: '360p',
    images: [{ role: 'first_frame', file: path }],
    audio: false,
  });
});
