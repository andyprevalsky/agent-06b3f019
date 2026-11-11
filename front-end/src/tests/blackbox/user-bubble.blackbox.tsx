/** User-bubble collapse behavior, exercised by the normal frontend blackbox gate. */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UserBubble } from '@/features/terminal-component-group/components/message-bubble/UserBubble';
import { baseMessage } from './message-bubble.fixtures';

describe('user message collapse', () => {
  it('shows short messages without a toggle', () => {
    render(<UserBubble message={baseMessage({ role: 'USER', text: 'hi rose' })} />);
    expect(screen.getByText('hi rose')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
  it('collapses overflowing USER text, toggles it, and remeasures on resize', async () => {
    let height = 480;
    let resize: () => void = () => {};
    const disconnect = vi.fn();
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe() {}
      disconnect = disconnect;
      unobserve() {}
    };
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function () {
        return height;
      });
    try {
      const text = 'A long message with all its original content. '.repeat(60);
      const view = render(<UserBubble message={baseMessage({ role: 'USER', text })} />);
      const content = screen.getByTestId('user-message-text');
      const preview = content.parentElement!;
      const toggle = screen.getByRole('button', { name: 'Show more' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', preview.id);
      expect(preview).toHaveStyle({ maxHeight: '240px', overflow: 'hidden' });
      expect(content.textContent).toBe(text);
      await userEvent.click(toggle);
      expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(preview.style.maxHeight).toBe('');
      await userEvent.click(toggle);
      expect(preview).toHaveStyle({ maxHeight: '240px' });
      height = 100;
      act(() => resize());
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
      height = 480;
      act(() => resize());
      expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      scrollHeight.mockRestore();
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });
});
