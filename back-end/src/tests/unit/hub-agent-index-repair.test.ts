/**
 * Hub agent-run index repair must stay bundle-free under the writer lock, and
 * the out-of-lock backfill must complete correctly over legacy archives.
 * Production 2026-10-08: an in-lock whole-archive rebuild wedged every write;
 * see docs/rca/cases/2026-10-09-hub-index-repair-scanned-archive-inside-writer-lock.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHubAgentIdIndex } from '../../providers/benchmarkHubLookup';
import {
  completedHubAgentBackfill,
  parseHubAgentRunIndex,
  parseHubRunBundle,
  salvagedHubAgentRunIndex,
  type HubRunSummary,
} from '../../providers/benchmarkHubStore';

const run: HubRunSummary = {
  run_id: 'run-root',
  timestamp: '2026-09-01T00:00:00Z',
  suite: null,
  source: null,
  live: false,
  uploaded_at: '2026-09-01T00:00:05Z',
  tasks: [],
};

test('mutation repair re-derives catalog roots and keeps live child mappings without bundles', () => {
  const salvaged = salvagedHubAgentRunIndex(
    {
      revision: 72,
      complete: true,
      agents: new Map([
        ['reused-root', 'older-run'],
        ['older-child', 'older-run'],
        ['deleted-agent', 'deleted-run'],
      ]),
    },
    [
      {
        run_id: 'newer-run',
        uploaded_at: '2026-10-08T22:49:30Z',
        tasks: [{ agent_id: 'reused-root' }],
      },
      {
        run_id: 'older-run',
        uploaded_at: '2026-10-08T22:40:00Z',
        tasks: [{ agent_id: 'reused-root' }],
      },
      { run_id: 'error-run', uploaded_at: '2026-07-16T01:38:37Z', tasks: [] },
    ],
    73
  );
  assert.equal(salvaged.revision, 73);
  assert.equal(salvaged.repairedRevision, 73);
  assert.equal(salvaged.complete, false);
  assert.deepEqual(Object.fromEntries(salvaged.agents), {
    'reused-root': 'newer-run',
    'older-child': 'older-run',
  });
});

test('mutation repair of an unparseable index trusts only the catalog', () => {
  assert.deepEqual(
    salvagedHubAgentRunIndex(null, [{ run_id: 'run-1', tasks: [{ agent_id: 'root-1' }] }], 9),
    { revision: 9, complete: false, repairedRevision: 9, agents: new Map([['root-1', 'run-1']]) }
  );
});

test('a backfill scanned before the latest salvage cannot publish completion', () => {
  const current = {
    revision: 75,
    complete: false,
    repairedRevision: 73,
    agents: new Map([['root', 'run-1']]),
  };
  const valid = [{ run_id: 'run-1' }];
  assert.equal(completedHubAgentBackfill(current, new Map(), valid, 72).complete, false);
  assert.equal(completedHubAgentBackfill(current, new Map(), valid).complete, false);
  const fresh = completedHubAgentBackfill(current, new Map(), valid, 74);
  assert.equal(fresh.complete, true);
  assert.equal(fresh.repairedRevision, 73);
  assert.equal(
    completedHubAgentBackfill({ ...current, repairedRevision: undefined }, new Map(), valid)
      .complete,
    true
  );
});

test('the salvage revision round-trips and is validated', () => {
  assert.deepEqual(
    parseHubAgentRunIndex(
      '{"version":1,"revision":4,"complete":false,"repaired_revision":3,"agents":{}}'
    ),
    { revision: 4, complete: false, repairedRevision: 3, agents: new Map() }
  );
  assert.throws(
    () =>
      parseHubAgentRunIndex(
        '{"version":1,"revision":4,"complete":false,"repaired_revision":-1,"agents":{}}'
      ),
    /Invalid Benchmark Hub agent-run index/
  );
});

test('legacy completion replaces a stale salvaged mapping with the newest scanned upload', () => {
  const merged = completedHubAgentBackfill(
    {
      revision: 9,
      complete: false,
      repairedRevision: 8,
      agents: new Map([
        ['reused-child', 'older-run'],
        ['concurrent-child', 'concurrent-run'],
      ]),
    },
    new Map([
      ['reused-child', 'newer-run'],
      ['concurrent-child', 'newer-run'],
    ]),
    [
      { run_id: 'concurrent-run', uploaded_at: '2026-10-09T03:00:00Z' },
      { run_id: 'newer-run', uploaded_at: '2026-10-08T22:49:30Z' },
      { run_id: 'older-run', uploaded_at: '2026-10-08T22:40:00Z' },
    ],
    9
  );
  assert.equal(merged.complete, true);
  assert.equal(merged.agents.get('reused-child'), 'newer-run');
  assert.equal(merged.agents.get('concurrent-child'), 'concurrent-run');
});

test('only a zero-task catalog summary admits a legacy record without a task list', () => {
  const legacy = '{"error":"dispatch failed","run_id":"hub-1","code":1}';
  assert.deepEqual(parseHubRunBundle(legacy, { tasks: [] }), {
    error: 'dispatch failed',
    run_id: 'hub-1',
    code: 1,
    tasks: [],
  });
  assert.deepEqual(parseHubRunBundle('{"tasks":null}', { tasks: [] }), { tasks: [] });
  assert.throws(
    () => parseHubRunBundle(legacy, { tasks: [{ agent_id: 'root' }] }),
    /Invalid Benchmark Hub run bundle/
  );
  assert.throws(() => parseHubRunBundle('[]', { tasks: [] }), /Invalid Benchmark Hub run bundle/);
  assert.throws(() => parseHubRunBundle('{"run_id":', { tasks: [] }), SyntaxError);
});

test('legacy scan maps a reused agent id to its newest upload, not newest timestamp', async () => {
  const reuploaded = { ...run, run_id: 'reuploaded-run', timestamp: '2026-09-01T00:00:00Z' };
  const newerTimestamp = {
    ...run,
    run_id: 'earlier-upload',
    timestamp: '2026-09-02T00:00:00Z',
  };
  const scanned = await buildHubAgentIdIndex(
    [
      { ...newerTimestamp, uploaded_at: '2026-09-02T00:00:05Z' },
      { ...reuploaded, uploaded_at: '2026-09-03T00:00:05Z' },
    ],
    async () => ({ tasks: [{ agent_id: 'reused-root' }] }),
    new Map([['seeded-only', 'earlier-upload']])
  );
  assert.equal(scanned.get('reused-root'), 'reuploaded-run');
  assert.equal(scanned.get('seeded-only'), 'earlier-upload');
});
