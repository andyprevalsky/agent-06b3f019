#!/usr/bin/env tsx
/**
 * Black-box contract for generate_video (Gemini Omni) — the backend core behind
 * POST /api/agent-tools/:agentId/generate-video.
 *
 *   mock Gemini server (GEMINI_API_BASE_URL) ◄── generateVideo(ctx, body) ──► Postgres + local storage
 *
 * Invariants:
 *   - request shape: POST /v1beta/interactions, key in x-goog-api-key, configured model,
 *     response_format {video, aspect_ratio, resolution, delivery uri}, store/background/stream
 *     false, duration/audio steer the prompt, reference images ride as base64 image inputs
 *   - inline (base64) and URI delivery (Files API polled until ACTIVE, then downloaded)
 *   - the MP4 lands at <owner>/generated-video/<sha256>.mp4 and the result carries a
 *     file pointer + display_path; the response reports the REAL mp4 duration and cost
 *   - cost: ToolUsage row (tool generate_video), cents = ceil($0.10/s x real duration)
 *   - idempotency: same key => same file, ONE provider call, ONE usage row (sequential,
 *     concurrent => 409 while in flight); a different key generates again
 *   - truthful errors: provider safety/quota message surfaced; a definitive 4xx leaves the key
 *     retryable; an ambiguous 5xx leaves it UNCERTAIN (409, needs a new key, never re-billed)
 *   - bad references (non-image) are refused before any provider call
 * Usage: bash scripts/run-blackbox-tests.sh agent-tools-video
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { getDisplayObject } from '../../providers/agentTools/media';
import { omniVideoModel } from '../../providers/gemini/omniVideo';
import { resolveContext, AgentToolsError } from '../../domains/agent-tools/service';
import { generateVideo, videoOperationKey } from '../../domains/agent-tools/videoService';
import { generateVideoRequestSchema } from '../../domains/agent-tools/videoTypes';
config();

const RUN = randomUUID().slice(0, 8);
const userId = `agent-tools-video-${RUN}`;
const agentId = randomUUID();
const storageDir = mkdtempSync(join(tmpdir(), 'video-storage-'));

interface Recorded {
  method: string;
  path: string;
  key: string | undefined;
  body: Record<string, unknown> | null;
}
let calls: Recorded[] = [];
let handler: (
  req: Recorded,
  respond: (status: number, body: unknown, raw?: Buffer) => void
) => void;
let server: Server;
const saved: Record<string, string | undefined> = {};

/** Smallest well-formed MP4 header: ftyp + moov/mvhd (timescale 1000, duration ms) + a random tail. */
function mp4(durationMs: number): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 16]),
    Buffer.from('ftypisom'),
    Buffer.alloc(4),
  ]);
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(1000, 12);
  mvhdBody.writeUInt32BE(durationMs, 16);
  const mvhd = Buffer.concat([
    Buffer.from([0, 0, 0, 8 + mvhdBody.length]),
    Buffer.from('mvhd'),
    mvhdBody,
  ]);
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + mvhd.length]), Buffer.from('moov'), mvhd]);
  const mdat = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('mdat'),
    Buffer.from(randomUUID()),
  ]);
  return Buffer.concat([ftyp, moov, mdat]);
}
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(randomUUID()),
]);
const inlineVideo = (bytes: Buffer) => ({
  id: 'v1_test',
  status: 'completed',
  model: omniVideoModel(),
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
    {
      type: 'model_output',
      content: [{ type: 'video', mime_type: 'video/mp4', data: bytes.toString('base64') }],
    },
  ],
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

before(async () => {
  for (const name of [
    'GEMINI_API_BASE_URL',
    'GEMINI_API_KEY',
    'DISPLAY_STORAGE_BACKEND',
    'DISPLAY_STORAGE_LOCAL_DIR',
  ]) {
    saved[name] = process.env[name];
  }
  server = createServer((req, res) => {
    void readJson(req).then((body) => {
      const recorded: Recorded = {
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0],
        key: req.headers['x-goog-api-key'] as string | undefined,
        body,
      };
      calls.push(recorded);
      handler(recorded, (status, payload, raw) => {
        res.statusCode = status;
        if (raw) {
          res.setHeader('Content-Type', 'video/mp4');
          res.end(raw);
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  process.env.GEMINI_API_KEY = 'blackbox-gemini-key';
  process.env.DISPLAY_STORAGE_BACKEND = 'local';
  process.env.DISPLAY_STORAGE_LOCAL_DIR = storageDir;
  await prisma.user.create({ data: { userId, name: 'Video Test' } });
  await prisma.agent.create({
    data: { id: agentId, userId, goal: 'video blackbox', status: 'ACTIVE' },
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const keys = await prisma.toolSideEffect.findMany({
    where: { operationKey: { startsWith: `generate_video:${agentId}:` } },
    select: { operationKey: true },
  });
  await prisma.toolUsage.deleteMany({ where: { agentId } });
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: { in: keys.map((k) => k.operationKey) } },
  });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.user.deleteMany({ where: { userId } });
  rmSync(storageDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await prisma.$disconnect();
});

const ctx = () => resolveContext({ kind: 'agent', userId, agentId });
const body = (extra: Record<string, unknown> = {}) =>
  generateVideoRequestSchema.parse({
    prompt: 'A marble rolling on a chain-reaction track',
    idempotency_key: `key-${randomUUID()}`,
    ...extra,
  });
const usageRows = (operationKey: string) =>
  prisma.toolUsage.findMany({ where: { operationKey: `${operationKey}:usage` } });

test('request shape, inline delivery, real duration cost, storage, usage row', async () => {
  calls = [];
  const bytes = mp4(8040);
  handler = (_req, respond) => respond(200, inlineVideo(bytes));
  const request = body({
    duration_seconds: 8,
    audio: false,
    aspect_ratio: '9:16',
    resolution: '720p',
  });
  const result = await generateVideo(await ctx(), request);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1beta/interactions');
  assert.equal(call.key, 'blackbox-gemini-key');
  assert.equal(call.body?.model, omniVideoModel());
  assert.deepEqual(call.body?.response_format, {
    type: 'video',
    aspect_ratio: '9:16',
    resolution: '720p',
    delivery: 'uri',
  });
  assert.equal(call.body?.store, false);
  assert.equal(call.body?.background, false);
  assert.equal(call.body?.stream, false);
  const prompt = String(call.body?.input);
  assert.match(prompt, /marble rolling/);
  assert.match(prompt, /about 8 seconds/);
  assert.match(prompt, /silent video/);

  assert.equal(result.status, 'completed');
  assert.equal(result.replayed, false);
  assert.equal(result.duration_seconds, 8.04);
  assert.equal(result.cost.cents, 81);
  assert.equal(result.cost.rate_basis, 'published');
  assert.match(
    result.file_pointer.storage_path,
    new RegExp(`^${userId}/generated-video/[0-9a-f]{64}\\.mp4$`)
  );
  assert.equal(result.display_path, result.file_pointer.storage_path);
  const stored = await getDisplayObject(result.file_pointer.storage_path);
  assert.ok(stored?.equals(bytes), 'stored bytes equal the provider bytes');
  const rows = await usageRows(videoOperationKey(agentId, request.idempotency_key));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolName, 'generate_video');
  assert.equal(rows[0].totalCostCents, 81);
});

test('idempotent retry: same file, one provider call, one usage row; new key generates again', async () => {
  calls = [];
  handler = (_req, respond) => respond(200, inlineVideo(mp4(4000)));
  const request = body();
  const first = await generateVideo(await ctx(), request);
  const again = await generateVideo(await ctx(), request);
  assert.equal(calls.length, 1, 'retry never reaches the provider');
  assert.equal(again.replayed, true);
  assert.equal(again.file_pointer.storage_path, first.file_pointer.storage_path);
  assert.equal(again.cost.cents, first.cost.cents);
  assert.equal((await usageRows(videoOperationKey(agentId, request.idempotency_key))).length, 1);
  await generateVideo(await ctx(), body());
  assert.equal(calls.length, 2, 'a different key is a new generation');
});

test('a concurrent duplicate is refused while the first is in flight, then replays', async () => {
  calls = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  handler = (_req, respond) => {
    arrived();
    void gate.then(() => respond(200, inlineVideo(mp4(3000))));
  };
  const request = body();
  const first = generateVideo(await ctx(), request);
  await reached;
  await assert.rejects(
    async () => generateVideo(await ctx(), request),
    (err: unknown) => err instanceof AgentToolsError && err.status === 409
  );
  release();
  const done = await first;
  assert.equal(calls.length, 1);
  assert.equal(
    (await generateVideo(await ctx(), request)).file_pointer.sha256,
    done.file_pointer.sha256
  );
});

test('URI delivery polls the Files API until ACTIVE, then downloads', async () => {
  calls = [];
  const bytes = mp4(5000);
  let polls = 0;
  handler = (req, respond) => {
    if (req.path === '/v1beta/interactions') {
      respond(200, {
        id: 'v1_uri',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'video',
                mime_type: 'video/mp4',
                uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media',
              },
            ],
          },
        ],
      });
    } else if (req.path === '/v1beta/files/abc-123:download') {
      respond(200, null, bytes);
    } else if (req.path === '/v1beta/files/abc-123') {
      polls += 1;
      respond(200, { state: polls < 2 ? 'PROCESSING' : 'ACTIVE' });
    } else respond(404, { error: { message: `unexpected ${req.path}` } });
  };
  const result = await generateVideo(await ctx(), body({ resolution: '1080p' }));
  assert.equal(polls, 2);
  assert.equal(result.duration_seconds, 5);
  assert.equal(result.cost.cents, 50);
  assert.equal(result.cost.rate_basis, 'assumed');
  assert.ok((await getDisplayObject(result.file_pointer.storage_path))?.equals(bytes));
});

test('reference images are sent as base64 image inputs; non-images are refused before any call', async () => {
  calls = [];
  const path = `${userId}/refs/frame-${RUN}.png`;
  const { putDisplayObject } = await import('../../providers/agentTools/media');
  await putDisplayObject(path, PNG, 'image/png');
  await putDisplayObject(`${userId}/refs/notes-${RUN}.txt`, Buffer.from('hello'), 'text/plain');
  handler = (_req, respond) => respond(200, inlineVideo(mp4(2000)));
  await generateVideo(await ctx(), body({ reference_files: [path] }));
  const input = calls[0].body?.input as Array<{
    type: string;
    data?: string;
    mime_type?: string;
    text?: string;
  }>;
  assert.equal(input[0].type, 'image');
  assert.equal(input[0].mime_type, 'image/png');
  assert.equal(input[0].data, PNG.toString('base64'));
  assert.equal(input[1].type, 'text');

  calls = [];
  await assert.rejects(
    async () =>
      generateVideo(await ctx(), body({ reference_files: [`${userId}/refs/notes-${RUN}.txt`] })),
    (err: unknown) => err instanceof AgentToolsError && err.status === 400
  );
  assert.equal(calls.length, 0);
});

test('definitive provider refusal is surfaced verbatim and the key stays retryable', async () => {
  calls = [];
  handler = (_req, respond) =>
    respond(400, {
      error: { status: 'INVALID_ARGUMENT', message: 'Prompt blocked by safety filters' },
    });
  const request = body();
  await assert.rejects(
    async () => generateVideo(await ctx(), request),
    (err: unknown) =>
      err instanceof AgentToolsError &&
      err.status === 422 &&
      /blocked by safety filters/.test(err.message)
  );
  assert.equal((await usageRows(videoOperationKey(agentId, request.idempotency_key))).length, 0);
  handler = (_req, respond) => respond(200, inlineVideo(mp4(2000)));
  const retried = await generateVideo(await ctx(), request);
  assert.equal(retried.replayed, false);
  assert.equal(calls.length, 2);
});

test('an ambiguous provider failure is never re-billed under the same key', async () => {
  calls = [];
  handler = (_req, respond) =>
    respond(503, { error: { status: 'UNAVAILABLE', message: 'overloaded' } });
  const request = body();
  await assert.rejects(
    async () => generateVideo(await ctx(), request),
    (err: unknown) =>
      err instanceof AgentToolsError && err.status === 502 && /overloaded/.test(err.message)
  );
  await assert.rejects(
    async () => generateVideo(await ctx(), request),
    (err: unknown) =>
      err instanceof AgentToolsError &&
      err.status === 409 &&
      /new idempotency_key/.test(err.message)
  );
  assert.equal(calls.length, 1);
});

test('a malformed provider response after the request was sent is never re-billed', async () => {
  calls = [];
  handler = (_req, respond) => respond(200, {}, Buffer.from('not json'));
  const request = body();
  await assert.rejects(async () => generateVideo(await ctx(), request));
  await assert.rejects(
    async () => generateVideo(await ctx(), request),
    (err: unknown) =>
      err instanceof AgentToolsError &&
      err.status === 409 &&
      /new idempotency_key/.test(err.message)
  );
  assert.equal(calls.length, 1);
});

test('a response with no video is reported, not treated as success', async () => {
  handler = (_req, respond) => respond(200, { id: 'v1_none', status: 'completed', steps: [] });
  await assert.rejects(
    async () => generateVideo(await ctx(), body()),
    (err: unknown) => err instanceof AgentToolsError && /no video/.test(err.message)
  );
});

test('request schema bounds spend: duration, references, resolution, key required', () => {
  const ok = { prompt: 'p', idempotency_key: 'abcdefgh' };
  assert.equal(generateVideoRequestSchema.safeParse(ok).success, true);
  for (const bad of [
    { ...ok, duration_seconds: 11 },
    { ...ok, reference_files: ['a', 'b', 'c', 'd'] },
    { ...ok, resolution: '4k' },
    { prompt: 'p' },
    { ...ok, extra: 1 },
  ]) {
    assert.equal(generateVideoRequestSchema.safeParse(bad).success, false);
  }
});
