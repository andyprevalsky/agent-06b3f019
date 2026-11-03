/** Long sessions retain mounted task snapshots plus a bounded recent history. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  clearBrowserSessionBindings,
  getBrowserSessionBinding,
  publishBrowserSessionBinding,
  subscribeBrowserSessionBinding,
  type BrowserSessionBinding,
} from '@/lib/browserSessionBindings';
import {
  clearCodeResources,
  getCodeResources,
  publishCodeResources,
  useCodeResources,
  type CodeResourceSample,
} from '@/lib/codeResources';

const binding = (taskId: string, asOf = '2026-11-02T12:00:00.000Z'): BrowserSessionBinding => ({
  taskId,
  asOf: Date.parse(asOf),
  sessionId: `session-${asOf}`,
  debugUrl: 'https://browser.example/live',
  live: true,
  status: 'ACTIVE',
});
const sample = (sampled_at = '2026-11-02T12:00:00.000Z'): CodeResourceSample => ({
  sampled_at,
  cpu: { used_pct: 20, cores: 2 },
  memory: null,
  disk: null,
});

afterEach(() => {
  clearBrowserSessionBindings();
  clearCodeResources();
});

describe('task resource retention', () => {
  it('bounds unused browser bindings after a 10,000-task trajectory', () => {
    for (let index = 0; index < 10_000; index += 1)
      publishBrowserSessionBinding(binding(`task-${index}`));
    const retained = Array.from({ length: 10_000 }, (_, index) =>
      getBrowserSessionBinding(`task-${index}`),
    ).filter(Boolean);
    expect(retained.length).toBeLessThanOrEqual(128);
    expect(getBrowserSessionBinding('task-9999')).toEqual(binding('task-9999'));
  });

  it('pins mounted browser bindings, rejects older asOf, then releases unsubscribed history', () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeBrowserSessionBinding('mounted', onChange);
    const latest = binding('mounted', '2026-11-02T13:00:00.000Z');
    publishBrowserSessionBinding(latest);
    for (let index = 0; index < 1000; index += 1)
      publishBrowserSessionBinding(binding(`task-${index}`));
    publishBrowserSessionBinding(binding('mounted'));
    expect(getBrowserSessionBinding('mounted')).toEqual(latest);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(getBrowserSessionBinding('mounted')).toEqual(latest);
    for (let index = 1000; index < 2000; index += 1)
      publishBrowserSessionBinding(binding(`task-${index}`));
    expect(getBrowserSessionBinding('mounted')).toBeNull();
  });

  it('bounds unused code samples after a 10,000-task trajectory', () => {
    for (let index = 0; index < 10_000; index += 1) publishCodeResources(`task-${index}`, sample());
    const retained = Array.from({ length: 10_000 }, (_, index) =>
      getCodeResources(`task-${index}`),
    ).filter(Boolean);
    expect(retained.length).toBeLessThanOrEqual(128);
    expect(getCodeResources('task-9999')).toEqual(sample());
  });

  it('pins mounted code samples and keeps newest sampled_at across pressure and repeated switches', () => {
    const latest = sample('2026-11-02T13:00:00.000Z');
    const { result, rerender, unmount } = renderHook(({ taskId }) => useCodeResources(taskId), {
      initialProps: { taskId: 'mounted' },
    });
    act(() => {
      publishCodeResources('mounted', latest);
    });
    act(() => {
      for (let index = 0; index < 1000; index += 1) publishCodeResources(`task-${index}`, sample());
      publishCodeResources('mounted', sample());
    });
    expect(result.current).toBe(latest);
    for (let index = 0; index < 200; index += 1) {
      const taskId = `switch-${index}`;
      rerender({ taskId });
      act(() => {
        publishCodeResources(taskId, latest);
      });
      expect(result.current).toBe(latest);
    }
    expect(getCodeResources('mounted')).toBeNull();
    unmount();
    for (let index = 0; index < 200; index += 1) publishCodeResources(`after-${index}`, sample());
    expect(getCodeResources('switch-199')).toBeNull();
  });
});
