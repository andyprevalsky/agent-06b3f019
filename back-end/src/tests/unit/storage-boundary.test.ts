#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import {
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  getSignedUrl,
  processUploadedFile,
  putStorageObject,
  validateTotalSize,
  type FilePointer,
} from '../../providers/storage';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

async function main(): Promise<void> {
  await test('processUploadedFile rejects oversized files before storage I/O', async () => {
    const oversized = Buffer.alloc(MAX_FILE_SIZE + 1);
    await assert.rejects(
      processUploadedFile('user-1', oversized, 'too-large.txt', 'text/plain'),
      /File size exceeds maximum/
    );
  });

  await test('processUploadedFile reports missing storage env loudly', async () => {
    const oldUrl = process.env.SUPABASE_URL;
    const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      await assert.rejects(
        processUploadedFile('user-1', Buffer.from('small'), 'small.txt', 'text/plain'),
        /Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/
      );
    } finally {
      if (oldUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
    }
  });

  await test('processUploadedFile works when native WebSocket is unavailable', async () => {
    const oldUrl = process.env.SUPABASE_URL;
    const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const oldFetch = globalThis.fetch;
    const globalWithWebSocket = globalThis as typeof globalThis & { WebSocket?: unknown };
    const oldWebSocket = globalWithWebSocket.WebSocket;
    const requests: { url: string; method: string | undefined }[] = [];
    try {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy';
      globalWithWebSocket.WebSocket = undefined;
      globalThis.fetch = (async (input, init) => {
        requests.push({ url: String(input), method: init?.method });
        return new Response(JSON.stringify({ Key: 'attachments/user-1/fake_small.txt' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const pointer = await processUploadedFile(
        'user-1',
        Buffer.from('small'),
        'small.txt',
        'text/plain'
      );

      assert.equal(pointer.original_filename, 'small.txt');
      assert.equal(pointer.mime_type, 'text/plain');
      assert.equal(requests.length, 1);
      assert.match(
        requests[0].url,
        /https:\/\/example\.supabase\.co\/storage\/v1\/object\/attachments\/user-1\//
      );
      assert.equal(requests[0].method, 'POST');
    } finally {
      if (oldUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
      globalThis.fetch = oldFetch;
      if (oldWebSocket === undefined) delete globalWithWebSocket.WebSocket;
      else globalWithWebSocket.WebSocket = oldWebSocket;
    }
  });

  await test('a stored upload is served back through its signed URL', async () => {
    // Hermetic twin of the live report-bug-storage-live probe: the real storage
    // client stores, signs and reads back the same bytes from a fake Storage API.
    const oldUrl = process.env.SUPABASE_URL;
    const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const oldFetch = globalThis.fetch;
    const objects = new Map<string, Buffer>();
    const signed: { path: string; expiresIn: unknown }[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    try {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy';
      globalThis.fetch = (async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const upload = /^\/storage\/v1\/object\/attachments\/(.+)$/.exec(url.pathname);
        if (upload && init?.method === 'POST') {
          const body = init.body;
          const bytes =
            body instanceof Blob
              ? Buffer.from(await body.arrayBuffer())
              : body instanceof FormData
                ? Buffer.from(await (body.get('') as Blob).arrayBuffer())
                : Buffer.from(body as Uint8Array);
          objects.set(decodeURIComponent(upload[1]), bytes);
          return json({ Key: `attachments/${upload[1]}` });
        }
        const sign = /^\/storage\/v1\/object\/sign\/attachments\/(.+)$/.exec(url.pathname);
        if (sign && init?.method === 'POST') {
          const path = decodeURIComponent(sign[1]);
          signed.push({ path, expiresIn: JSON.parse(String(init.body)).expiresIn });
          if (!objects.has(path))
            return json(
              { statusCode: '404', error: 'not_found', message: 'Object not found' },
              400
            );
          return json({ signedURL: `/object/sign/attachments/${sign[1]}?token=t` });
        }
        if (sign && url.searchParams.get('token') === 't') {
          const stored = objects.get(decodeURIComponent(sign[1]));
          return stored ? new Response(stored) : json({ error: 'not_found' }, 404);
        }
        throw new Error(`unexpected storage request ${init?.method ?? 'GET'} ${url.href}`);
      }) as typeof fetch;

      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const pointer = await processUploadedFile('user-1', png, 'live view.png', 'image/png');
      const signedUrl = await getSignedUrl(pointer.storage_path, 604_800);
      assert.deepEqual(signed, [{ path: pointer.storage_path, expiresIn: 604_800 }]);
      const served = await fetch(signedUrl);
      assert.equal(served.status, 200);
      assert.ok(
        Buffer.from(await served.arrayBuffer()).equals(png),
        'signed URL served other bytes'
      );
      await assert.rejects(
        getSignedUrl('user-1/missing.png', 60),
        /Failed to generate signed URL: Object not found/
      );
    } finally {
      if (oldUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
      globalThis.fetch = oldFetch;
    }
  });

  await test('putStorageObject treats an existing write-once object as stored', async () => {
    // Supabase answers a duplicate upload with HTTP 400 and statusCode "409" in the body
    // (a re-displayed page with the same content hash: display dedupe, not a failure).
    const oldUrl = process.env.SUPABASE_URL;
    const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const oldFetch = globalThis.fetch;
    let calls = 0;
    try {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy';
      globalThis.fetch = (async () => {
        calls += 1;
        const duplicate = calls === 1;
        return new Response(
          JSON.stringify({
            statusCode: duplicate ? '409' : '403',
            error: duplicate ? 'Duplicate' : 'Unauthorized',
            message: duplicate ? 'The resource already exists' : 'new row violates policy',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }) as typeof fetch;

      await putStorageObject('user-1/display/abc.html', Buffer.from('<p>x</p>'), 'text/html');
      await assert.rejects(
        putStorageObject('user-1/display/def.html', Buffer.from('<p>y</p>'), 'text/html'),
        /violates policy/
      );
    } finally {
      if (oldUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
      globalThis.fetch = oldFetch;
    }
  });

  await test('validateTotalSize accepts boundary and rejects oversized totals', () => {
    const atLimit: FilePointer[] = [
      {
        id: 'file-1',
        storage_path: 'user-1/file-1',
        original_filename: 'at-limit.bin',
        mime_type: 'application/octet-stream',
        size_bytes: MAX_TOTAL_SIZE,
        created_at: '2026-07-03T00:00:00.000Z',
      },
    ];
    validateTotalSize(atLimit);

    const overLimit = [{ ...atLimit[0], size_bytes: MAX_TOTAL_SIZE + 1 }];
    assert.throws(() => validateTotalSize(overLimit), /Total attachment size exceeds maximum/);
  });
}

void main().then(() => {
  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`\n${passed}/${passed} storage boundary tests passed`);
});
