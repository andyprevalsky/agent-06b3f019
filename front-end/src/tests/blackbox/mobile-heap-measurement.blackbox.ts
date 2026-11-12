/**
 * Blackbox: the semantic mobile stress spec's post-GC heap probe
 * (tests-e2e/mobile-performance.ts retainedHeapBytes) reports the retained heap
 * of a quiescent page, not whatever one collection at one instant left behind.
 *
 * The sequences are real Chromium reads from mobile-long-trajectory on main
 * (RCA 2026-11-12-mobile-heap-probe-sampled-in-flight-work-not-retained-heap):
 *   - one HeapProfiler.collectGarbage left 0.7-3.7 MB that the next pass freed;
 *   - a sample taken right after a navigation caught megabytes of in-flight
 *     work that survived every collection and drained within seconds of idle.
 * Either made the spec's fixed bound pass or fail by timing alone (gate:
 * 57.3 MB vs 54.9 MB, back to 45.2 MB one round later with DOM nodes unchanged).
 */
import type { CDPSession } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { retainedHeapBytes } from '../../../tests-e2e/mobile-performance';

const MB = 1e6;

/**
 * A page whose heap follows `steps`: steps[k] lists the reads after successive
 * collections during the k-th idle interval (k = 0 is the sampling instant).
 */
function heapPage(steps: number[][]) {
  const calls: string[] = [];
  let step = 0;
  let pass = 0;
  const send = async (method: string) => {
    calls.push(method);
    if (method === 'HeapProfiler.collectGarbage') {
      pass++;
      return {};
    }
    if (method === 'Runtime.getHeapUsage') {
      const reads = steps[Math.min(step, steps.length - 1)];
      if (pass === 0) throw new Error('heap read without a collection');
      const usedSize = reads[Math.min(pass, reads.length) - 1];
      return { usedSize, totalSize: 2 * usedSize };
    }
    throw new Error(`unexpected CDP method ${method}`);
  };
  const idle = async () => {
    calls.push('idle');
    step++;
    pass = 0;
  };
  return { session: { send } as unknown as Pick<CDPSession, 'send'>, idle, calls };
}

const mb = (...values: number[]) => values.map((value) => value * MB);

describe('post-GC heap probe', () => {
  it('collects past the floating garbage one collection leaves behind', async () => {
    // main warmed baseline: 38.16 MB after one collection, 34.49 MB once settled.
    const page = heapPage([mb(38.16, 34.49, 34.49), mb(34.49, 34.49)]);
    expect(await retainedHeapBytes(page.session, page.idle)).toBe(34.49 * MB);
  });

  it('waits out in-flight work that every collection keeps alive', async () => {
    // main warmed sample: 38.2 MB settled at the instant, 35.3 MB after one idle second.
    const page = heapPage([mb(38.2, 38.2), mb(35.3, 35.3), mb(35.3, 35.3)]);
    expect(await retainedHeapBytes(page.session, page.idle)).toBe(35.3 * MB);
  });

  it('does not stop on a spike that is still draining', async () => {
    // Round spike that survived V8's heap-profiler collection: 43.31 -> 42.41 MB,
    // then the 38.3 MB steady state.
    const page = heapPage([mb(43.31, 43.31), mb(42.41, 42.41), mb(38.3, 38.3), mb(38.3, 38.3)]);
    expect(await retainedHeapBytes(page.session, page.idle)).toBe(38.3 * MB);
  });

  it('still reports a genuinely retained heap in full', async () => {
    // Reachable memory survives every collection and every idle interval.
    const page = heapPage([mb(57.3, 57.3), mb(57.3, 57.3)]);
    expect(await retainedHeapBytes(page.session, page.idle)).toBe(57.3 * MB);
    expect(page.calls.filter((call) => call === 'idle')).toHaveLength(1);
  });

  it('fails loudly when the idle heap keeps growing', async () => {
    const page = heapPage(Array.from({ length: 20 }, (_, step) => mb(40 + step, 40 + step)));
    await expect(retainedHeapBytes(page.session, page.idle)).rejects.toThrow(/still changing/);
  });

  it('fails loudly when collections never settle', async () => {
    const page = heapPage([Array.from({ length: 20 }, (_, pass) => (60 - pass) * MB)]);
    await expect(retainedHeapBytes(page.session, page.idle)).rejects.toThrow(/still shrinking/);
  });
});
