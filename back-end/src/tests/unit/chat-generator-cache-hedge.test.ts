#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const generatorSource = await readFile(
    new URL('../../providers/chat/generatorLlm.ts', import.meta.url),
    'utf8'
  );
  const hedgeSource = await readFile(
    new URL('../../providers/chat/generatorCacheStream.ts', import.meta.url),
    'utf8'
  );

  assert.match(
    generatorSource,
    /createGeneratorCacheStream/,
    'the generator must use the Fast Mode cache stream'
  );
  assert.match(
    hedgeSource,
    /delayedCacheStreamHedge/,
    'the generator must go through the shared cache/live hedge'
  );
  assert.doesNotMatch(
    generatorSource,
    /cacheGet\(/,
    'generator startup must stay on the shared cache-stream helper'
  );
  assert.match(
    hedgeSource,
    /awaitCacheFirst:\s*true/,
    'Fast Mode read must wait for cache before starting Cerebras'
  );
  assert.match(
    hedgeSource,
    /hangTimeoutMs:\s*GENERATOR_CACHE_HANG_MS/,
    'a hung cache lookup must still fall through to live'
  );
  assert.doesNotMatch(
    generatorSource,
    /await cacheSet\(/,
    'writing an optional response cache must not gate lifecycle completion'
  );

  process.stdout.write('chat generator cache hedge test passed\n');
}

void main();
