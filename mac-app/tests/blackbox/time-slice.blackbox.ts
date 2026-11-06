/**
 * base/timeSlice blackbox — main-process beachball regression.
 *
 * The Electron main process owns the macOS event loop for every window. The
 * browser-state upload serialized tens-of-MB IndexedDB payloads with one
 * `JSON.stringify`, freezing the app (spinning beachball) for over a second
 * every sync. `jsonToBufferSliced` must emit byte-identical JSON while never
 * holding the event loop for long.
 */

import { describe, expect, it } from 'vitest';
import { SliceClock, jsonToBufferSliced } from '../../main/base/timeSlice';

/** Run `work` while a 5ms interval records the longest event-loop stall. */
async function longestStallDuring(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    last = performance.now();
    await work();
    return Math.max(longest, performance.now() - last);
  } finally {
    clearInterval(probe);
  }
}

describe('base/timeSlice', () => {
  const sliced = async (value: unknown): Promise<string> =>
    (await jsonToBufferSliced(value)).toString('utf8');

  it('jsonToBufferSliced matches JSON.stringify for every JSON value shape', async () => {
    const value = {
      s: 'café "quoted" \n  😀',
      n: [0, -1.5, 1e21, NaN, Infinity],
      b: [true, false],
      nil: null,
      skipped: undefined,
      fn: () => 1,
      arr: [undefined, () => 2, Symbol('x'), { deep: [{ deeper: [] }] }],
      date: new Date(1000),
      custom: { toJSON: () => ({ replaced: true }) },
      nullProto: Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 }),
      empty: {},
      emptyArr: [],
      '': 'empty key',
      dropped: { toJSON: () => undefined },
      keyed: { toJSON: (key: string) => `key=${key}` },
      inArray: [{ toJSON: (key: string) => `idx=${key}` }, { toJSON: () => undefined }],
      boxed: [Object(1) as unknown, Object('s') as unknown, Object(false) as unknown],
    };
    expect(await sliced(value)).toBe(JSON.stringify(value));
    expect(await sliced([1, 'a', null])).toBe(JSON.stringify([1, 'a', null]));
    expect(await sliced('top')).toBe(JSON.stringify('top'));
    const rootToJson = { toJSON: (key: string) => ({ root: key }) };
    expect(await sliced(rootToJson)).toBe(JSON.stringify(rootToJson));
  });

  it('yields to the event loop while serializing a large upload payload', async () => {
    const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20);
    const records = Array.from({ length: 60_000 }, (_, i) => ({
      key: `m${i}`,
      value: { id: i, labels: ['INBOX', `L${i % 7}`], from: `p${i % 31}@x.com`, body: body + i },
    }));
    const payload = {
      origins: [{ origin: 'https://mail.google.com', databases: [{ name: 'd', records }] }],
    };

    let reference = '';
    const syncStall = await longestStallDuring(async () => {
      reference = JSON.stringify(payload);
      await Promise.resolve();
    });
    let bytes = Buffer.alloc(0);
    const slicedStall = await longestStallDuring(async () => {
      bytes = await jsonToBufferSliced(payload, new SliceClock());
    });

    console.log(
      `[timeSlice] longest event-loop stall: JSON.stringify ${Math.round(syncStall)}ms, ` +
        `sliced ${Math.round(slicedStall)}ms (${Math.round(reference.length / 1e6)} MB)`
    );
    expect(bytes.equals(Buffer.from(reference, 'utf8'))).toBe(true);
    expect(syncStall).toBeGreaterThan(150);
    expect(slicedStall).toBeLessThan(150);
    expect(slicedStall * 2).toBeLessThan(syncStall);
  }, 60_000);

  it('checkpoints flat primitive arrays and wide objects too', async () => {
    /** Counts how often serialization hands the event loop back. */
    class CountingClock extends SliceClock {
      yields = 0;
      override async yieldToEventLoop(): Promise<void> {
        this.yields += 1;
        await super.yieldToEventLoop();
      }
    }
    const flat = Array.from({ length: 600_000 }, (_, i) => (i % 2 === 0 ? i : `s${i}`));
    const wide: Record<string, number> = {};
    for (let i = 0; i < 150_000; i++) wide[`k${i}`] = i;
    for (const payload of [flat, wide]) {
      const clock = new CountingClock(1);
      let bytes = Buffer.alloc(0);
      const stall = await longestStallDuring(async () => {
        bytes = await jsonToBufferSliced(payload, clock);
      });
      expect(bytes.toString('utf8')).toBe(JSON.stringify(payload));
      // Primitive-only containers must still be sliced, not one long task.
      expect(clock.yields).toBeGreaterThan(5);
      expect(stall).toBeLessThan(150);
    }
  }, 60_000);

  it('SliceClock only yields once its budget is used', async () => {
    const clock = new SliceClock(1_000);
    expect(clock.shouldYield()).toBe(false);
    await clock.checkpoint();
    const spent = new SliceClock(0);
    expect(spent.shouldYield()).toBe(true);
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    await spent.checkpoint();
    expect(ticked).toBe(true);
  });
});
