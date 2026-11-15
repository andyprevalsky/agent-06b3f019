#!/usr/bin/env tsx

import assert from 'node:assert';
import 'dotenv/config';

import { hedgeStreams } from '../../providers/rose/hedgedStream';

interface Chunk {
  kind: string;
  text?: string;
}

const isContent = (chunk: Chunk): boolean => chunk.kind === 'content';
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeBranch(): {
  push: (chunk: Chunk) => void;
  end: () => void;
  fail: (error: unknown) => void;
  started: () => boolean;
  aborted: () => boolean;
  produce: (signal: AbortSignal) => AsyncIterable<Chunk>;
} {
  const queue: Chunk[] = [];
  let done = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  let signalRef: AbortSignal | null = null;
  const notify = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push: (chunk) => {
      queue.push(chunk);
      notify();
    },
    end: () => {
      done = true;
      notify();
    },
    fail: (error) => {
      failure = error;
      notify();
    },
    started: () => signalRef !== null,
    aborted: () => signalRef?.aborted ?? false,
    produce(signal) {
      signalRef = signal;
      return (async function* () {
        for (;;) {
          if (queue.length > 0) {
            const next = queue.shift();
            if (next !== undefined) yield next;
            continue;
          }
          if (failure !== null) throw failure;
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })();
    },
  };
}

function harness(options: { hedgeOnPrimaryFailure?: boolean } = {}): {
  primary: ReturnType<typeof makeBranch>;
  hedge: ReturnType<typeof makeBranch>;
  fireHedge: () => void;
  winners: string[];
  branchFailures: Array<[string, unknown]>;
  losers: Array<[string, readonly Chunk[]]>;
  drained: () => Promise<void>;
  collect: () => Promise<{ items: Chunk[]; error: unknown }>;
} {
  const primary = makeBranch();
  const hedge = makeBranch();
  let fire: () => void = () => undefined;
  const winners: string[] = [];
  const branchFailures: Array<[string, unknown]> = [];
  const losers: Array<[string, readonly Chunk[]]> = [];
  let drainedPromise: Promise<void> | null = null;
  const stream = hedgeStreams<Chunk>({
    primary: { name: 'cerebras', produce: primary.produce },
    hedge: { name: 'waterfall', produce: hedge.produce },
    hedgeAfter: () =>
      new Promise<void>((resolve) => {
        fire = resolve;
      }),
    isContent,
    onWinner: (name) => winners.push(name),
    onBranchFailure: (name, error) => branchFailures.push([name, error]),
    hedgeOnPrimaryFailure: options.hedgeOnPrimaryFailure,
    onLoser: (name, items) => losers.push([name, items]),
    onDrained: (drained) => {
      drainedPromise = drained;
    },
  });
  const collect = async (): Promise<{ items: Chunk[]; error: unknown }> => {
    const items: Chunk[] = [];
    try {
      for await (const item of stream) items.push(item);
      return { items, error: null };
    } catch (error) {
      return { items, error };
    }
  };
  const drained = async (): Promise<void> => {
    assert(drainedPromise, 'the race reports its drain once it settles');
    await drainedPromise;
  };
  return {
    primary,
    hedge,
    fireHedge: () => fire(),
    winners,
    branchFailures,
    losers,
    drained,
    collect,
  };
}

