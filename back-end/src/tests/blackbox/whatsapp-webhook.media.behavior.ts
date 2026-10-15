import { deepStrictEqual, rejects, strictEqual as assertEqual } from 'node:assert';
import type { PrismaClient } from '@prisma/client';
import {
  BASE_URL,
  request,
  assertStatus,
  waitFor,
  uniqueSmsPhone,
  cleanupAgentScopedUser,
} from './sms-supervisor.helpers';

// ==================== MEDIA PROCESSING (OFFLINE HTTP BOUNDARIES) ====================

const META_TOKEN = 'whatsapp-blackbox-token';
const MEDIA_ID = '172304219900099';
const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/fixture';
const META_URL = `https://graph.facebook.com/v21.0/${MEDIA_ID}`;

async function withMediaFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const values: Record<string, string> = {
    WHATSAPP_ACCESS_TOKEN: META_TOKEN,
    WHATSAPP_GRAPH_API_VERSION: 'v21.0',
    ELEVENLABS_API_KEY: 'elevenlabs-blackbox-key',
    SUPABASE_URL: 'https://supabase.whatsapp-blackbox.test',
    SUPABASE_SERVICE_ROLE_KEY: 'supabase-blackbox-key',
  };
  const previousEnv = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(values)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
}

function mediaMetadata(mimeType: string): Response {
  return Response.json({ url: MEDIA_URL, mime_type: mimeType });
}

function assertMetaAuthorization(init: RequestInit): void {
  assertEqual(new Headers(init.headers).get('authorization'), `Bearer ${META_TOKEN}`, 'Meta auth');
  assertEqual(init.method ?? 'GET', 'GET', 'media reads use GET');
}

