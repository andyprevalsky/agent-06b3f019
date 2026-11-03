/** Exercise the installed SDK cleanup and preserve real rage-click event payloads. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import {
  Observable,
  DEFAULT_RAGE_CLICK_THRESHOLD as threshold,
  DEFAULT_RAGE_CLICK_WINDOW_MS as windowMs,
} from '@amplitude/analytics-core';
import { transformAmplitudeRageClick } from '../../../scripts/patch-amplitude-lifecycle.mjs';

const testRequire = createRequire(import.meta.url);
const packageRoot = path.dirname(
  testRequire.resolve('@amplitude/plugin-autocapture-browser/package.json'),
);
const sdkRequire = createRequire(path.join(packageRoot, 'lib/cjs/autocapture/track-rage-click.js'));
type Click = {
  type: string;
  timestamp: number;
  event: { pageX: number; pageY: number; target: HTMLElement };
  closestTrackedAncestor: HTMLElement;
  targetElementProperties: Record<string, string>;
};
type Tracked = { unsubscribe: () => void; __peek: () => { window: Click[]; pending: unknown } };
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function load(format: string) {
  let source = readFileSync(
    path.join(packageRoot, 'lib', format, 'autocapture/track-rage-click.js'),
    'utf8',
  );
  // Read-only instrumentation of the actual SDK closure; no algorithm replacement.
  source = source.replace(
    'return {\n        unsubscribe: function () {',
    'return {\n        __peek: function () { return { window: clickWindow, pending: pendingRageClick }; },\n        unsubscribe: function () {',
  );
  if (format === 'esm')
    source = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
  const module = {
    exports: {} as { trackRageClicks: (options: Record<string, unknown>) => Tracked },
  };
  new Function('require', 'exports', 'module', source)(sdkRequire, module.exports, module);
  return module.exports.trackRageClicks;
}
function harness(format: string) {
  vi.useFakeTimers();
  let emit!: (click: Click) => void, select!: () => void;
  const clicks = new Observable<Click>((observer) => {
    emit = (click) => observer.next(click);
  });
  const selection = new Observable<void>((observer) => {
    select = () => observer.next();
  });
  const track = vi.fn(),
    target = document.createElement('button');
  const sub = load(format)({
    amplitude: { track },
    allObservables: {
      clickObservable: clicks,
      pointerDownObservable: clicks,
      selectionObservable: selection,
    },
    shouldTrackRageClick: () => true,
  });
  return {
    sub,
    track,
    select: async () => {
      select();
      await flush();
    },
    click: async (index = 0) => {
      emit({
        type: 'click',
        timestamp: Date.now(),
        event: { pageX: 10 + index, pageY: 20 + index, target },
        closestTrackedAncestor: target,
        targetElementProperties: { tag: 'BUTTON' },
      });
      await flush();
    },
  };
}
afterEach(() => vi.useRealTimers());
for (const format of ['esm', 'cjs'])
  describe('Amplitude rage lifecycle ' + format, () => {
    it('expires a single raw click at the existing matching deadline', async () => {
      const h = harness(format);
      try {
        await h.click();
        await vi.advanceTimersByTimeAsync(windowMs - 1);
        expect(h.sub.__peek().window).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.sub.__peek().window).toHaveLength(0);
        expect(h.track).not.toHaveBeenCalled();
      } finally {
        h.sub.unsubscribe();
      }
    });
    it('preserves three full rage payloads, event times and coordinates', async () => {
      const h = harness(format);
      try {
        for (let round = 0; round < 3; round++) {
          const start = Date.now();
          for (let i = 0; i < threshold; i++) {
            await h.click(i);
            if (i < threshold - 1) await vi.advanceTimersByTimeAsync(25);
          }
          await vi.advanceTimersByTimeAsync(windowMs);
          expect(h.track).toHaveBeenCalledTimes(round + 1);
          const [event, payload, options] = h.track.mock.calls[round];
          expect(event).toBe(sdkRequire('../constants').AMPLITUDE_ELEMENT_RAGE_CLICKED_EVENT);
          expect(options.time).toBe(start);
          expect(payload['[Amplitude] Duration']).toBe(25 * (threshold - 1));
          expect(payload['[Amplitude] Begin Time']).toBe(new Date(start).toISOString());
          expect(payload['[Amplitude] End Time']).toBe(
            new Date(start + 25 * (threshold - 1)).toISOString(),
          );
          expect(payload['[Amplitude] Clicks']).toEqual(
            Array.from({ length: threshold }, (_, i) => ({
              X: 10 + i,
              Y: 20 + i,
              Time: start + 25 * i,
            })),
          );
          expect(h.sub.__peek().window).toHaveLength(0);
        }
      } finally {
        h.sub.unsubscribe();
      }
    });
    it('preserves selection reset and clears pending work on unsubscribe', async () => {
      const h = harness(format);
      await h.click();
      await h.select();
      expect(h.sub.__peek().window).toHaveLength(0);
      for (let i = 0; i < threshold; i++) await h.click(i);
      h.sub.unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.sub.__peek().window).toHaveLength(0);
      expect(h.sub.__peek().pending).toBeNull();
      await vi.advanceTimersByTimeAsync(windowMs * 2);
      await h.click();
      expect(h.track).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

it('verifies complete idempotent SDK patches and rejects partial or duplicate repairs', () => {
  const source = readFileSync(
    path.join(packageRoot, 'lib/cjs/autocapture/track-rage-click.js'),
    'utf8',
  );
  expect(transformAmplitudeRageClick(source)).toBe(source);
  expect(() =>
    transformAmplitudeRageClick(source.replace('rageClickDisposed = true;', '')),
  ).toThrow();
  expect(() => transformAmplitudeRageClick(source + '\n/* rose-rage-click-lifecycle */')).toThrow();
});
