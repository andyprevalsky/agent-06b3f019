#!/usr/bin/env tsx
/**
 * Black-box contract for generate_video (Gemini Omni) — the backend core behind
 * POST /api/agent-tools/:agentId/generate-video.
 *
 *   mock Gemini server (GEMINI_API_BASE_URL) ◄── generateVideo(ctx, body) ──► Postgres + local storage
 *
 *   `rose video` CLI ──► express(agentToolsRouter) ──► same core ──► mock Gemini
 *
 * The mock answers with the REAL live response shape (captured 2026-10-28 from
 * gemini-omni-1.1-flash): a `thought` step, then a `model_output` step whose video
 * part is a Files API `uri` (".../files/{id}:download?alt=media"), plus `usage`
 * with output_tokens_by_modality[video]; errors are {"error":{"message","code"}}.
 *
 * Invariants:
 *   - request shape: POST /v1beta/interactions, key in x-goog-api-key, configured model,
 *     response_format {video, aspect_ratio, resolution incl 4k, delivery uri}, store TRUE
 *     (Google refuses uri delivery without it), stream false, seed in generation_config;
 *     duration/audio/audio direction/avoid steer the prompt; images ride as base64 image
 *     inputs ordered first frame, last frame, references, bound by declaration tags
 *   - inline (base64) and URI delivery (Files API polled until ACTIVE, then downloaded)
 *   - the MP4 lands at <owner>/generated-video/<sha256>.mp4 and the result carries a
 *     file pointer + display_path + download_path; it reports the REAL mp4 duration
 *   - cost: ToolUsage row (tool generate_video), cents = ceil(documented $/1M tokens x the
 *     response's usage tokens); per-second estimate only when usage is missing
 *   - idempotency: same key => same file, ONE provider call, ONE usage row (sequential,
 *     concurrent => 409 while in flight); a different key generates again
 *   - truthful errors: provider safety/quota message surfaced; a definitive 4xx leaves the key
 *     retryable; an ambiguous 5xx leaves it UNCERTAIN (409, needs a new key, never re-billed)
 *   - Google's exact error message reaches the model (real {"error":{message,code}} body)
 *   - bad images (non-image) are refused before any provider call
 *   - generated-video download is owner-scoped; the `rose video` CLI generates, downloads
 *     a byte-identical MP4, displays it with a caption, and a rerun replays (no new call)
 * Usage: bash scripts/run-blackbox-tests.sh agent-tools-video
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import express from 'express';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { getDisplayObject, putDisplayObject } from '../../providers/agentTools/media';
import { mintAgentToolsToken } from '../../providers/agentTools/token';
import { agentToolsCliScript } from '../../providers/agentTools/workspace';
import { omniVideoModel } from '../../providers/gemini/omniVideo';
import agentToolsRouter from '../../domains/agent-tools/routes';
import { resolveContext, AgentToolsError } from '../../domains/agent-tools/service';
import {
  buildVideoPrompt,
  generateVideo,
  generatedVideoStoragePath,
  readGeneratedVideo,
  videoOperationKey,
} from '../../domains/agent-tools/videoService';
import { generateVideoRequestSchema } from '../../domains/agent-tools/videoTypes';
import {
  FILE_ID,
  JPEG,
  PNG,
  filesApi,
  inlineVideo,
  liveResponse,
  mp4,
  type Recorded,
  type Respond,
} from './agent-tools-video.support';
config();

const RUN = randomUUID().slice(0, 8);
const userId = `agent-tools-video-${RUN}`;
const agentId = randomUUID();
const storageDir = mkdtempSync(join(tmpdir(), 'video-storage-'));

let calls: Recorded[] = [];
let handler: (req: Recorded, respond: Respond) => void;
let server: Server;
const saved: Record<string, string | undefined> = {};

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
    // Ignore method-only host probes before invoking any scenario handler.
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    // Other local non-API probes never reach a Gemini scenario handler.
    if (!(req.url ?? '').split('?')[0].startsWith('/v1beta/')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    // Other blackbox domains may also probe ephemeral ports while this server is bound.
    // Keep those requests out of the provider-call count and the per-test handler.
    if (req.headers['x-goog-api-key'] !== 'blackbox-gemini-key') {
      res.writeHead(404).end();
      return;
    }
    void readJson(req).then((body) => {
      const recorded: Recorded = {
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0],
        key: req.headers['x-goog-api-key'] as string | undefined,
        body,
      };
      calls.push(recorded);
      if (typeof handler !== 'function') {
        res.writeHead(503).end();
        return;
      }
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
  await prisma.message.deleteMany({ where: { agentId } });
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

test('non-video probes do not invoke or count as scenario requests', async () => {
  calls = [];
  handler = (_req, respond) => respond(500, { error: 'unexpected scenario dispatch' });
  const head = await fetch(`${process.env.GEMINI_API_BASE_URL}/`, { method: 'HEAD' });
  assert.equal(head.status, 404);
  const response = await fetch(`${process.env.GEMINI_API_BASE_URL}/`);
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test('real response shape: store true, seed, prompt-level controls, usage-token cost, usage row', async () => {
  calls = [];
  const bytes = mp4(8040);
  handler = (req, respond) => {
    if (req.path === '/v1beta/interactions') respond(200, liveResponse(46_568));
    else if (!filesApi(req, respond, bytes)) respond(404, { error: { message: req.path } });
  };
  const request = body({
    duration_seconds: 8,
    aspect_ratio: '9:16',
    resolution: '720p',
    seed: 42,
    audio_direction: 'a low synth swell, no dialogue',
    avoid: 'text overlays and logos',
  });
  const result = await generateVideo(await ctx(), request);

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
  assert.equal(call.body?.store, true, 'Google requires store=true for uri delivery');
  assert.equal(call.body?.stream, false);
  assert.equal('background' in (call.body ?? {}), false);
  assert.deepEqual(call.body?.generation_config, { seed: 42 });
  const prompt = String(call.body?.input);
  assert.match(prompt, /^A marble rolling/);
  assert.match(prompt, /Duration: about 8 seconds\./);
  assert.match(prompt, /Audio: a low synth swell, no dialogue/);
  assert.match(prompt, /Avoid: text overlays and logos/);
  assert.equal(
    calls.map((c) => c.path).join(','),
    `/v1beta/interactions,/v1beta/files/${FILE_ID},/v1beta/files/${FILE_ID}:download`
  );
  assert.ok(
    calls.slice(1).every((c) => c.key === 'blackbox-gemini-key'),
    'the key authenticates the download'
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.replayed, false);
  assert.equal(result.duration_seconds, 8.04);
  assert.equal(result.seed, 42);
  // 46,568 video tokens x $17.50/M + 274 thinking x $9/M + 10 input x $1.50/M = $0.8174
  assert.equal(result.cost.rate_basis, 'usage_tokens');
  assert.equal(result.cost.video_tokens, 46_568);
  assert.equal(result.cost.cents, 82);
  assert.match(
    result.file_pointer.storage_path,
    new RegExp(`^${userId}/generated-video/[0-9a-f]{64}\\.mp4$`)
  );
  assert.equal(result.display_path, result.file_pointer.storage_path);
  assert.equal(result.download_path, `/generated-video/${result.file_pointer.sha256}`);
  const stored = await getDisplayObject(result.file_pointer.storage_path);
  assert.ok(stored?.equals(bytes), 'stored bytes equal the provider bytes');
  assert.ok((await readGeneratedVideo(await ctx(), result.file_pointer.sha256)).equals(bytes));
  const rows = await usageRows(videoOperationKey(agentId, request.idempotency_key));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolName, 'generate_video');
  assert.equal(rows[0].totalCostCents, 82);
});

test('inline delivery without usage falls back to the per-second estimate; silence is prompt-level', async () => {
  calls = [];
  handler = (_req, respond) => respond(200, inlineVideo(mp4(4000)));
  const result = await generateVideo(await ctx(), body({ resolution: '4k', audio: false }));
  assert.match(String(calls[0].body?.input), /silent video/);
  assert.equal(result.cost.rate_basis, 'estimated');
  assert.equal(result.cost.video_tokens, 4 * 17_238);
  assert.equal(result.cost.cents, Math.ceil(4 * 17_238 * 17.5e-4));
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
  assert.equal(result.cost.rate_basis, 'estimated');
  assert.equal(result.cost.cents, Math.ceil(5 * 8_604 * 17.5e-4));
  assert.ok((await getDisplayObject(result.file_pointer.storage_path))?.equals(bytes));
});

test('images: first frame, last frame, references ordered and bound by tags; non-images refused first', async () => {
  calls = [];
  const path = `${userId}/refs/frame-${RUN}.png`;
  await putDisplayObject(path, PNG, 'image/png');
  await putDisplayObject(`${userId}/refs/notes-${RUN}.txt`, Buffer.from('hello'), 'text/plain');
  handler = (_req, respond) => respond(200, inlineVideo(mp4(2000)));
  const request = body({
    images: [
      { role: 'reference', content_base64: JPEG.toString('base64') },
      { role: 'last_frame', content_base64: PNG.toString('base64') },
      { role: 'first_frame', file: path },
    ],
  });
  await generateVideo(await ctx(), request);
  const input = calls[0].body?.input as Array<{
    type: string;
    data?: string;
    mime_type?: string;
    text?: string;
  }>;
  assert.deepEqual(
    input.map((part) => part.mime_type ?? part.type),
    ['image/png', 'image/png', 'image/jpeg', 'text']
  );
  assert.equal(input[0].data, PNG.toString('base64'));
  assert.equal(input[2].data, JPEG.toString('base64'));
  const text = String(input[3].text);
  assert.equal(text, buildVideoPrompt(request));
  assert.match(
    text,
    /^\[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2\]\n\[# References <IMAGE_REF_0>@Image3\]/
  );
  assert.match(text, /Start exactly on <FIRST_FRAME> and end exactly on <LAST_FRAME>\./);
  assert.match(text, /consistent/);

  calls = [];
  await assert.rejects(
    async () =>
      generateVideo(
        await ctx(),
        body({ images: [{ role: 'reference', file: `${userId}/refs/notes-${RUN}.txt` }] })
      ),
    (err: unknown) =>
      err instanceof AgentToolsError &&
      err.status === 400 &&
      (err.details ?? []).some((d) => /PNG, JPEG or WebP/.test(d))
  );
  assert.equal(calls.length, 0);
});

test("Google's exact error message (real {error:{message,code}} body) reaches the model", async () => {
  calls = [];
  const message = 'store=true is required when response format has video delivery set to URI.';
  handler = (_req, respond) => respond(400, { error: { message, code: 'invalid_request' } });
  await assert.rejects(
    async () => generateVideo(await ctx(), body()),
    (err: unknown) =>
      err instanceof AgentToolsError &&
      err.status === 422 &&
      err.message.includes(message) &&
      err.message.includes('invalid_request') &&
      err.message.includes('HTTP 400')
  );
  handler = (_req, respond) =>
    respond(429, {
      error: {
        message:
          'Rate limit exceeded for model gemini-omni-1.1-flash (limit: 0 requests per day on Free Tier).',
        code: 'too_many_requests',
      },
    });
  await assert.rejects(
    async () => generateVideo(await ctx(), body()),
    (err: unknown) => err instanceof AgentToolsError && /Free Tier/.test(err.message)
  );
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

test('request schema bounds spend: duration 3-10, images, resolution, key required, strict', () => {
  const ok = { prompt: 'p', idempotency_key: 'abcdefgh' };
  for (const good of [
    ok,
    { ...ok, resolution: '4k', duration_seconds: 3, seed: 0 },
    { ...ok, duration_seconds: 10, audio_direction: 'rain' },
    {
      ...ok,
      images: [
        { role: 'first_frame', file: 'a.png' },
        { role: 'last_frame', file: 'b.png' },
        { role: 'reference', file: 'c.png' },
        { role: 'reference', file: 'd.png' },
        { role: 'reference', content_base64: 'AAAA' },
      ],
    },
  ]) {
    assert.equal(generateVideoRequestSchema.safeParse(good).success, true, JSON.stringify(good));
  }
  const ref = { role: 'reference', file: 'r.png' };
  for (const bad of [
    { ...ok, duration_seconds: 11 },
    { ...ok, duration_seconds: 2 },
    { ...ok, duration_seconds: 5.5 },
    { ...ok, resolution: '8k' },
    { ...ok, temperature: 0.7 },
    { ...ok, seed: -1 },
    { ...ok, images: [ref, ref, ref, ref] },
    { ...ok, images: [{ role: 'last_frame', file: 'b.png' }] },
    { ...ok, images: [{ role: 'reference' }] },
    { ...ok, images: [{ role: 'reference', file: 'a', content_base64: 'AAAA' }] },
    { ...ok, audio: false, audio_direction: 'music' },
    { ...ok, reference_files: ['a'] },
    { prompt: 'p' },
    { ...ok, extra: 1 },
  ]) {
    assert.equal(generateVideoRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('generated-video download is owner-scoped and refuses non-hash names', async () => {
  const bytes = mp4(3000);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await putDisplayObject(generatedVideoStoragePath(userId, sha), bytes, 'video/mp4');
  assert.ok((await readGeneratedVideo(await ctx(), sha)).equals(bytes));
  for (const name of ['0'.repeat(64), '../secret', sha.toUpperCase()]) {
    await assert.rejects(
      async () => readGeneratedVideo(await ctx(), name),
      (err: unknown) => err instanceof AgentToolsError && err.status === 404
    );
  }
});

test('`rose video` CLI: route → generate → byte-identical download → captioned display; rerun replays', async () => {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use('/api/agent-tools', agentToolsRouter);
  const api = createServer(app);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = (api.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'rose-video-cli-'));
  try {
    const cli = join(home, 'rose.cjs');
    writeFileSync(cli, agentToolsCliScript());
    const frame = join(home, 'frame.png');
    writeFileSync(frame, PNG);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ROSE_TOOLS_URL: `http://127.0.0.1:${port}/api/agent-tools/${agentId}`,
      ROSE_TOOLS_TOKEN: mintAgentToolsToken(userId, agentId, { provider: 'claude' }).token,
    };
    const bytes = mp4(6000);
    calls = [];
    handler = (req, respond) => {
      if (req.path === '/v1beta/interactions') respond(200, liveResponse(11_586));
      else if (!filesApi(req, respond, bytes)) respond(404, { error: { message: req.path } });
    };
    const run = promisify(execFile);
    const args = [
      cli,
      'video',
      'A paper boat drifts down a rain gutter, close-up',
      '--out',
      join(home, 'shot1.mp4'),
      '--duration',
      '6',
      '--resolution',
      '360p',
      '--aspect',
      '9:16',
      '--seed',
      '7',
      '--first-frame',
      frame,
      '--audio',
      'rain on tin',
      '--avoid',
      'people',
      '--caption',
      'Shot 1 of 2: the boat. Next: the storm drain.',
    ];
    const first = await run('node', args, { env, cwd: home });
    assert.match(first.stdout, /video: .*shot1\.mp4 \(6\.0 s, 360p 9:16/);
    assert.match(first.stdout, /cost: \$0\.21 /);
    assert.match(first.stdout, /displayed video\/mp4 \(message /);
    assert.ok(readFileSync(join(home, 'shot1.mp4')).equals(bytes), 'byte-identical MP4 on disk');
    const sent = calls[0].body ?? {};
    assert.deepEqual(sent.response_format, {
      type: 'video',
      aspect_ratio: '9:16',
      resolution: '360p',
      delivery: 'uri',
    });
    assert.deepEqual(sent.generation_config, { seed: 7 });
    const input = sent.input as Array<{ type: string; data?: string; text?: string }>;
    assert.equal(input[0].data, PNG.toString('base64'));
    assert.match(
      String(input[1].text),
      /<FIRST_FRAME>@Image1[\s\S]*about 6 seconds[\s\S]*Audio: rain on tin[\s\S]*Avoid: people/
    );
    const shown = await prisma.message.findMany({
      where: { agentId, role: 'ASSISTANT', text: 'Shot 1 of 2: the boat. Next: the storm drain.' },
    });
    assert.equal(shown.length, 1, 'the clip is displayed to the user with its commentary');
    const pointer = shown[0].filePointer as { storage_path?: string } | null;
    assert.match(String(pointer?.storage_path), /\.mp4$/, 'the displayed item is the video');

    const providerCalls = calls.length;
    const again = await run('node', args, { env, cwd: home });
    assert.match(again.stdout, /no new charge/);
    assert.equal(calls.length, providerCalls, 'a rerun of the same command never reaches Google');

    // Help never spends: `rose video`, `-h`, `--help` print usage; a flag-looking prompt is refused.
    const before = calls.length;
    for (const help of [[], ['-h'], ['--help'], ['a shot', '--help']]) {
      const shown = await run('node', [cli, 'video', ...help], { env, cwd: home });
      assert.match(shown.stdout, /rose video <prompt>[\s\S]*talk-to-user\/video\.md/);
    }
    const flagPrompt = await run('node', [cli, 'video', '-x'], { env, cwd: home }).then(
      () => null,
      (err: { code?: number; stderr?: string }) => err
    );
    assert.ok(flagPrompt !== null && /not a shot description/.test(String(flagPrompt.stderr)));
    assert.equal(calls.length, before, 'help and typos never reach Google');

    const bad = await run('node', [cli, 'video', 'x', '--duration', '12'], { env, cwd: home }).then(
      () => null,
      (err: { code?: number; stderr?: string }) => err
    );
    assert.ok(bad !== null && bad.code === 1 && /3 to 10/.test(String(bad.stderr)));
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
