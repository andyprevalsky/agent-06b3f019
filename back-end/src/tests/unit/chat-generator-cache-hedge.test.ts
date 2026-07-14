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
    'the generator must use the bounded cache/live race'
  );
  assert.match(
    hedgeSource,
    /delayedCacheStreamHedge/,
    'the generator must race the optional remote cache against the live provider stream'
  );
  assert.doesNotMatch(
    generatorSource,
    /cacheGet\(/,
    'a remote cache lookup must never block generator provider startup'
  );
  assert.match(
    hedgeSource,
    /const GENERATOR_CACHE_GRACE_MS = 25;/,
    'the cache head start must stay bounded to 25ms'
  );
  assert.match(
    hedgeSource,
    /graceMs:\s*GENERATOR_CACHE_GRACE_MS/,
    'the cache should receive only a small head start before live generation begins'
  );
  assert.doesNotMatch(
    generatorSource,
    /await cacheSet\(/,
    'writing an optional response cache must not gate lifecycle completion'
  );

  process.stdout.write('chat generator cache hedge test passed\n');
}

void main();
