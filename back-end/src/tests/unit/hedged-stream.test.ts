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

function harness(): {
  primary: ReturnType<typeof makeBranch>;
  hedge: ReturnType<typeof makeBranch>;
  fireHedge: () => void;
  winners: string[];
  collect: () => Promise<{ items: Chunk[]; error: unknown }>;
} {
  const primary = makeBranch();
  const hedge = makeBranch();
  let fire: () => void = () => undefined;
  const winners: string[] = [];
  const stream = hedgeStreams<Chunk>({
    primary: { name: 'cerebras', produce: primary.produce },
    hedge: { name: 'waterfall', produce: hedge.produce },
    hedgeAfter: () =>
      new Promise<void>((resolve) => {
        fire = resolve;
      }),
    isContent,
    onWinner: (name) => winners.push(name),
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
  return { primary, hedge, fireHedge: () => fire(), winners, collect };
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

  // 4. Primary fails pre-latch: hedge is armed immediately (no delay) and wins.
  {
    const h = harness();
    const result = h.collect();
    await tick();
    h.primary.fail(new Error('cerebras stall'));
    await tick();
    assert.equal(h.hedge.started(), true, 'primary failure must arm the hedge immediately');
    h.hedge.push({ kind: 'content', text: 'rescued' });
    h.hedge.end();
    const { items, error } = await result;
    assert.equal(error, null);
    assert.deepEqual(items, [{ kind: 'content', text: 'rescued' }]);
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
  }
}

void main().then(
  () => undefined,
  (error: unknown) => {
    process.exitCode = 1;
    throw error;
  }
);
