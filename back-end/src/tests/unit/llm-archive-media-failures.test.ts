#!/usr/bin/env tsx
/**
 * Media model calls (Gemini video, ElevenLabs STT) archive a FINAL record on
 * every failure path, and never reference a media object whose write failed.
 *
 *   video provider HTTP 500          ─► OmniVideoError rethrown; final record output.error
 *   video ok, media/video write fails ─► final: video_archive_error + inline bytes, no path
 *   STT HTTP 429                      ─► transcript null; final record error + status
 *   STT ok, media/stt write fails     ─► start record carries the audio inline
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { generateOmniVideo, OmniVideoError } from '../../providers/gemini/omniVideo';
import { processInboundAttachments } from '../../providers/smsSupervisor/inboundMedia';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';
import { archiveRecordSchemaErrors } from '../helpers/llmArchiveRecordSchema';
import { inlineVideo, mp4 } from '../blackbox/agent-tools-video.support';

type ArchiveRecord = Record<string, unknown> & { output?: Record<string, unknown> };

async function records(root: string, callSite: string): Promise<ArchiveRecord[]> {
  const objects = (await listArchivedObjects(root, { throwOnError: true })).filter((item) =>
    /^(llm|llm-updates)\//.test(item.path)
  );
  const found: ArchiveRecord[] = [];
  for (const object of objects) {
    const stored = await readArchivedArtifactStrict({ rootAgentId: root, objectPath: object.path });
    assert(stored);
    const record = JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as ArchiveRecord;
    assert.deepEqual(archiveRecordSchemaErrors(record), [], `${object.path} schema-valid`);
    if (record.call_site === callSite) found.push(record);
  }
  return found;
}

function finalOf(found: ArchiveRecord[]): ArchiveRecord {
  const finals = found.filter((record) => record.record === 'final');
  assert.equal(finals.length, 1, 'exactly one final record');
  return finals[0];
}

/** Make every media/ write under a root fail (ENOTDIR: its media/ directory is a file). */
function blockMediaWrites(directory: string, root: string): void {
  const bundle = path.join(directory, 'trace-archive', root);
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'media'), 'blocked');
}

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-archive-media-'));
  const roots: string[] = [];
  const newRoot = () => {
    const root = `user-${randomUUID()}`;
    roots.push(root);
    return root;
  };
  const videoRequest = (root: string) => ({
    prompt: 'a lighthouse at dusk',
    images: [],
    aspectRatio: '16:9' as const,
    resolution: '720p' as const,
    archive: { archive_scope: { userId: root.slice('user-'.length) } },
  });
  try {
    process.env.NODE_ENV = 'test';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
    process.env.GEMINI_API_KEY = 'media-failures';
    process.env.ELEVENLABS_API_KEY = 'media-failures';
    let respond: (url: string) => Response = () => new Response(null, { status: 500 });
    globalThis.fetch = (async (input: string | URL | Request) =>
      respond(typeof input === 'string' ? input : input.toString())) as typeof fetch;

    // (1) Video provider HTTP 500: the error propagates and the capture is finalized.
    const failedRoot = newRoot();
    respond = () =>
      new Response(JSON.stringify({ error: { message: 'internal', code: 500 } }), { status: 500 });
    await assert.rejects(generateOmniVideo(videoRequest(failedRoot)), OmniVideoError);
    await drainLlmCaptures([failedRoot]);
    const failed = finalOf(await records(failedRoot, 'generate_video'));
    assert.match(String((failed.output?.error as { message?: string })?.message), /rejected/);

    // (2) Video ok but its media write fails: no dangling path, bytes kept inline.
    const videoRoot = newRoot();
    const video = mp4(8_000);
    blockMediaWrites(directory, videoRoot);
    respond = () => new Response(JSON.stringify(inlineVideo(video)), { status: 200 });
    const generated = await generateOmniVideo(videoRequest(videoRoot));
    assert.equal(generated.bytes.length, video.length, 'the caller still gets its video');
    await drainLlmCaptures([videoRoot]);
    const structured = finalOf(await records(videoRoot, 'generate_video')).output
      ?.structured as Record<string, unknown>;
    assert.equal(structured.video_archive_path, undefined, 'no reference to an unwritten object');
    assert.equal(typeof structured.video_archive_error, 'string');
    assert.equal(structured.video_data_base64, video.toString('base64'));

    // (3) STT HTTP 429: transcript null (fallback note), final record carries the status.
    const audio = Buffer.from(`OggS${randomUUID()}`);
    const sttRoot = newRoot();
    respond = (url) =>
      url.includes('elevenlabs')
        ? new Response('rate limited', { status: 429 })
        : new Response(audio, { status: 200, headers: { 'content-type': 'audio/ogg' } });
    const limited = await processInboundAttachments(
      [{ url: 'https://media.example/voice.ogg', type: 'audio/ogg' }],
      sttRoot.slice('user-'.length)
    );
    assert.deepEqual(limited.noteLines, ['[Voice note received but it could not be transcribed]']);
    await drainLlmCaptures([`sms-supervisor-${sttRoot.slice('user-'.length)}`, sttRoot]);
    const sttFinal = finalOf(await records(sttRoot, 'sms_voice_note_stt'));
    assert.match(String((sttFinal.output?.error as { message?: string })?.message), /429/);
    assert.equal((sttFinal.output?.structured as { status?: number }).status, 429);

    // (4) STT ok but the audio write fails: the start record carries the audio itself.
    const inlineRoot = newRoot();
    blockMediaWrites(directory, inlineRoot);
    respond = (url) =>
      url.includes('elevenlabs')
        ? new Response(JSON.stringify({ text: 'call me back' }), { status: 200 })
        : new Response(audio, { status: 200, headers: { 'content-type': 'audio/ogg' } });
    const transcribed = await processInboundAttachments(
      [{ url: 'https://media.example/voice.ogg', type: 'audio/ogg' }],
      inlineRoot.slice('user-'.length)
    );
    assert.deepEqual(transcribed.noteLines, ['[Voice note transcript]: call me back']);
    await drainLlmCaptures([`sms-supervisor-${inlineRoot.slice('user-'.length)}`, inlineRoot]);
    const start = (await records(inlineRoot, 'sms_voice_note_stt')).find(
      (record) => record.record === 'start'
    );
    const part = (start?.messages as { content: Record<string, unknown>[] }[])[0].content[0];
    assert.equal(part.data, audio.toString('base64'));
    assert.equal(part.archive_path, undefined);
    assert.equal(typeof part.archive_error, 'string');
    process.stdout.write('llm-archive-media-failures: all checks passed\n');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
    const dumpRoot = path.resolve(__dirname, '../../../..', '.llm-dumps');
    for (const root of roots) {
      fs.rmSync(path.join(dumpRoot, root), { recursive: true, force: true });
      const supervisor = `sms-supervisor-${root.slice('user-'.length)}`;
      fs.rmSync(path.join(dumpRoot, supervisor), { recursive: true, force: true });
    }
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
