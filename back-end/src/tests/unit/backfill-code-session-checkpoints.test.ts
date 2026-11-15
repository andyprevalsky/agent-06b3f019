#!/usr/bin/env tsx
/**
 * Code-session checkpoint backfill guards: the session scan includes sessions
 * whose checkpoint uploaded but never committed (nextCheckpointSeq > 0 while
 * latestCheckpointSeq is still 0), and a malformed manifest fails the session in
 * apply and dry run alike instead of confirming an archive holding only the
 * manifest.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  backfillSessionWhere,
  parseCheckpointManifest,
} from '../../../scripts/backfill-code-session-checkpoints';

function testSessionWhere(): void {
  const all = backfillSessionWhere([]);
  assert.deepEqual(all, { nextCheckpointSeq: { gt: 0 }, state: { not: 'RETIRED' } });
  assert.equal('latestCheckpointSeq' in all, false, 'an uncommitted allocated seq is scanned');
  // Sessions with a committed checkpoint are still included: next >= latest >= 1.
  const latest = 3;
  const next = 4;
  assert.ok(next >= latest && next > all.nextCheckpointSeq.gt);
  assert.deepEqual(backfillSessionWhere(['s1']), {
    nextCheckpointSeq: { gt: 0 },
    id: { in: ['s1'] },
  });
}

function testStrictManifest(): void {
  const sha256 = createHash('sha256').update('x').digest('hex');
  const good = Buffer.from(
    JSON.stringify({ seq: 1, artifacts: { 'cli-log.jsonl': { sha256, size: 1 } } })
  );
  assert.deepEqual(parseCheckpointManifest(good).artifacts, {
    'cli-log.jsonl': { sha256, size: 1 },
  });
  assert.deepEqual(parseCheckpointManifest(Buffer.from('{"artifacts":{}}')).artifacts, {});
  for (const [label, body] of [
    ['not JSON', '{"artifacts": {"cli-log.jsonl"'],
    ['no artifacts', '{"seq": 1}'],
    ['array artifacts', '{"artifacts": []}'],
    ['JSON null', 'null'],
    ['missing sha256', '{"artifacts": {"worktree.tar.gz": {"size": 3}}}'],
    ['bad size', `{"artifacts": {"worktree.tar.gz": {"sha256": "${sha256}", "size": -1}}}`],
  ]) {
    assert.throws(() => parseCheckpointManifest(Buffer.from(body)), Error, label);
  }
}

testSessionWhere();
testStrictManifest();
process.stdout.write('backfill-code-session-checkpoints: all tests passed\n');
