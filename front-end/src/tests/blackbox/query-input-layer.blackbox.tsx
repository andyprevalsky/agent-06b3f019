import {
  RoseAppsContext,
  type RoseAppsValue,
} from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryInputLayer } from '@/features/terminal-component-group/components/query-input/QueryInputLayer';

const originalResizeObserver = globalThis.ResizeObserver;

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
    return {
      x: 40,
      y: top,
      left: 40,
      top,
      right: 440,
      bottom: top + 80,
      width: 400,
      height: 80,
      toJSON() {},
    };
  });
  const { unmount } = render(
    <div data-testid="gate-container">
      <QueryInputLayer enabled>
        <input aria-label="Message" />
      </QueryInputLayer>
    </div>,
  );
  const layer = screen.getByTestId('query-input-layer');
  expect(layer.parentElement).toBe(document.body);
  expect(layer).toHaveStyle({ left: '40px', top: '100px', width: '400px' });
  expect(observed).toContain(screen.getByTestId('gate-container'));
  const input = screen.getByRole('textbox', { name: 'Message' });
  input.focus();
  top = 200;
  act(() => notify());
  expect(layer).toHaveStyle({ top: '200px' });
  expect(document.activeElement).toBe(input);
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
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
