#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listArchivedObjects, listArchivedObjectsStrict } from '../../providers/traceArchive';
import { listArchiveBundleIdsStrict } from '../../providers/traceArchiveAudit';
import { createTestHarness, withEnv } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('trace-archive listing unit tests');

async function main(): Promise<void> {
  await test(
    'strict terminal listing surfaces storage failures while best-effort listing stays soft',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'local',
        TRACE_ARCHIVE_LOCAL_DIR: undefined,
      },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-archive-list-error-'));
        process.env.TRACE_ARCHIVE_LOCAL_DIR = dir;
        const bundlePath = path.join(dir, 'trace-archive', 'agent-list-error');
        fs.mkdirSync(bundlePath, { recursive: true });
        const originalReadDir = fs.readdirSync;
        fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
          if (String(target).includes('agent-list-error')) {
            throw new Error('simulated archive list transport error');
          }
          return originalReadDir(target, options as never);
        }) as typeof fs.readdirSync;
        try {
          await assert.rejects(
            listArchivedObjectsStrict('agent-list-error'),
            /simulated archive list transport error/
          );
          assert.deepStrictEqual(await listArchivedObjects('agent-list-error'), []);
        } finally {
          fs.readdirSync = originalReadDir;
        }
      }
    )
  );
  await test(
    'strict R2 root enumeration rejects missing bucket configuration',
    withEnv(
      {
        TRACE_ARCHIVE_ENABLED: '1',
        TRACE_ARCHIVE_BACKEND: 'r2',
        R2_BUCKET_TRACE_ARCHIVE: undefined,
      },
      async () => {
        await assert.rejects(listArchiveBundleIdsStrict(), /R2 trace archive is not configured/);
      }
    )
  );
}

main()
  .then(finish)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
