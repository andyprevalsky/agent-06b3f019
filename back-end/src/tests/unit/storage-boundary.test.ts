#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import {
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  processUploadedFile,
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

  console.log(`\n${passed}/4 storage boundary tests passed`);
});
