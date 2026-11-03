import { StrictMode } from 'react';
import { createRequire } from 'node:module';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const loadCommonJs = createRequire(import.meta.url);
const cjs: typeof ScrollArea = loadCommonJs('@radix-ui/react-scroll-area');
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ['ESM', ScrollArea],
  ['CJS', cjs],
] as const)(
  '%s releases scrolling animation work when unmounted before scroll-end debounce',
  (_, Primitive) => {
    vi.useFakeTimers();
    let nextId = 0;
    const pending = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pending.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      pending.delete(id);
    });
    const rendered = render(
      <StrictMode>
        <Primitive.Root type="always">
          <Primitive.Viewport data-testid="viewport">
            <div>All trajectory history remains mounted until navigation</div>
          </Primitive.Viewport>
          <Primitive.Scrollbar orientation="vertical" forceMount>
            <Primitive.Thumb forceMount />
          </Primitive.Scrollbar>
        </Primitive.Root>
      </StrictMode>,
    );
    const viewport = rendered.getByTestId('viewport');
    fireEvent.scroll(viewport);
    expect(pending.size).toBeGreaterThan(0);
    act(() => {
      const batch = [...pending.values()];
      pending.clear();
      batch.forEach((callback) => callback(16));
    });
    expect(pending.size).toBeGreaterThan(0);
    rendered.unmount();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(pending.size).toBe(0);
  },
);
