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
