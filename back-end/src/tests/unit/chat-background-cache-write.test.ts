#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCacheWriteInBackground } from '../../providers/chat/backgroundCacheWrite';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function run(): Promise<void> {
  const pending = deferred();
  let stored = false;
  let failed: unknown;

  const lifecycle = async (): Promise<string> => {
    runCacheWriteInBackground(
      () => pending.promise,
      () => {
        stored = true;
      },
      (error) => {
        failed = error;
      }
    );
    return 'response complete';
  };

  assert.equal(await lifecycle(), 'response complete');
  assert.equal(stored, false, 'a pending cache write must not delay the response lifecycle');
  assert.equal(failed, undefined);
  pending.resolve();
  await pending.promise;
  await Promise.resolve();
  assert.equal(stored, true);

  const rejected = deferred();
  runCacheWriteInBackground(
    () => rejected.promise,
    () => {
      throw new Error('rejected writes must not report success');
    },
    (error) => {
      failed = error;
    }
  );
  const rejection = new Error('cache unavailable');
  rejected.reject(rejection);
  await rejected.promise.catch(() => undefined);
  await Promise.resolve();
  assert.equal(failed, rejection, 'background rejection must be observed without escaping');

  for (const file of ['routerLlm.ts', 'chatTools.ts', 'generatorLlm.ts']) {
    const source = readFileSync(join(process.cwd(), 'src', 'providers', 'chat', file), 'utf8');
    assert.match(
      source,
      /runCacheWriteInBackground\(/,
      `${file} must schedule cache writes through the behavior-tested nonblocking boundary`
    );
  }

  process.stdout.write('PASS chat cache writes cannot gate response completion\n');
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
