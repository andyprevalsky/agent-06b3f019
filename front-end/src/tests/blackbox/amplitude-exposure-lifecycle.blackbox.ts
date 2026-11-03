/** Exercise exposure ownership against actual installed SDK bytes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { Observable } from '@amplitude/analytics-core';

const localRequire = createRequire(import.meta.url);
const packageRoot = path.dirname(
  localRequire.resolve('@amplitude/plugin-autocapture-browser/package.json'),
);
type Entry = { target: HTMLElement; isIntersecting: boolean; intersectionRatio: number };
type Tracker = {
  unsubscribe: () => void;
  reset: () => void;
  __peek: () => { pending: Map<HTMLElement, unknown>; completed: WeakMap<HTMLElement, boolean> };
};
function load(format: string) {
  const file = path.join(packageRoot, 'lib', format, 'autocapture/track-exposure.js');
  let source = readFileSync(file, 'utf8');
  source = source.replace(
    'return {\n        unsubscribe: function () {',
    'return {\n        __peek: function () { return { pending: exposureTimerMap, completed: exposureMap }; },\n        unsubscribe: function () {',
  );
  if (format === 'esm')
    source = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
  const module = {
    exports: {} as { trackExposure: (options: Record<string, unknown>) => Tracker },
  };
  new Function('require', 'exports', 'module', source)(
    createRequire(
      path.join(packageRoot, 'lib/cjs', path.relative(path.join(packageRoot, 'lib', format), file)),
    ),
    module.exports,
    module,
  );
  return module.exports.trackExposure;
}
function harness(format: string) {
  vi.useFakeTimers();
  let emit!: (entry: Entry) => void;
  const exposureObservable = new Observable<Entry>((observer) => {
    emit = (entry) => observer.next(entry);
  });
  const scrollObservable = new Observable<void>(() => undefined);
  const target = document.createElement('button');
  document.body.append(target);
  target.getBoundingClientRect = () => ({
    top: 10,
    bottom: 30,
    left: 10,
    right: 30,
    width: 20,
    height: 20,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  });
  const onExposure = vi.fn();
  const tracker = load(format)({
    allObservables: { exposureObservable, scrollObservable },
    onExposure,
    dataExtractor: { getElementPath: () => 'button[data-test="exposed"]' },
    exposureDuration: 1000,
  });
  return {
    tracker,
    onExposure,
    target,
    emit: (visible: boolean) =>
      emit({ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }),
  };
}
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});
for (const format of ['esm', 'cjs'])
  describe('Amplitude exposure lifecycle ' + format, () => {
    it('keeps the matching duration and duplicate history without retaining completed DOM keys', async () => {
      const h = harness(format);
      try {
        h.emit(true);
        await vi.advanceTimersByTimeAsync(999);
        expect(h.onExposure).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.onExposure).toHaveBeenCalledExactlyOnceWith('button[data-test="exposed"]');
        h.emit(false);
        h.emit(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onExposure).toHaveBeenCalledTimes(1);
        expect(h.tracker.__peek().pending.size).toBe(0);
        expect(h.tracker.__peek().completed).toBeInstanceOf(WeakMap);
      } finally {
        h.tracker.unsubscribe();
      }
    });
    it('releases cancelled pending keys immediately without emitting an exposure', async () => {
      const h = harness(format);
      try {
        h.emit(true);
        await vi.advanceTimersByTimeAsync(500);
        h.emit(false);
        expect(h.tracker.__peek().pending.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onExposure).not.toHaveBeenCalled();
      } finally {
        h.tracker.unsubscribe();
      }
    });
  });

function loadObservable(format: string) {
  const file = path.join(packageRoot, 'lib', format, 'observables.js');
  let source = readFileSync(file, 'utf8');
  if (format === 'esm')
    source = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
  const module = {
    exports: {} as {
      createExposureObservable: (mutations: unknown, selectors: string[]) => Observable<Entry>;
    },
  };
  new Function('require', 'exports', 'module', source)(
    createRequire(
      path.join(packageRoot, 'lib/cjs', path.relative(path.join(packageRoot, 'lib', format), file)),
    ),
    module.exports,
    module,
  );
  return module.exports.createExposureObservable;
}
function observerHarness(format: string) {
  vi.useFakeTimers();
  let emitMutation!: (records: MutationRecord[]) => void;
  const mutationObservable = new Observable((observer) => {
    emitMutation = (event) => observer.next({ event });
  });
  const instances: MockIntersectionObserver[] = [];
  class MockIntersectionObserver {
    observed = new Set<Element>();
    constructor(readonly callback: (entries: Entry[]) => void) {
      instances.push(this);
    }
    observe(target: Element) {
      this.observed.add(target);
    }
    unobserve(target: Element) {
      this.observed.delete(target);
    }
    disconnect() {
      this.observed.clear();
    }
    emit(target: HTMLElement, visible = true) {
      this.callback([{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
    }
  }
  const originalObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
  const parent = document.createElement('section');
  const target = document.createElement('button');
  target.getBoundingClientRect = () => ({
    top: 10,
    bottom: 30,
    left: 10,
    right: 30,
    width: 20,
    height: 20,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  });
  parent.append(target);
  document.body.append(parent);
  const nativeMutations = new MutationObserver(() => undefined);
  nativeMutations.observe(document.body, { childList: true, subtree: true });
  const exposureObservable = loadObservable(format)(mutationObservable, ['button']);
  const onExposure = vi.fn();
  const tracker = load(format)({
    allObservables: { exposureObservable, scrollObservable: new Observable(() => undefined) },
    onExposure,
    dataExtractor: { getElementPath: () => 'button[data-test="exposed"]' },
    exposureDuration: 1000,
  });
  return {
    parent,
    target,
    tracker,
    onExposure,
    io: instances[0],
    mutate: () => emitMutation(nativeMutations.takeRecords()),
    close: () => {
      tracker.unsubscribe();
      nativeMutations.disconnect();
      globalThis.IntersectionObserver = originalObserver;
    },
  };
}
for (const format of ['esm', 'cjs'])
  describe('Amplitude exposure DOM owner ' + format, () => {
    it('retires a removed pending subtree immediately using the actual mutation stream', async () => {
      const h = observerHarness(format);
      try {
        h.io.emit(h.target);
        await vi.advanceTimersByTimeAsync(100);
        h.parent.remove();
        h.mutate();
        expect(h.io.observed.has(h.target)).toBe(false);
        expect(h.tracker.__peek().pending.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        h.io.emit(h.target);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.onExposure).not.toHaveBeenCalled();
        expect(h.tracker.__peek().pending.size).toBe(0);
      } finally {
        h.close();
      }
    });
    it('preserves connected moves, exact dwell, completed reentry dedup and reset', async () => {
      const h = observerHarness(format);
      try {
        h.io.emit(h.target);
        h.io.emit(h.target);
        await vi.advanceTimersByTimeAsync(500);
        document.body.append(h.target);
        h.mutate();
        expect(h.io.observed.has(h.target)).toBe(true);
        await vi.advanceTimersByTimeAsync(499);
        expect(h.onExposure).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.onExposure).toHaveBeenCalledExactlyOnceWith('button[data-test="exposed"]');
        h.target.remove();
        h.mutate();
        document.body.append(h.target);
        h.mutate();
        h.io.emit(h.target);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onExposure).toHaveBeenCalledTimes(1);
        h.tracker.reset();
        h.io.emit(h.target);
        await vi.advanceTimersByTimeAsync(999);
        expect(h.onExposure).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.onExposure).toHaveBeenCalledTimes(2);
      } finally {
        h.close();
      }
    });
    it('cancels all pending work and disconnects observation on unsubscribe', async () => {
      const h = observerHarness(format);
      try {
        h.io.emit(h.target);
        h.tracker.unsubscribe();
        expect(h.io.observed.size).toBe(0);
        expect(h.tracker.__peek().pending.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        h.io.emit(h.target);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.onExposure).not.toHaveBeenCalled();
      } finally {
        h.close();
      }
    });
  });

for (const format of ['esm', 'cjs'])
  it('releases repeated completed and aborted DOM owners ' + format, async () => {
    const h = observerHarness(format);
    try {
      for (let round = 0; round < 30; round++) {
        const target = document.createElement('button');
        target.getBoundingClientRect = h.target.getBoundingClientRect;
        document.body.append(target);
        h.mutate();
        h.io.emit(target);
        await vi.advanceTimersByTimeAsync(round % 2 ? 1000 : 100);
        target.remove();
        h.mutate();
        expect(h.tracker.__peek().pending.size).toBe(0);
        expect(h.io.observed.has(target)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(h.onExposure).toHaveBeenCalledTimes(15);
      expect(h.tracker.__peek().completed).toBeInstanceOf(WeakMap);
    } finally {
      h.close();
    }
  });

it('validates every exposure block, idempotence and unsupported/partial shapes', async () => {
  const { transformAmplitudeExposure, transformAmplitudeExposureObservable } =
    await import('../../../scripts/patch-amplitude-lifecycle.mjs');
  const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  for (const format of ['esm', 'cjs']) {
    const before = readFileSync(
      path.join(packageRoot, 'lib', format, 'autocapture/track-exposure.js'),
      'utf8',
    );
    const after = transformAmplitudeExposure(before, version);
    expect(transformAmplitudeExposure(after, version)).toBe(after);
    expect(() =>
      transformAmplitudeExposure(after.replace('exposureTimerMap.delete(element);', ''), version),
    ).toThrow();
    expect(() =>
      transformAmplitudeExposure(after + '\n/* rose-exposure-lifecycle */', version),
    ).toThrow();
    expect(() => transformAmplitudeExposure(before, '9.9.9')).toThrow();
    const observable = readFileSync(
      path.join(packageRoot, 'lib', format, 'observables.js'),
      'utf8',
    );
    const repaired = transformAmplitudeExposureObservable(observable, version);
    expect(transformAmplitudeExposureObservable(repaired, version)).toBe(repaired);
    expect(() =>
      transformAmplitudeExposureObservable(
        repaired.replace('intersectionObserver.unobserve(node);', ''),
        version,
      ),
    ).toThrow();
    expect(() =>
      transformAmplitudeExposureObservable(
        repaired + '\n/* rose-exposure-removal-lifecycle */',
        version,
      ),
    ).toThrow();
  }
});

for (const format of ['esm', 'cjs'])
  it('retires a deeply nested removed tree without overflowing the SDK callback ' + format, () => {
    const h = observerHarness(format);
    try {
      // Isolate the SDK traversal from jsdom's own recursive tree bookkeeping.
      let child: Node = h.target;
      for (let index = 0; index < 12000; index++) {
        const parent = document.createElement('div');
        Object.defineProperty(parent, 'childNodes', { value: [child] });
        child = parent;
      }
      Object.defineProperty(h.parent, 'childNodes', { value: [child] });
      h.io.emit(h.target);
      h.parent.remove();
      h.mutate();
      expect(h.io.observed.has(h.target)).toBe(false);
      expect(h.tracker.__peek().pending.size).toBe(0);
    } finally {
      h.close();
    }
  });
