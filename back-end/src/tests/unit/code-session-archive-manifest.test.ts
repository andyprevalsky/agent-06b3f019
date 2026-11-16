#!/usr/bin/env tsx
/**
 * A malformed checkpoint manifest can never confirm an R2 mirror: confirmation
 * gates the Supabase prune/retire deletes (providers/codeSessions/archiveMirror.ts).
 */
import assert from 'node:assert/strict';
import { manifestArtifacts } from '../../providers/codeSessions/archiveMirror';

function main(): void {
  const sha = 'a'.repeat(64);
  assert.deepEqual(
    manifestArtifacts(
      Buffer.from(JSON.stringify({ artifacts: { 'cli-log.jsonl': { sha256: sha, size: 3 } } }))
    ),
    [['cli-log.jsonl', { sha256: sha, size: 3 }]]
  );
  for (const bad of [
    'not json',
    '[]',
    '{}',
    '{"artifacts":[]}',
    '{"artifacts":{"x":{"size":1}}}',
    `{"artifacts":{"x":{"sha256":"${sha}","size":-1}}}`,
  ]) {
    assert.throws(
      () => manifestArtifacts(Buffer.from(bad)),
      `malformed manifest must throw: ${bad}`
    );
  }
  process.stdout.write('code-session-archive-manifest: all checks passed\n');
}

main();
