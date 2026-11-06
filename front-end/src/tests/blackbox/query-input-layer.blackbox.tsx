import {
  RoseAppsContext,
  type RoseAppsValue,
} from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryInputLayer } from '@/features/terminal-component-group/components/query-input/QueryInputLayer';

const originalResizeObserver = globalThis.ResizeObserver;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON() {},
  };
}

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.restoreAllMocks();
});

it('keeps the portaled composer aligned when a parent gate moves its unchanged-size anchor', () => {
  let top = 100;
  let notify: () => void = () => {};
  const observed: Element[] = [];
  const disconnect = vi.fn();
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      notify = () => callback([], this);
    }
    observe(element: Element) {
      observed.push(element);
    }
    unobserve() {}
    disconnect = disconnect;
  };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    // The fixed frame the composer is positioned in covers the 1280x800 viewport.
    if (this.classList.contains('inset-0')) return rect(0, 0, 1280, 800);
    return rect(40, top, 400, 80);
  });
  // The layer is pinned by its bottom edge: bottom = viewport bottom - anchor bottom.
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
  const { unmount } = render(
    <div data-testid="gate-container">
      <QueryInputLayer enabled>
        <input aria-label="Message" />
      </QueryInputLayer>
    </div>,
  );
  const layer = screen.getByTestId('query-input-layer');
  expect(screen.getByTestId('gate-container')).not.toContainElement(layer);
  // Anchor bottom = 100 + 80 = 180 -> 800 - 180.
  expect(layer).toHaveStyle({ left: '40px', bottom: '620px', width: '400px' });
  expect(layer.style.top).toBe('');
  expect(observed).toContain(screen.getByTestId('gate-container'));
  const input = screen.getByRole('textbox', { name: 'Message' });
  input.focus();
  top = 200;
  act(() => notify());
  // The gate moved the anchor down 100px: its bottom is now 280 -> 800 - 280.
  expect(layer).toHaveStyle({ bottom: '520px' });
  expect(document.activeElement).toBe(input);
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('keeps the composer on its slot while the iOS keyboard pans the visible viewport', () => {
  // iPhone PWA with the keyboard open (user screenshot 2026-11-04): the shell
  // follows the visual viewport (577pt tall, panned 335pt down the 956pt
  // layout viewport) and client rects are measured from that visible region,
  // but fixed boxes still resolve against the unpanned layout viewport. A
  // composer placed at clientHeight - anchor.bottom landed 335pt above its
  // slot, over the top of the chat.
  const LAYOUT_HEIGHT = 956;
  const PAN = 335;
  const slot = rect(8, 391, 424, 178);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(LAYOUT_HEIGHT);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset.testid === 'query-layer-anchor') return slot;
    // A fixed inset-0 box is the layout viewport, seen from the panned region.
    if (this.classList.contains('fixed') && this.classList.contains('inset-0')) {
      return rect(0, -PAN, 440, LAYOUT_HEIGHT);
    }
    return rect(0, 0, 424, 178);
  });
  render(
    <QueryInputLayer enabled>
      <input aria-label="Message" />
    </QueryInputLayer>,
  );
  const layer = screen.getByTestId('query-input-layer');
  // `bottom` offsets the composer from the layout viewport's bottom edge —
  // directly when the layer is fixed, or via a fixed inset-0 frame.
  const positioned = layer.classList.contains('fixed') ? layer : layer.parentElement!;
  expect(positioned).toHaveClass('fixed');
  if (positioned !== layer) expect(positioned).toHaveClass('inset-0');
  const onScreen = {
    left: parseFloat(layer.style.left),
    bottom: LAYOUT_HEIGHT - parseFloat(layer.style.bottom) - PAN,
  };
  expect(onScreen).toEqual({ left: slot.left, bottom: slot.bottom });
});

it.each(['other-owner', 'other-task', 'root'])(
  'hides the floating composer rather than moving an unrelated channel: %s',
  (scenario) => {
    const slot = document.createElement('div');
    slot.dataset.agentId = scenario === 'other-owner' ? 'sibling' : 'owner';
    slot.dataset.taskId = scenario === 'other-task' ? 'stale-task' : 'task';
    document.body.append(slot);
    const value = {
      openApp: 'browser',
      browserMode: 'remote',
      browserComposerSlot: slot,
      selectedAgentId: 'owner',
      browserTabAgentId: scenario === 'root' ? null : 'owner',
      browserTabTaskId: scenario === 'root' ? null : 'task',
      tabs: [{ agentId: 'owner', taskId: 'task', live: true }],
    } as unknown as RoseAppsValue;
    try {
      render(
        <RoseAppsContext.Provider value={value}>
          <QueryInputLayer enabled>
            <input aria-label="Message" />
          </QueryInputLayer>
        </RoseAppsContext.Provider>,
      );
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByTestId('query-input-layer')).toBeNull();
      expect(slot.childElementCount).toBe(0);
    } finally {
      slot.remove();
    }
  },
);

it('fences an old owner slot during A to B selection, then restores the normal composer on close', () => {
  const a = document.createElement('div'),
    b = document.createElement('div');
  for (const [slot, owner] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    slot.dataset.agentId = owner;
    slot.dataset.taskId = owner;
    document.body.append(slot);
  }
  const value = (selected: string, target: HTMLElement, open = true) =>
    ({
      openApp: open ? 'browser' : null,
      browserMode: 'remote',
      browserComposerSlot: target,
      selectedAgentId: selected,
      browserTabAgentId: selected,
      browserTabTaskId: selected,
      tabs: [{ agentId: selected, taskId: selected, live: true }],
    }) as unknown as RoseAppsValue;
  const tree = (state: RoseAppsValue) => (
    <RoseAppsContext.Provider value={state}>
      <QueryInputLayer enabled>
        <input aria-label="Message" value="saved draft" readOnly />
      </QueryInputLayer>
    </RoseAppsContext.Provider>
  );
  const ui = render(tree(value('a', a)));
  expect(a).toContainElement(screen.getByRole('textbox'));
  ui.rerender(tree(value('b', a)));
  expect(screen.queryByRole('textbox')).toBeNull();
  ui.rerender(tree(value('b', b)));
  expect(a.childElementCount).toBe(0);
  expect(b).toContainElement(screen.getByRole('textbox'));
  ui.rerender(tree(value('b', b, false)));
  expect(b.childElementCount).toBe(0);
  expect(screen.getByTestId('query-input-layer')).toContainElement(screen.getByRole('textbox'));
  expect(screen.getByRole('textbox')).toHaveValue('saved draft');
  ui.unmount();
  a.remove();
  b.remove();
});
