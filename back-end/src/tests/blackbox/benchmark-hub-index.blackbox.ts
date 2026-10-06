#!/usr/bin/env tsx

/** Benchmark Hub background indexing must yield to live backend work. */

import {
  __resetHubResolutionCachesForTest,
  buildHubAgentIdIndex,
  loadCompactHubAgentIndex,
  peekHubResolutionForTest,
} from '../../providers/benchmarkHubLookup';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  __resetHubResolutionCachesForTest();
  const partial = await loadCompactHubAgentIndex(async () => ({
    revision: 7,
    complete: false,
    agents: new Map([['known-agent', 'known-run']]),
  }));
  assert(partial.kind === 'legacy', 'incomplete index must keep backfill pending');
  assert(
    peekHubResolutionForTest('known-agent').childRunId === 'known-run',
    'incomplete index must still serve its known agent mappings'
  );
  __resetHubResolutionCachesForTest();

  let previousLoaderYielded = true;
  let loaderCalls = 0;
  const runs = Array.from({ length: 8 }, (_, index) => ({
    run_id: `run-${index}`,
    timestamp: '2026-09-05T00:00:00Z',
    suite: null,
    source: null,
    live: false,
    uploaded_at: '2026-09-05T00:00:00Z',
    tasks: [],
  }));

  const index = await buildHubAgentIdIndex(runs, async (runId) => {
    assert(
      previousLoaderYielded,
      `background Hub indexing did not yield before loader ${loaderCalls + 1}`
    );
    previousLoaderYielded = false;
    loaderCalls += 1;
    setImmediate(() => {
      previousLoaderYielded = true;
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    return {
      tasks: [{ agent_id: `root-${runId}`, logs: { tree: {} } }],
    };
  });

  assert(loaderCalls === runs.length, 'legacy Hub backfill skipped a run bundle');
  assert(index.get('root-run-7') === 'run-7', 'background Hub index dropped an agent id');
  process.stdout.write('benchmark-hub-index blackbox: ok\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
