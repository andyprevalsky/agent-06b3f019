#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { streamToBuffer } from '../../providers/traceArchiveBody';
import { withTraceArchiveRequestTimeout } from '../../providers/traceArchiveRequest';
import { createTestHarness, withEnv } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('trace-archive request deadline unit tests');

async function main(): Promise<void> {
  await test(
    'R2 request timeout aborts a hung SDK operation',
    withEnv({ TRACE_ARCHIVE_R2_REQUEST_TIMEOUT_MS: '20' }, async () => {
      await assert.rejects(
        withTraceArchiveRequestTimeout(
          (signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted by test')));
            })
        ),
        /timed out after 20ms/
      );
      assert.strictEqual(await withTraceArchiveRequestTimeout(async () => 'ok'), 'ok');
    })
  );
  await test(
    'R2 request timeout covers stalled response body consumption',
    withEnv({ TRACE_ARCHIVE_R2_REQUEST_TIMEOUT_MS: '20' }, async () => {
      let destroyed = false;
      const body = {
        transformToByteArray: () => new Promise<Uint8Array>(() => undefined),
        destroy: () => {
          destroyed = true;
        },
      };
      await assert.rejects(
        withTraceArchiveRequestTimeout((signal) => streamToBuffer(body, signal)),
        /timed out after 20ms/
      );
      assert.strictEqual(destroyed, true);
    })
  );
}

main()
  .then(finish)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