async function main(): Promise<void> {
  // 1. Primary produces content promptly: hedge never starts, primary wins.
  {
    const h = harness();
    const result = h.collect();
    h.primary.push({ kind: 'content', text: 'fast' });
    h.primary.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'content', text: 'fast' }]);
    assert.deepEqual(h.winners, ['cerebras']);
    assert.equal(h.hedge.started(), false, 'hedge must not start when primary is fast');
  }

  // 2. Primary silent, hedge fires and wins; primary branch is aborted.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    h.fireHedge();
    await tick();
    assert.equal(h.hedge.started(), true, 'hedge must start after the delay fires');
    h.hedge.push({ kind: 'usage' }); // pre-content chunks buffer and replay in order
    h.hedge.push({ kind: 'content', text: 'hedged' });
    h.hedge.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'usage' }, { kind: 'content', text: 'hedged' }]);
    assert.deepEqual(h.winners, ['waterfall']);
    await tick();
    assert.equal(h.primary.aborted(), true, 'losing primary must be aborted');
  }

  // 3. Primary latches after the hedge started but before hedge content: primary wins.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    h.fireHedge();
    await tick();
    h.hedge.push({ kind: 'usage' });
    h.primary.push({ kind: 'content', text: 'late-but-first' });
    h.primary.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'content', text: 'late-but-first' }]);
    assert.deepEqual(h.winners, ['cerebras']);
    await tick();
    assert.equal(h.hedge.aborted(), true, 'losing hedge must be aborted');
  }

  // 4. Primary fails pre-latch BEFORE the hedge starts: the failure surfaces
  //    immediately (fast provider errors belong to the caller's classified
  //    fallover chain — e.g. quota -> same-model GLM), hedge never starts.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    const fastError = new Error('cerebras 402 quota');
    h.primary.fail(fastError);
    const { items, error } = await result;
    assert.deepEqual(items, []);
    assert.equal(error, fastError, 'pre-hedge primary failure must surface unchanged');
    assert.equal(h.hedge.started(), false, 'a pre-hedge failure must not arm the hedge');
    // A hedge timer firing AFTER the race settled must not launch an orphaned
    // provider request.
    h.fireHedge();
    await tick();
    assert.equal(h.hedge.started(), false, 'late hedge timer must not start after settle');
  }

  // 4b. Primary fails AFTER the hedge started: the race plays out, hedge wins.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    h.fireHedge();
    await tick();
    const midRaceError = new Error('cerebras died mid-race');
    h.primary.fail(midRaceError);
    await tick();
    h.hedge.push({ kind: 'content', text: 'rescued' });
    h.hedge.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'content', text: 'rescued' }]);
    assert.deepEqual(h.winners, ['waterfall']);
    assert.deepEqual(
      h.branchFailures,
      [['cerebras', midRaceError]],
      'a swallowed pre-latch branch failure must still be reported'
    );
  }

  // 4c. Primary ends CLEANLY empty pre-latch: it can never win, so the hedge
  //     arms immediately without waiting for the delay.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    h.primary.end();
    await tick();
    assert.equal(h.hedge.started(), true, 'clean-empty primary must arm the hedge immediately');
    h.hedge.push({ kind: 'content', text: 'hedge fills the silence' });
    h.hedge.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'content', text: 'hedge fills the silence' }]);
  }

  // 4d. With hedgeOnPrimaryFailure, a pre-hedge primary failure starts the
  //     hedge at once instead of surfacing, and the hedge can still win.
  {
    const h = harness({ hedgeOnPrimaryFailure: true });
    const result = h.collect();
    await tick();
    h.primary.fail(new Error('fast model 429'));
    await tick();
    assert.equal(h.hedge.started(), true, 'a declared fallover hedge must start on failure');
    h.hedge.push({ kind: 'content', text: 'spill answers' });
    h.hedge.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'content', text: 'spill answers' }]);
    assert.deepEqual(h.winners, ['waterfall']);
  }

  // 4e. With hedgeOnPrimaryFailure and both branches failing, the primary's
  //     failure still surfaces for the caller's classified fallover.
  {
    const h = harness({ hedgeOnPrimaryFailure: true });
    const result = h.collect();
    await tick();
    const primaryError = new Error('fast model 402');
    h.primary.fail(primaryError);
    await tick();
    h.hedge.fail(new Error('spill 429'));
    const { items, error } = await result;
    assert.deepEqual(items, []);
    assert.equal(error, primaryError);
  }

  // 5. Every branch fails pre-latch: the primary's failure surfaces to the caller.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    const primaryError = new Error('primary boom');
    h.primary.fail(primaryError);
    await tick();
    h.hedge.fail(new Error('hedge boom'));
    const { items, error } = await result;
    assert.deepEqual(items, []);
    assert.equal(error, primaryError, 'primary failure is preferred for fallover classification');
    assert.deepEqual(
      h.branchFailures.map(([name]) => name),
      ['cerebras'],
      'the hedge never started, so only the primary failure is reported'
    );
  }

  // 6. Winner failing AFTER content surfaces the failure (post-content contract).
  {
    const h = harness();
    const result = h.collect();
    h.primary.push({ kind: 'content', text: 'partial' });
    await tick();
    const midStreamError = new Error('mid-stream drop');
    h.primary.fail(midStreamError);
    const { items, error } = await result;
    assert.deepEqual(items, [{ kind: 'content', text: 'partial' }]);
    assert.equal(error, midStreamError);
    assert.deepEqual(
      h.branchFailures,
      [],
      'a post-latch failure is the caller error, not a report'
    );
  }

  // 7. A loser aborted by the race is not reported as a branch failure.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    h.fireHedge();
    await tick();
    h.hedge.push({ kind: 'content', text: 'hedge wins' });
    h.hedge.end();
    await result;
    await tick();
    assert.equal(h.primary.aborted(), true);
    h.primary.fail(new Error('lost chat hedge race'));
    await tick();
    assert.deepEqual(h.branchFailures, [], 'a race-aborted loser is not a branch failure');
  }

  // 8. Branches that finished BEFORE the latch still reach onLoser (archive),
  //    exactly once: a reasoning-only primary that ended cleanly, and a
  //    reasoning-then-failed primary, both before the hedge produced content.
  //    The hedge arms only once the primary is done (no delay fired), so the
  //    primary always finishes before any latch.
  for (const ending of ['end', 'fail'] as const) {
    const h = harness({ hedgeOnPrimaryFailure: true });
    const result = h.collect();
    h.primary.push({ kind: 'reasoning', text: `primary thought (${ending})` });
    if (ending === 'end') h.primary.end();
    else h.primary.fail(new Error('cerebras died after reasoning'));
    h.hedge.push({ kind: 'content', text: 'hedge wins' });
    h.hedge.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'content', text: 'hedge wins' }]);
    assert.deepEqual(h.winners, ['waterfall']);
    await h.drained();
    assert.deepEqual(
      h.losers,
      [['cerebras', [{ kind: 'reasoning', text: `primary thought (${ending})` }]]],
      `a pre-latch ${ending} branch's buffered output is reported once`
    );
  }

  // 9. No winner (every branch fails): nothing is reported as a lost race.
  {
    const h = harness();
    const result = h.collect();
    h.fireHedge();
    h.primary.push({ kind: 'reasoning', text: 'primary thought' });
    h.primary.fail(new Error('primary down'));
    h.hedge.fail(new Error('hedge down'));
    const { error } = await result;
    assert(error instanceof Error);
    await h.drained();
    assert.deepEqual(h.losers, [], 'an all-fail race has no winner and no lost-race reports');
  }
}

void main().then(
  () => undefined,
  (error: unknown) => {
    process.exitCode = 1;
    throw error;
  }
);
