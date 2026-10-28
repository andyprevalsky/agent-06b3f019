/**
 * Fixtures for agent-tools-video.blackbox.ts: a minimal MP4 and the REAL Gemini
 * Omni Interactions response shape (captured live 2026-10-28, signature
 * shortened), so the mock speaks exactly what Google returns.
 */
import { randomUUID } from 'node:crypto';
import { omniVideoModel } from '../../providers/gemini/omniVideo';

export interface Recorded {
  method: string;
  path: string;
  key: string | undefined;
  body: Record<string, unknown> | null;
}

export type Respond = (status: number, body: unknown, raw?: Buffer) => void;

/** Smallest well-formed MP4 header: ftyp + moov/mvhd (timescale 1000, duration ms) + a random tail. */
export function mp4(durationMs: number): Buffer {
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
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(randomUUID()),
]);
export const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from(randomUUID()),
]);
export const FILE_ID = 'zcvpe1ezs3bg';
/** The live usage block of a 360p 10 s clip (video tokens scale with seconds x resolution). */
export const LIVE_USAGE = (videoTokens: number) => ({
  total_tokens: 10 + videoTokens + 274,
  total_input_tokens: 10,
  input_tokens_by_modality: [{ modality: 'text', tokens: 10 }],
  total_cached_tokens: 0,
  total_output_tokens: videoTokens,
  output_tokens_by_modality: [{ modality: 'video', tokens: videoTokens }],
  total_tool_use_tokens: 0,
  total_thought_tokens: 274,
});
/** The live creation response (uri delivery), signature shortened. */
export const liveResponse = (videoTokens: number | null, fileId = FILE_ID) => ({
  id: 'v1_ChZJMTdoYXQ2aU0tV3FqTWNQMWNDcktB',
  status: 'completed',
  ...(videoTokens === null ? {} : { usage: LIVE_USAGE(videoTokens) }),
  created: '2026-10-28T02:30:09Z',
  updated: '2026-10-28T02:30:09Z',
  service_tier: 'standard',
  steps: [
    { signature: 'ErcmCrQmAWkU', type: 'thought' },
    {
      content: [
        {
          uri: `https://generativelanguage.googleapis.com/v1beta/files/${fileId}:download?alt=media`,
          mime_type: 'video/mp4',
          type: 'video',
        },
      ],
      type: 'model_output',
    },
  ],
  object: 'interaction',
  model: omniVideoModel(),
});
/** Files API: status (ACTIVE) and download for FILE_ID-style ids; null when not a files path. */
export function filesApi(
  req: Recorded,
  respond: Respond,
  bytes: Buffer,
  fileId = FILE_ID
): boolean {
  if (req.path === `/v1beta/files/${fileId}:download`) respond(200, null, bytes);
  else if (req.path === `/v1beta/files/${fileId}`)
    respond(200, { name: `files/${fileId}`, state: 'ACTIVE' });
  else return false;
  return true;
}
export const inlineVideo = (bytes: Buffer) => ({
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
