#!/usr/bin/env tsx

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  prepareAgentStartArchive,
  prepareAgentStartArchiveTask,
} from '../../providers/traceArchiveLifecycle';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('trace archive start snapshot unit tests');

async function main(): Promise<void> {
  await test('disabled trace archive skips fixture collection entirely', async () => {
    const lifecycle = readFileSync(
      join(process.cwd(), 'src', 'providers', 'traceArchiveLifecycle.ts'),
      'utf8'
    );
    const start = lifecycle.indexOf('export async function prepareAgentStartArchive(');
    const end = lifecycle.indexOf('\nasync function waitForActiveFinalize', start);
    const implementation = lifecycle.slice(start, end);
    assert.match(
      implementation,
      /if \(!archiveEnabled\(\)\) return null;/,
      'disabled archives must return before opening a fixture snapshot transaction'
    );

    const previous = process.env.TRACE_ARCHIVE_ENABLED;
    process.env.TRACE_ARCHIVE_ENABLED = '0';
    try {
      const prepared = await prepareAgentStartArchive('not-a-real-agent');
      assert.strictEqual(prepared, null);
    } finally {
      if (previous === undefined) delete process.env.TRACE_ARCHIVE_ENABLED;
      else process.env.TRACE_ARCHIVE_ENABLED = previous;
    }
  });

  await test('launch readiness does not wait for the full fixture collection', async () => {
    const events: string[] = [];
    let finishCollection: (() => void) | undefined;
    const collectionGate = new Promise<void>((resolve) => {
      finishCollection = resolve;
    });

    const prepared = await prepareAgentStartArchiveTask({
      collect: async (markSnapshotReady) => {
        events.push('snapshot-ready');
        markSnapshotReady();
        await collectionGate;
        events.push('fixture-collected');
        return { id: 'fixture' };
      },
      archive: async () => {
        events.push('fixture-archived');
      },
      onError: (error) => {
        throw error;
      },
    });

    assert.strictEqual(typeof prepared, 'function');
    assert.deepStrictEqual(events, ['snapshot-ready']);

    const archive = prepared?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(events, ['snapshot-ready']);
    finishCollection?.();
    await archive;
    assert.deepStrictEqual(events, ['snapshot-ready', 'fixture-collected', 'fixture-archived']);
  });

  await test('snapshot acquisition failure returns no launch archive task', async () => {
    const errors: unknown[] = [];
    const expected = new Error('snapshot acquisition failed');

    const prepared = await prepareAgentStartArchiveTask({
      collect: async () => {
        throw expected;
      },
      archive: async () => undefined,
      onError: (error) => errors.push(error),
    });

    assert.strictEqual(prepared, null);
    assert.deepStrictEqual(errors, [expected]);
  });

  await test('post-readiness collection failure is handled without an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const unhandled: unknown[] = [];
    const expected = new Error('fixture collection failed after readiness');
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const prepared = await prepareAgentStartArchiveTask({
        collect: async (markSnapshotReady) => {
          markSnapshotReady();
          throw expected;
        },
        archive: async () => undefined,
        onError: (error) => errors.push(error),
      });

      assert.strictEqual(typeof prepared, 'function');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, []);
      await prepared?.();
      assert.deepStrictEqual(errors, [expected]);
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  finish();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
