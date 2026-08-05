#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALLER_OWNED_RUNTIME_ENV_KEYS,
  captureCallerOwnedRuntimeEnv,
  restoreCallerOwnedRuntimeEnv,
} from '../../providers/loadDotenvWithCallerOverrides';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function main(): void {
  assert.deepEqual(
    [...CALLER_OWNED_RUNTIME_ENV_KEYS],
    ['DATABASE_URL', 'DIRECT_URL', 'PORT', 'TEMPORAL_TASK_QUEUE'],
    'isolated stacks depend on these keys surviving dotenv override'
  );

  {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://stack/victoria',
      DIRECT_URL: 'postgresql://stack/victoria',
      PORT: '3201',
      TEMPORAL_TASK_QUEUE: 'navi-agent-tasks-isolated',
      OTHER: 'keep-me',
    };
    const preserved = captureCallerOwnedRuntimeEnv(env);
    assert.equal(preserved.get('PORT'), '3201');
    assert.equal(preserved.get('DATABASE_URL'), 'postgresql://stack/victoria');
    assert.equal(preserved.get('TEMPORAL_TASK_QUEUE'), 'navi-agent-tasks-isolated');

    // Simulate dotenv.config({ override: true }) clobbering from back-end/.env.
    env.DATABASE_URL = 'postgresql://dotenv/victoria';
    env.DIRECT_URL = 'postgresql://dotenv/victoria';
    env.PORT = '3001';
    env.TEMPORAL_TASK_QUEUE = 'navi-agent-tasks';
    restoreCallerOwnedRuntimeEnv(env, preserved);

    assert.equal(env.PORT, '3201');
    assert.equal(env.DATABASE_URL, 'postgresql://stack/victoria');
    assert.equal(env.DIRECT_URL, 'postgresql://stack/victoria');
    assert.equal(env.TEMPORAL_TASK_QUEUE, 'navi-agent-tasks-isolated');
    assert.equal(env.OTHER, 'keep-me');
  }

  {
    const env: NodeJS.ProcessEnv = { PORT: '', DATABASE_URL: undefined };
    const preserved = captureCallerOwnedRuntimeEnv(env);
    assert.equal(preserved.size, 0);
  }

  const bootstrapSource = fs.readFileSync(
    path.resolve(testDirectory, '../../bootstrap.ts'),
    'utf8'
  );
  const paymentSeedSource = fs.readFileSync(
    path.resolve(testDirectory, '../../../scripts/setup-benchmark-payment.ts'),
    'utf8'
  );
  assert.match(
    bootstrapSource,
    /loadDotenvWithCallerOverrides\(\)/,
    'bootstrap must preserve isolated PORT/DATABASE_URL across dotenv override'
  );
  assert.match(
    paymentSeedSource,
    /loadDotenvWithCallerOverrides\(\)/,
    'payment seed must preserve isolated DATABASE_URL across dotenv override'
  );
  assert.doesNotMatch(
    bootstrapSource,
    /dotenv\.config\(\s*\{\s*override:\s*true/,
    'bootstrap must not call dotenv override directly (clobbers PORT)'
  );
  assert.doesNotMatch(
    paymentSeedSource,
    /dotenv\.config\(\s*\{\s*override:\s*true/,
    'payment seed must not call dotenv override directly'
  );

  console.log('load-dotenv-with-caller-overrides: all assertions passed');
}

main();