async function testMedia_imageBytesAndFilePointer() {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=',
    'base64'
  );
  const calls: string[] = [];
  await withMediaFetch(
    async (url, init) => {
      calls.push(url);
      if (url === META_URL) {
        assertMetaAuthorization(init);
        return mediaMetadata('image/png');
      }
      if (url === MEDIA_URL) {
        assertMetaAuthorization(init);
        return new Response(bytes, { headers: { 'content-type': 'image/png' } });
      }
      if (url.includes('/storage/v1/object/attachments/')) {
        deepStrictEqual(Buffer.from(init.body as Uint8Array), bytes, 'uploaded image bytes');
        return Response.json({ Key: new URL(url).pathname.split('/object/')[1] });
      }
      throw new Error(`Unexpected outbound media call: ${url}`);
    },
    async () => {
      const { processInboundAttachments } =
        await import('../../providers/smsSupervisor/inboundMedia');
      const result = await processInboundAttachments(
        [{ mediaId: MEDIA_ID, type: 'image/png' }],
        'whatsapp-media-blackbox-user'
      );
      deepStrictEqual(result.imageBlocks, [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` },
        },
      ]);
      deepStrictEqual(result.noteLines, []);
      assertEqual(result.filePointers.length, 1, 'one image FilePointer');
      assertEqual(result.filePointers[0].mime_type, 'image/png', 'FilePointer MIME');
      assertEqual(result.filePointers[0].size_bytes, bytes.length, 'FilePointer size');
      assertEqual(
        result.filePointers[0].storage_path.startsWith('whatsapp-media-blackbox-user/'),
        true,
        'user-scoped storage'
      );
      assertEqual(calls.filter((url) => url === META_URL).length, 1, 'one metadata read');
      assertEqual(calls.filter((url) => url === MEDIA_URL).length, 1, 'one binary download');
      assertEqual(calls.length, 3, 'metadata, binary, and one upload only');
    }
  );
}

async function testMedia_voiceBytesAndTranscript() {
  const bytes = Buffer.from('OggS\u0000whatsapp-voice-fixture');
  const calls: string[] = [];
  await withMediaFetch(
    async (url, init) => {
      calls.push(url);
      if (url === META_URL) {
        assertMetaAuthorization(init);
        return mediaMetadata('audio/ogg; codecs=opus');
      }
      if (url === MEDIA_URL) {
        assertMetaAuthorization(init);
        return new Response(bytes, { headers: { 'content-type': 'audio/ogg' } });
      }
      if (url === 'https://api.elevenlabs.io/v1/speech-to-text') {
        assertEqual(
          new Headers(init.headers).get('xi-api-key'),
          'elevenlabs-blackbox-key',
          'STT auth'
        );
        if (!(init.body instanceof FormData)) throw new Error('Expected STT multipart FormData');
        assertEqual(init.body.get('model_id'), 'scribe_v2', 'existing shared STT model');
        const file = init.body.get('file');
        if (!(file instanceof Blob)) throw new Error('Expected binary voice file');
        deepStrictEqual(Buffer.from(await file.arrayBuffer()), bytes, 'exact OGG bytes reach STT');
        return Response.json({ text: '  Remember Paris tomorrow  ' });
      }
      throw new Error(`Unexpected outbound voice call: ${url}`);
    },
    async () => {
      const { processInboundAttachments } =
        await import('../../providers/smsSupervisor/inboundMedia');
      const result = await processInboundAttachments(
        [{ mediaId: MEDIA_ID, type: 'audio/ogg' }],
        'whatsapp-media-blackbox-user'
      );
      deepStrictEqual(result.imageBlocks, []);
      deepStrictEqual(result.filePointers, []);
      deepStrictEqual(result.noteLines, ['[Voice note transcript]: Remember Paris tomorrow']);
      deepStrictEqual(calls, [META_URL, MEDIA_URL, 'https://api.elevenlabs.io/v1/speech-to-text']);
    }
  );
}

async function testMedia_downloadFailuresSurface() {
  const { downloadWhatsAppMedia } = await import('../../providers/whatsappCloud');
  for (const failure of ['metadata', 'download', 'auth', 'size'] as const) {
    let calls = 0;
    await withMediaFetch(
      async (url, init) => {
        calls++;
        assertMetaAuthorization(init);
        if (url === META_URL) {
          if (failure === 'metadata')
            return Response.json({ error: { message: 'fixture denied' } }, { status: 401 });
          return mediaMetadata('image/png');
        }
        if (url === MEDIA_URL) {
          if (failure === 'download') return new Response('fixture denied', { status: 403 });
          return new Response(Buffer.alloc(5), { headers: { 'content-type': 'image/png' } });
        }
        throw new Error(`Unexpected failing media call: ${url}`);
      },
      async () => {
        if (failure === 'auth') delete process.env.WHATSAPP_ACCESS_TOKEN;
        await rejects(() => downloadWhatsAppMedia(MEDIA_ID, 4), `${failure} must fail explicitly`);
        assertEqual(
          calls,
          failure === 'auth' ? 0 : failure === 'metadata' ? 1 : 2,
          `${failure} request count`
        );
      }
    );
  }
}

export async function testInbound_mediaOnlyPersistsRoutesAndDeduplicates(prisma: PrismaClient) {
  const wa = uniqueSmsPhone().slice(1);
  const phone = `+${wa}`;
  const messageId = `wamid.media-${wa}`;
  const token = `whatsapp-media-route-${wa}`;
  const mediaId = `1723042199${wa}`;
  const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION || 'v21.0';
  const metadataUrl = `https://graph.facebook.com/${graphVersion}/${mediaId}`;
  let userId: string | undefined;
  const seed = await request(`${BASE_URL}/api/test/captures/cache`, {
    method: 'PUT',
    body: JSON.stringify({
      key: `call:${JSON.stringify([metadataUrl, 'GET', null])}`,
      value: {
        __ff_promise_result: true,
        value: {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: { message: 'offline media fixture' } }),
        },
      },
    }),
  });
  assertStatus(seed.status, 200, seed.data);
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: wa,
                  id: messageId,
                  type: 'image',
                  image: { id: mediaId, mime_type: 'image/png' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  try {
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await request(`${BASE_URL}/api/whatsapp/webhook`, {
        method: 'POST',
        headers: { 'X-Capture-Token': token },
        body: JSON.stringify(payload),
      });
      assertStatus(response.status, 200, response.data);
    }
    const user = await prisma.user.findFirst({ where: { phone } });
    if (!user) throw new Error('Media-only WhatsApp must provision the sender');
    userId = user.userId;
    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) throw new Error('Media-only WhatsApp must create a supervisor session');
    assertEqual(session.lastInboundSeq, 1, 'duplicate media does not advance the sequence');
    const turns = JSON.parse(String(session.messages)) as { role: string; content: string }[];
    deepStrictEqual(
      turns.filter((turn) => turn.role === 'user').map((turn) => turn.content),
      ['[1 attachment(s)]']
    );
    const mediaCalls = await waitFor(
      async () => {
        // Webhooks are registered before capture-token middleware; the unique
        // media URL identifies this turn in the shared capture stream.
        const captured = await request(`${BASE_URL}/api/test/captures`);
        assertStatus(captured.status, 200, captured.data);
        const matches = (captured.data as { captures: { url: string }[] }).captures.filter(
          (call) => call.url === metadataUrl
        );
        return matches.length > 0 ? matches : null;
      },
      1000,
      20
    );
    assertEqual(
      mediaCalls.length,
      1,
      'normalized media reaches supervisor downloader exactly once'
    );
  } finally {
    if (userId) await cleanupAgentScopedUser(prisma, userId);
  }
}

export const mediaProcessingTests = [
  {
    name: 'media processing -- exact image bytes and FilePointer',
    fn: testMedia_imageBytesAndFilePointer,
  },
  {
    name: 'media processing -- exact voice bytes and transcript',
    fn: testMedia_voiceBytesAndTranscript,
  },
  {
    name: 'media processing -- metadata, download, auth, and size failures',
    fn: testMedia_downloadFailuresSurface,
  },
];
